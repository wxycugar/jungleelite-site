/**
 * 第二道防线：Cloudflare Turnstile 服务端校验。
 *
 * 核心是 **Fail Open 容灾**：任何「系统级错误」都不得阻断真实询盘。
 *   - 缺 Secret Key      → 放行 + 警告日志
 *   - 网络超时 / 请求失败 → 放行 + 警告日志
 *   - Cloudflare 自身故障 (internal-error) → 放行 + 警告日志
 *
 * 只有 Cloudflare 明确判定「token 无效」（success:false 且非其自身故障）才真正拦截——
 * 那才是确定的机器人信号。
 */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5000;

/**
 * 应当放行的错误码——它们都指向「我方或 Cloudflare 的问题」，而非「访客是机器人」：
 *   internal-error        Cloudflare 自身故障
 *   missing-input-secret  Secret 没配上
 *   invalid-input-secret  Secret 填错了（打错一个字符就会走到这里）
 *   bad-request           请求畸形，即本文件的 bug
 *
 * 反之，`invalid-input-response` / `timeout-or-duplicate` 是确定的机器人信号，照常拦截。
 */
const FAIL_OPEN_CODES = new Set([
  'internal-error',
  'missing-input-secret',
  'invalid-input-secret',
  'bad-request',
]);

export type TurnstileOutcome =
  /** 校验通过，或系统级错误下的人为放行（reason 记录放行原因） */
  | { status: 'pass'; reason?: string }
  /** Cloudflare 明确拒绝 */
  | { status: 'reject'; codes: string[] };

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
    return { status: 'pass', reason: 'missing-secret' };
  }

  if (!token) {
    // 前端始终会尝试取 token。缺失说明：脚本被广告拦截器屏蔽 / 用户禁用了 JS。
    // 这是「无法判定」而非「确定是机器人」，交由调用方按 TURNSTILE_ENFORCE 决策。
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
      console.warn(`[turnstile] siteverify HTTP ${res.status} — 放行（fail open）`);
      return { status: 'pass', reason: `http-${res.status}` };
    }

    const data = (await res.json()) as SiteverifyResponse;
    if (data.success) return { status: 'pass' };

    const codes = data['error-codes'] ?? [];
    if (codes.some((code) => FAIL_OPEN_CODES.has(code))) {
      console.warn(`[turnstile] 配置/服务端故障 ${codes.join(',')} — 放行（fail open）`);
      return { status: 'pass', reason: codes.join(',') };
    }

    return { status: 'reject', codes };
  } catch (error) {
    const kind = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network';
    console.warn(`[turnstile] 校验${kind === 'timeout' ? '超时' : '请求失败'} — 放行（fail open）`, error);
    return { status: 'pass', reason: kind };
  } finally {
    clearTimeout(timer);
  }
}
