import type { APIRoute } from 'astro';
import { readEnv, readFlag, readList } from '@/lib/env';
import { sendInquiryMail } from '@/lib/mailer';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  buildSubjectTags,
  findHoneypotHits,
  matchBlacklist,
} from '@/lib/spam-filter';
import { verifyTurnstile } from '@/lib/turnstile';

/**
 * 询盘接收端：本地 SSR API，取代原先的 Web3Forms 第三方中转。
 *
 * 流水线遵循「漏斗模型」，越便宜的判断越靠前，尽早掐断以节省开销：
 *   1. 蜜罐拦截        —— 零成本，静默丢弃并伪装成功
 *   2. 字段校验        —— 零成本
 *   3. IP 限流         —— 零成本（进程内计数）
 *   4. Turnstile 校验  —— 一次外网请求，Fail Open
 *   5. 语义特征        —— 零成本；黑名单静默丢弃，软标记改写标题
 *   6. 发信            —— 最贵，放最后
 */

export const prerender = false;

const MAX_BODY_BYTES = 32 * 1024;
const MAX_MESSAGE_LENGTH = 5000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const FIELD_LIMITS = {
  name: 120,
  company: 160,
  email: 254,
  inquiryType: 64,
} as const;

const DEFAULT_RECIPIENTS = ['info@jungleelite.com'];
const DEFAULT_SENDER = 'Jungle Elite Inquiry <inquiry@jungleelite.com>';

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 静默丢弃：对机器人伪装成功，绝不暴露拦截逻辑。 */
function fakeSuccess(): Response {
  return json({ ok: true });
}

function str(value: unknown, max = 0): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return max > 0 ? trimmed.slice(0, max) : trimmed;
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

async function readPayload(request: Request): Promise<Record<string, unknown> | null> {
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();

  try {
    if (contentType.includes('application/json')) {
      const data: unknown = await request.json();
      return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
    }

    if (contentType.includes('form')) {
      const form = await request.formData();
      const out: Record<string, unknown> = {};
      for (const [key, value] of form.entries()) {
        if (typeof value === 'string') out[key] = value;
      }
      return out;
    }
  } catch (error) {
    console.warn('[inquiry] 请求体解析失败', error);
    return null;
  }

  return null;
}

