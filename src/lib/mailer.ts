/**
 * 最后一道工序：通过 Resend HTTP API 投递内部询盘通知。
 *
 * 走 HTTP 而非 SMTP 的原因：Vercel Function 是短生命周期 + 可并发的，
 * 每次冷启动重建 SMTP 连接既慢又容易在并发下打满连接数；
 * HTTP API 是无状态的一次 fetch，天然适配 Serverless。
 *
 * 想换回 Nodemailer/SMTP 或别的服务商，只需替换本文件里的 `sendInquiryMail` 实现，
 * 调用方（`src/pages/api/inquiry.ts`）不需要改动。
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10_000;

export interface InquiryPayload {
  name: string;
  company: string;
  email: string;
  inquiryType: string;
  message: string;
}

export interface MailContext {
  subjectPrefix: string;
  ip: string;
  userAgent: string;
  submittedAt: string;
  /** 软标记 / 放行原因，一并写进邮件，方便业务员判断优先级。 */
  notes: string[];
}

export type MailResult = { ok: true; id?: string } | { ok: false; error: string };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildText(payload: InquiryPayload, ctx: MailContext): string {
  return [
    'New inquiry from jungleelite.com',
    '',
    `Name:         ${payload.name}`,
    `Company:      ${payload.company || '—'}`,
    `Email:        ${payload.email}`,
    `Project type: ${payload.inquiryType}`,
    '',
    'Message:',
    payload.message,
    '',
    '---',
    `Submitted:    ${ctx.submittedAt}`,
    `IP:           ${ctx.ip}`,
    `User agent:   ${ctx.userAgent || '—'}`,
    ...(ctx.notes.length ? [`Notes:        ${ctx.notes.join(' | ')}`] : []),
  ].join('\n');
}

function buildHtml(payload: InquiryPayload, ctx: MailContext): string {
  const rows: Array<[string, string]> = [
    ['Name', escapeHtml(payload.name)],
    ['Company', escapeHtml(payload.company) || '—'],
    ['Email', escapeHtml(payload.email)],
    ['Project type', escapeHtml(payload.inquiryType)],
  ];

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">
    <tr><td style="background:#0f172a;padding:20px 24px;color:#ffffff;font-size:16px;font-weight:700;">
      New inquiry from jungleelite.com
    </td></tr>
    <tr><td style="padding:24px;">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px;color:#0f172a;">
        ${rows
          .map(
            ([label, value]) =>
              `<tr><td style="padding:6px 0;color:#64748b;width:120px;vertical-align:top;">${label}</td><td style="padding:6px 0;font-weight:600;">${value}</td></tr>`,
          )
          .join('\n        ')}
      </table>
      <div style="margin-top:20px;padding-top:20px;border-top:1px solid #e2e8f0;">
        <div style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;">Message</div>
        <div style="white-space:pre-wrap;font-size:14px;line-height:1.6;color:#0f172a;">${escapeHtml(payload.message)}</div>
      </div>
      <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;line-height:1.7;">
        Submitted: ${escapeHtml(ctx.submittedAt)}<br>
        IP: ${escapeHtml(ctx.ip)}<br>
        User agent: ${escapeHtml(ctx.userAgent || '—')}
        ${ctx.notes.length ? `<br>Notes: ${escapeHtml(ctx.notes.join(' | '))}` : ''}
      </div>
    </td></tr>
  </table>
</body></html>`;
}

export async function sendInquiryMail(
  payload: InquiryPayload,
  ctx: MailContext,
  config: { apiKey: string; from: string; to: string[] },
): Promise<MailResult> {
  if (!config.apiKey) {
    return { ok: false, error: 'mail-not-configured' };
  }

  const subject = `${ctx.subjectPrefix}New Inquiry — ${payload.name}${
    payload.company ? ` / ${payload.company}` : ''
  } (${payload.inquiryType})`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: config.from,
        to: config.to,
        reply_to: payload.email,
        subject,
        text: buildText(payload, ctx),
        html: buildHtml(payload, ctx),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[mailer] Resend HTTP ${res.status}`, detail.slice(0, 500));
      return { ok: false, error: `resend-http-${res.status}` };
    }

    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: data.id };
  } catch (error) {
    console.error('[mailer] Resend 请求失败', error);
    return { ok: false, error: 'resend-request-failed' };
  } finally {
    clearTimeout(timer);
  }
}
