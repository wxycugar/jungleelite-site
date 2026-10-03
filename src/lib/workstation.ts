/**
 * 询盘的唯一投递出口：推送到中央智能工作台网关（api.orviabag.com）。
 *
 * 契约以网关侧的 `src/routes/inquiry.ts` 为准。几处「照直觉写就会错」的地方
 * 记在这里，改本文件前先看一遍：
 *   - 租户靠 `site` / `site_key` / `X-Site-Key` 头识别，**网关不读 `site_id`**。
 *     识别不到就返回 404 unknown_site，所以字段和请求头两个都带上做双保险。
 *   - 网关会**自己再验一次 Turnstile**，token 必须原样转发过去。
 *   - 网关不再读 `submitted_at`（它按收到时刻自己打时间戳），IP / UA / geo 也从
 *     连接本身取，这些都不必也不能由我们提供。
 *   - 嵌套对象会被网关的 extractExtra 整块丢弃，所以这里一律平铺，不套 meta。
 *
 * 接口地址与密钥一律走环境变量，不硬编码：
 *   WORKSTATION_API_URL  必须是完整端点，含路径：
 *                        https://api.orviabag.com/api/v1/inquiry
 *   WORKSTATION_API_KEY  网关当前不校验该路由（靠 site_key + CORS 授权），
 *                        发送是为了将来加鉴权时不必回头改这里。
 */

/** 租户标识：payload 的 `site` 字段与 `X-Site-Key` 头共用这个值。 */
const SITE_KEY = 'jungleelite';

/**
 * 超时 4 秒。
 *
 * 这条链路现在是访客点下提交后唯一要等的事，4s 也就是访客的最坏等待——
 * 正常网关响应在数百毫秒级，留 4s 足够，同时不让一个失联的网关把 Vercel
 * Function 白白占住十几秒（Function 有执行时长上限，也按占用计费）。
 */
const TIMEOUT_MS = 4_000;

export interface WorkstationPayload {
  name: string;
  company: string;
  email: string;
  /** 对应网关的 `form_key` 列——网关没有 `inquiry_type` 这个字段。 */
  formKey: string;
  message: string;
}

export interface WorkstationContext {
  /** 询盘来自哪个页面，网关写进 `page_url`。 */
  pageUrl: string;
  /** 前端拿到的 Turnstile token，网关要拿它去 Cloudflare 再验一次。 */
  turnstileToken: string;
}

export type WorkstationResult =
  /** `reference` 是网关给这条线索生成的对外编号，日志里用它和网关侧对账。 */
  | { ok: true; reference?: string }
  | { ok: false; error: string };

/**
 * 组装推给网关的 JSON。
 *
 * 字段名以网关实际读取的为准（form_key / page_url / cf-turnstile-response），
 * 不沿用本站的内部叫法。
 *
 * 红线：这里只做「表单字段 → 网关字段」的搬运。表单里没有的东西一律不许出现，
 * 尤其不得凭行业惯例补上 ISO9001 / BSCI 之类的资质字段——网关侧要拿这份数据
 * 做 AI 解析，这里臆测一个字，下游就会当成客户原话扩散出去。
 */
function buildBody(payload: WorkstationPayload, ctx: WorkstationContext): Record<string, unknown> {
  return {
    site: SITE_KEY,
    form_key: payload.formKey,
    page_url: ctx.pageUrl,
    name: payload.name,
    company: payload.company,
    email: payload.email,
    message: payload.message,
    // 网关缺这个 token 时会按垃圾邮件处理（TURNSTILE_MISSING_TOKEN_MODE 默认
    // block），因此原样转发、不做省略也不填占位符，缺了就让网关如实判缺。
    'cf-turnstile-response': ctx.turnstileToken,
  };
}

export async function forwardInquiry(
  payload: WorkstationPayload,
  ctx: WorkstationContext,
  config: { url: string; apiKey: string },
): Promise<WorkstationResult> {
  // 地址没配就跳过：没有端点，再怎么重试也无处可送。
  if (!config.url) return { ok: false, error: 'workstation-not-configured' };

  // 密钥缺失只提示、不拦截。网关当前不校验这个头，为一个暂时无用的变量拒发
  // 询盘，等于自己给自己制造一次故障。将来网关真加了鉴权再改成硬性要求——
  // 到那时缺了本来也送不进去，拦截才是对的。
  if (!config.apiKey) {
    console.warn('[workstation] 未配置 WORKSTATION_API_KEY，本次不带鉴权头发送');
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // 双保险：网关优先读 body 里的 site，读不到再读这个头。
    'x-site-key': SITE_KEY,
  };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildBody(payload, ctx)),
      signal: controller.signal,
    });

    if (!res.ok) {
      // 把响应体前 500 字符记下来：网关的拒绝原因（unknown_site / turnstile_failed
      // / rate_limited）全在 body 里，只看状态码排查不出是配置错了还是被判垃圾。
      const detail = await res.text().catch(() => '');
      console.error(`[workstation] HTTP ${res.status} url=${config.url}`, detail.slice(0, 500));
      return { ok: false, error: `workstation-http-${res.status}` };
    }

    const data = (await res.json().catch(() => ({}))) as { reference?: string };
    return { ok: true, reference: data.reference };
  } catch (error) {
    // 超时（AbortError）与网络异常在这里合流：对调用方而言都是「这条没推上去」，
    // 分开只是为了日志能看出是网络抖动还是网关不响应。
    const aborted = error instanceof Error && error.name === 'AbortError';
    if (aborted) {
      console.error(`[workstation] 推送超时（${TIMEOUT_MS}ms）url=${config.url}`);
    } else {
      console.error(`[workstation] 推送失败 url=${config.url}`, error);
    }
    return { ok: false, error: aborted ? 'workstation-timeout' : 'workstation-request-failed' };
  } finally {
    clearTimeout(timer);
  }
}
