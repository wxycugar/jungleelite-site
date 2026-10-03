/**
 * 第二道防线：Cloudflare Turnstile 服务端校验。
 *
 * 这里**不再放行任何失败**。原先的 Fail Open 容灾（系统级错误一律放行）已彻底
 * 移除，理由是它已经不产生任何收益：网关侧对缺 token 是硬拦截
 * （TURNSTILE_MISSING_TOKEN_MODE = block），我们自作主张放行，token 还是会被
 * 网关再拒一次，访客白等一个来回，日志里只多一条看不出所以然的 403。
 *
 * 但「拒绝」必须分清责任方，因为两者的真相和处置方式完全不同：
 *   reject       —— Cloudflare 明确判定 token 无效。这是确定的机器人信号，
 *                   回访客「人机校验未通过」是准确的。
 *   unavailable  —— 我方或 Cloudflare 的系统级故障（超时、Secret 缺失、CF 自身
 *                   故障）。同样不放行，但绝不能说成「你是机器人」：那是我们没
 *                   配好或依赖方挂了。此时应如实告知访客「暂时提交不了，请直接
 *                   发邮件」，并在日志里留下可排查的原因。
 */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5000;

/**
 * 这些错误码指向「我方或 Cloudflare 的问题」，而非「访客是机器人」，
 * 因此归入 unavailable 而不是 reject：
 *   internal-error        Cloudflare 自身故障
 *   missing-input-secret  Secret 没配上
 *   invalid-input-secret  Secret 填错了（打错一个字符就会走到这里）
 *   bad-request           请求畸形，即本文件的 bug
 *
 * 反之，`invalid-input-response` / `timeout-or-duplicate` 是确定的机器人信号，
 * 归入 reject。
 */
const UNAVAILABLE_CODES = new Set([
  'internal-error',
  'missing-input-secret',
  'invalid-input-secret',
  'bad-request',
]);

export type TurnstileOutcome =
  /** 校验通过 */
  | { status: 'pass' }
  /** Cloudflare 明确判定 token 无效——访客侧问题 */
  | { status: 'reject'; codes: string[] }
  /** 我方配置缺失或依赖方故障——责任在我方，不得混同于上一类 */
  | { status: 'unavailable'; reason: string };

interface SiteverifyResponse {
  success?: boolean;
  'error-codes'?: string[];
}

export async function verifyTurnstile(
  token: string,
  secretKey: string,
  remoteIp?: string,
): Promise<TurnstileOutcome> {
  if (!secretKey) {
    // Secret 没配时，前端照样会产出 token，但服务端无从校验。这里绝不能解释成
    // 「放行」——那会变成一个「配置里写着开启、实际什么都不做」的安全控制，而
    // 它连自己的缺席都报不出来。返回 unavailable 会让所有询盘被拒（访客看到
    // 「暂时无法提交，请直接发邮件」），属必须在上线前修掉的配置缺失，日志要喊。
    return { status: 'unavailable', reason: 'missing-secret' };
  }

  if (!token) {
    // 前端始终会尝试取 token。走到这里说明：脚本被广告拦截器屏蔽 / 用户禁用了 JS。
    return { status: 'reject', codes: ['missing-input-response'] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const form = new URLSearchParams({ secret: secretKey, response: token });
    if (remoteIp) form.set('remoteip', remoteIp);

    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: controller.signal,
    });

    if (!res.ok) {
      console.error(`[turnstile] siteverify HTTP ${res.status} — 无法校验，拒收`);
      return { status: 'unavailable', reason: `http-${res.status}` };
    }

    const data = (await res.json()) as SiteverifyResponse;
    if (data.success) return { status: 'pass' };

    const codes = data['error-codes'] ?? [];
    if (codes.some((code) => UNAVAILABLE_CODES.has(code))) {
      console.error(`[turnstile] 配置/服务端故障 ${codes.join(',')} — 无法校验，拒收`);
      return { status: 'unavailable', reason: codes.join(',') };
    }

    return { status: 'reject', codes };
  } catch (error) {
    const kind = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network';
    console.error(
      `[turnstile] 校验${kind === 'timeout' ? '超时' : '请求失败'} — 无法校验，拒收`,
      error,
    );
    return { status: 'unavailable', reason: kind };
  } finally {
    clearTimeout(timer);
  }
}
