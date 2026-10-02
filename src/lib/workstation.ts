/**
 * 询盘的第二条投递链路：推送到中央智能工作台网关（api.orviabag.com）。
 *
 * 与 mailer.ts 是「主路 + 兜底」的关系，不是二选一：
 *   - 工作台负责把各独立站的询盘集中沉淀，供后续 AI 解析与流转；
 *   - 邮件是业务员当下就能看到、且不依赖工作台存活的兜底通知。
 *
 * 因此本模块**永不抛错**：任何异常（超时、连接失败、响应畸形）都收敛成返回值，
 * 由调用方继续走发信流程。工作台抖一下就把询盘弄丢，是这里唯一不可接受的结果。
 *
 * 接口地址与密钥一律走环境变量，不硬编码：
 *   WORKSTATION_API_URL  例如 https://api.orviabag.com/ingest
 *   WORKSTATION_API_KEY  网关侧签发的鉴权密钥
 */

/** 源站点标识：网关靠它区分这条询盘来自哪个独立站。 */
const SITE_ID = 'jungleelite';

/**
 * 超时 4 秒（要求区间 3–5s）。
 *
 * 调用方把本模块与发信并行执行、取两者较慢者作为响应时间，因此这个值只要
 * 短于发信的 10s 超时，网关就永远不会成为拖慢访客的那一环——选 4s 是留足
 * 余量（正常网关响应在数百毫秒级），同时不让一个失联的网关把 Vercel Function
 * 白白占住十几秒。
 */
const TIMEOUT_MS = 4_000;

export interface WorkstationPayload {
  name: string;
  company: string;
  email: string;
  inquiryType: string;
  message: string;
}

export interface WorkstationContext {
  ip: string;
  userAgent: string;
  referer: string;
  submittedAt: string;
  /** 软标记（如 [Has Links]），供网关侧排优先级。 */
  tags: string[];
  /** 本链路上的处置备注（如 turnstile fail-open），供网关侧判断可信度。 */
  notes: string[];
}

export type WorkstationResult = { ok: true; id?: string } | { ok: false; error: string };

/**
 * 组装推给网关的 JSON。
 *
 * 字段命名用 snake_case，与本文件顶部的 SITE_ID 一致——网关要同时吃多个站点的
 * 数据，命名风格统一比贴合某一站的内部叫法更重要。
 *
 * 红线：这里只做「表单字段 → 同义字段名」的搬运。表单里没有的东西一律不许出现，
 * 尤其不得凭行业惯例补上 ISO9001 / BSCI 之类的资质字段——网关侧后续要拿这份
 * 数据做 AI 解析，这里臆测一个字，下游就会当成客户原话扩散出去。
 * `meta` 里放的也只有服务端客观观测到的请求痕迹，不含任何推断。
 */
function buildBody(payload: WorkstationPayload, ctx: WorkstationContext): Record<string, unknown> {
  return {
    site_id: SITE_ID,
    submitted_at: ctx.submittedAt,
    name: payload.name,
    company: payload.company,
    email: payload.email,
    inquiry_type: payload.inquiryType,
    message: payload.message,
    meta: {
      ip: ctx.ip,
      user_agent: ctx.userAgent,
      referer: ctx.referer,
      spam_tags: ctx.tags,
      review_notes: ctx.notes,
    },
  };
}

export async function forwardInquiry(
  payload: WorkstationPayload,
  ctx: WorkstationContext,
  config: { url: string; apiKey: string },
): Promise<WorkstationResult> {
  // 没配就跳过，而不是发一个必然 401 的请求——那会白白占用 4 秒超时预算。
  // 返回的原因区分「没配置」与「配了但推送失败」，便于日志里一眼分清是
  // 忘了加环境变量，还是网关真的挂了。
  if (!config.url) return { ok: false, error: 'workstation-not-configured' };
  if (!config.apiKey) return { ok: false, error: 'workstation-key-missing' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(buildBody(payload, ctx)),
      signal: controller.signal,
    });

    if (!res.ok) {
      // 把响应体前 500 字符记下来：401 和 404 的处理方式完全不同，
      // 只看状态码排查不出「密钥填错」还是「路径写错」。
      const detail = await res.text().catch(() => '');
      console.error(`[workstation] HTTP ${res.status} url=${config.url}`, detail.slice(0, 500));
      return { ok: false, error: `workstation-http-${res.status}` };
    }

    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: data.id };
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
