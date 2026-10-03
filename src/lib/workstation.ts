/**
 * 询盘的唯一投递出口：推送到中央智能工作台网关（api.orviabag.com）。
 *
 * 契约以网关侧的 `src/routes/inquiry.ts` 为准。几处「照直觉写就会错」的地方
 * 记在这里，改本文件前先看一遍：
 *   - 租户靠 `site` / `site_key` / `X-Site-Key` 头识别，**网关不读 `site_id`**。
 *     识别不到就返回 404 unknown_site，所以字段和请求头两个都带上做双保险。
 *   - 网关会**自己再验一次 Turnstile**，token 必须原样转发过去。它那边对缺
 *     token 是硬拦截，所以本站的校验也不再放行（见 lib/turnstile.ts）。
 *   - `form_key` 是**表单标识**（可查询列），不是业务字段。本站只有一个询盘
 *     表单，故恒定送 'contact'；项目类型走 `project_type`（见 buildBody）。
 *   - 网关的 `extractExtra` 会把「值是对象」的字段整块丢掉，嵌套就是丢数据。
 *     要进它的 extra JSON，只能平铺成顶层标量。
 *   - 网关不再读 `submitted_at`（它按收到时刻自己打时间戳），UA / geo 也从连接
 *     本身取。IP 例外：见下面 x-forwarded-for 的说明。
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
  /** 业务项目类型（OEM / ODM、打样、现货…）。不是表单标识，别塞进 form_key。 */
  projectType: string;
  message: string;
}

export interface WorkstationContext {
  /** 询盘来自哪个页面，网关写进 `page_url`。 */
  pageUrl: string;
  /** 前端拿到的 Turnstile token，网关要拿它去 Cloudflare 再验一次。 */
  turnstileToken: string;
  /** 访客真实 IP；取不到时为空串（此时不发 x-forwarded-for 头）。 */
  visitorIp: string;
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
  const body: Record<string, unknown> = {
    site: SITE_KEY,
    // 恒定 'contact'：form_key 标识的是「哪个表单」，本站只有这一个询盘表单。
    // 项目类型是业务内容，塞进这里会污染网关按表单维度的统计与筛选。
    form_key: 'contact',
    page_url: ctx.pageUrl,
    name: payload.name,
    company: payload.company,
    email: payload.email,
    message: payload.message,
    // 网关缺这个 token 时会按垃圾邮件硬拦（TURNSTILE_MISSING_TOKEN_MODE=block），
    // 因此原样转发、不做省略也不填占位符，缺了就让网关如实判缺。
    'cf-turnstile-response': ctx.turnstileToken,
  };

  // 项目类型平铺成顶层标量，而不是包一层 `extra: { ... }`：网关的 extractExtra
  // 会跳过一切「值是对象」的字段，包起来等于把数据扔掉，而且丢得悄无声息。
  // `project_type` 不在它的 RESERVED_FIELDS 里，网关会自动收进自己的 extra JSON
  // ——正是我们要它去的位置。访客没选时不发，省得给网关塞一个空字段。
  if (payload.projectType) body.project_type = payload.projectType;

  return body;
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

  // 显式转发访客 IP。网关的 readClientIp 只认 CF-Connecting-IP，而 Cloudflare
  // 在边缘把这个头写成**我们这台的出口 IP**（Vercel 的），不是访客的——于是
  // 所有询盘共用一个 IP，ipHash / geo 失真，网关那条按 IP 的限流桶（默认 8/min）
  // 还会退化成全站共用一个桶。这里把访客真实 IP 附在 X-Forwarded-For 上带过去；
  // 网关侧改为优先读它才能生效（待办在网关那边）。取不到就不发，不编造。
  if (ctx.visitorIp) headers['x-forwarded-for'] = ctx.visitorIp;

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
