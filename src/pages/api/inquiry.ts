import type { APIRoute } from 'astro';
import { readEnv, readFlag } from '@/lib/env';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  buildSubjectTags,
  findHoneypotHits,
  matchBlacklist,
} from '@/lib/spam-filter';
import { verifyTurnstile } from '@/lib/turnstile';
import { forwardInquiry } from '@/lib/workstation';

/**
 * 询盘接收端：本地 SSR API，取代原先的 Web3Forms 第三方中转。
 *
 * 流水线遵循「漏斗模型」，越便宜的判断越靠前，尽早掐断以节省开销：
 *   1. 蜜罐拦截        —— 零成本，静默丢弃并伪装成功
 *   2. 字段校验        —— 零成本
 *   3. IP 限流         —— 零成本（进程内计数）
 *   4. Turnstile 校验  —— 一次外网请求，Fail Open
 *   5. 语义特征        —— 零成本；黑名单静默丢弃，软标记随询盘一并送走
 *   6. 推送中央工作台  —— 唯一的投递出口
 *
 * ⚠️ 第 6 步是这条链路**唯一**的去处：网关不可用时，询盘就是真的没送出去。
 * 正因为没有兜底，这一步失败时必须返回 500 并请访客直接发邮件，绝不能伪装
 * 成功——访客以为发出去了、我们这边什么都没有，线索就静默蒸发了。
 * （业务初期为极简架构移除了原先的 Resend 发信兜底；若要恢复「工作台失败
 * 仍发一封邮件」，在第 6 步那里并行接回一个发信调用即可，git 历史里有实现。）
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

/** 推送失败时告诉访客的备用联系方式——此刻它是这条线索唯一的去处。 */
const FALLBACK_CONTACT = 'info@jungleelite.com';

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

  const submittedAt = new Date().toISOString();
  const userAgent = request.headers.get('user-agent')?.slice(0, 300) ?? '';

  // ---------- 6. 推送中央工作台（唯一投递出口） ----------
  const forwarded = await forwardInquiry(
    { name, company, email, inquiryType: inquiryType || 'unspecified', message },
    {
      ip,
      userAgent,
      referer: request.headers.get('referer')?.slice(0, 300) ?? '',
      submittedAt,
      tags,
      notes,
    },
    { url: readEnv('WORKSTATION_API_URL'), apiKey: readEnv('WORKSTATION_API_KEY') },
  );

  if (!forwarded.ok) {
    // 没有兜底链路了，推送失败就是真的没送出去，必须如实告知访客并给出备用
    // 邮箱。绝不能返回假成功——那会让线索静默蒸发，正是当初蜜罐误判踩过的坑，
    // 而且这次连邮件都没有，事后在日志之外毫无痕迹。
    console.error(
      `[inquiry] 工作台推送失败，询盘未能送达 error=${forwarded.error} ip=${ip} email=${email}`,
    );
    return json(
      {
        ok: false,
        error: forwarded.error,
        message: `We could not send your inquiry right now. Please email us directly at ${FALLBACK_CONTACT}.`,
      },
      500,
    );
  }

  // 成功路径也要留痕：网关收了却没落库时，日志是唯一能对上号的东西。
  console.log(
    `[inquiry] 已推送 id=${forwarded.id ?? '(no-id)'} ip=${ip} ` +
      `tags=${tags.join(' ') || 'none'} notes=${notes.join(' | ') || 'none'}`,
  );

  // 不回传网关的记录 id：那是内部标识，对访客没有意义，前端也不消费，
  // 白白泄露一条内部信息出去。
  return json({ ok: true });
};
