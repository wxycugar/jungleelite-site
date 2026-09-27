/**
 * 第三道防线：IP 级滑动窗口限流。
 *
 * ⚠️ 已知局限（请知悉）：
 * Vercel Function 是无状态的、可水平扩容的。这份计数器活在**单个实例的内存**里，
 * 因此它是「基础防轰炸」而不是「精确配额」——并发实例各自记账，
 * 冷启动 / 扩容后计数归零。
 *
 * 它能挡住脚本小子对着同一个实例的暴力连发，挡不住分布式刷单。
 * 若日后需要精确限流，把 `checkRateLimit` 换成 Upstash Redis / Vercel KV 实现即可，
 * 调用方无需改动。
 */

const WINDOW_MS = 10 * 60 * 1000; // 10 分钟
const MAX_REQUESTS = 5; // 每窗口最多 5 次
/** 防止 Map 随 IP 数量无限膨胀（长驻实例的内存护栏）。 */
const MAX_TRACKED_IPS = 5000;

const hits = new Map<string, number[]>();

function prune(now: number): void {
  for (const [ip, stamps] of hits) {
    const alive = stamps.filter((t) => now - t < WINDOW_MS);
    if (alive.length === 0) hits.delete(ip);
    else hits.set(ip, alive);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  /** 距离下一次可提交的秒数，仅在被拦截时有意义。 */
  retryAfterSec: number;
}

export function checkRateLimit(ip: string): RateLimitResult {
  const now = Date.now();

  if (hits.size > MAX_TRACKED_IPS) prune(now);

  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);

  if (recent.length >= MAX_REQUESTS) {
    const oldest = recent[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000));
    hits.set(ip, recent);
    return { allowed: false, retryAfterSec };
  }

  recent.push(now);
  hits.set(ip, recent);
  return { allowed: true, retryAfterSec: 0 };
}