export const POST: APIRoute = async ({ request }) => {
  // ---------- 0. 请求体 ----------
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: 'payload-too-large' }, 413);
  }

  const payload = await readPayload(request);
  if (!payload) {
    return json({ ok: false, error: 'bad-request' }, 400);
  }

  const ip = clientIp(request);
  const notes: string[] = [];

  // ---------- 1. 蜜罐拦截（最高优先级，阻断后续一切执行） ----------
  const honeypotHits = findHoneypotHits(payload);
  if (honeypotHits.length) {
    // 丢弃是静默的、返回的是假成功，日志是唯一能还原现场的记录，务必写全。
    console.warn(
      `[inquiry] 蜜罐命中，静默丢弃 ip=${ip} hits=${honeypotHits
        .map((hit) => `${hit.field}="${hit.value}"`)
        .join(' ')}`,
    );
    return fakeSuccess();
  }

  // ---------- 2. 字段校验 ----------
  const name = str(payload.name, FIELD_LIMITS.name);
  const company = str(payload.company, FIELD_LIMITS.company);
  const email = str(payload.email, FIELD_LIMITS.email);
  const inquiryType = str(payload.inquiryType, FIELD_LIMITS.inquiryType);
  const message = str(payload.message, MAX_MESSAGE_LENGTH);

  const missing: string[] = [];
  if (!name) missing.push('name');
  if (!email) missing.push('email');
  if (!message) missing.push('message');

  if (missing.length) {
    return json({ ok: false, error: 'missing-fields', fields: missing }, 400);
  }
  if (!EMAIL_RE.test(email)) {
    return json({ ok: false, error: 'invalid-email' }, 400);
  }

  // ---------- 3. 基础 IP 限流 ----------
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    console.warn(`[inquiry] 触发限流 ip=${ip} retryAfter=${limit.retryAfterSec}s`);
    return new Response(
      JSON.stringify({ ok: false, error: 'rate-limited', retryAfter: limit.retryAfterSec }),
      {
        status: 429,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'retry-after': String(limit.retryAfterSec),
        },
      },
    );
  }

  // ---------- 4. Turnstile 网络校验（Fail Open 容灾） ----------
  const secretKey = readEnv('TURNSTILE_SECRET_KEY');
  const siteKey = readEnv('PUBLIC_TURNSTILE_SITE_KEY');
  const enforceTurnstile = readFlag('TURNSTILE_ENFORCE', true);
  const token = str(payload['cf-turnstile-response'], 4096);

  const verdict = await verifyTurnstile(token, secretKey, ip === 'unknown' ? undefined : ip);

  if (verdict.status === 'reject') {
    const tokenMissing = verdict.codes.includes('missing-input-response');

    // 无 token 有三种成因，只有第三种才是「确定的机器人信号」：
    //   a) 运维主动放宽                  → 放行
    //   b) 只配了 Secret 没配 Site Key   → 前端根本无从产出 token，属配置缺失 → 放行
    //   c) 两端都配好了却交白卷          → 拒绝
    if (tokenMissing && !enforceTurnstile) {
      notes.push('turnstile: 无 token（TURNSTILE_ENFORCE=false 已放宽）');
      console.warn(`[inquiry] 无 Turnstile token，按宽松模式放行 ip=${ip}`);
    } else if (tokenMissing && !siteKey) {
      notes.push('turnstile: 未配置 PUBLIC_TURNSTILE_SITE_KEY（fail open）');
      console.warn('[inquiry] 前端未配置 Site Key，不可能产出 token — 放行（fail open）');
    } else {
      console.warn(`[inquiry] Turnstile 判定失败 ${verdict.codes.join(',')} ip=${ip}`);
      return json(
        {
          ok: false,
          error: 'captcha-failed',
          message:
            'Human verification failed. Please refresh the page and try again, or email us at info@jungleelite.com.',
        },
        403,
      );
    }
  } else if (verdict.reason) {
    // 系统级错误下的人为放行——记录在案，便于事后排查是否被刷。
    notes.push(`turnstile: fail-open (${verdict.reason})`);
  }

  // ---------- 5. 语义特征与软标记 ----------
  const blacklistHit = matchBlacklist(`${company}\n${message}`);
  if (blacklistHit) {
    console.warn(
      `[inquiry] 黑名单命中(${blacklistHit})，静默丢弃 ip=${ip} text=${message.slice(0, 120).replace(/\s+/g, ' ')}`,
    );
    return fakeSuccess();
  }

  const tags = buildSubjectTags(message);
  notes.push(...tags.map((tag) => `tag ${tag}`));

  // ---------- 6. 发信 ----------
  const recipients = readList('INQUIRY_TO_EMAIL', DEFAULT_RECIPIENTS);

  const result = await sendInquiryMail(
    { name, company, email, inquiryType: inquiryType || 'unspecified', message },
    {
      subjectPrefix: tags.length ? `${tags.join(' ')} ` : '',
      ip,
      userAgent: request.headers.get('user-agent')?.slice(0, 300) ?? '',
      submittedAt: new Date().toISOString(),
      notes,
    },
    {
      apiKey: readEnv('RESEND_API_KEY'),
      from: readEnv('INQUIRY_FROM_EMAIL') || DEFAULT_SENDER,
      to: recipients,
    },
  );

  if (!result.ok) {
    // 发信失败是真的丢了线索，必须如实告知用户并给出备用邮箱，不能假装成功。
    return json(
      {
        ok: false,
        error: result.error,
        message:
          'We could not send your inquiry right now. Please email us directly at info@jungleelite.com.',
      },
      500,
    );
  }

  // 成功路径也要留痕。否则一旦「Resend 收了却没投出去」，日志里一无所有，
  // 只能靠「日志为空」倒推成功——带上 Resend 的 id，两边就能对上号。
  console.log(
    `[inquiry] 已投递 id=${result.id ?? '(no-id)'} to=${recipients.join(',')} ` +
      `tags=${tags.join(' ') || 'none'} notes=${notes.join(' | ') || 'none'}`,
  );

  return json({ ok: true, id: result.id });
};
