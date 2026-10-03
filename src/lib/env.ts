/**
 * 统一的环境变量读取口。
 *
 * 需要同时兼顾两套来源：
 *  - `process.env`      → Vercel Function 运行时注入的线上密钥（构建期不可见，只能在运行时读）
 *  - `import.meta.env`  → `astro dev` / 本地构建时 Vite 从 `.env` 载入的值
 *
 * 读取优先级：process.env > import.meta.env > 空字符串。
 * 任何一层取不到都返回空串，不抛错——缺值算不算致命，由调用方决定。
 */

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readEnv(key: string): string {
  const fromProcess =
    typeof process !== 'undefined' && process.env ? process.env[key] : undefined;
  const processValue = clean(fromProcess);
  if (processValue) return processValue;

  try {
    const meta = import.meta.env as unknown as Record<string, unknown> | undefined;
    return clean(meta?.[key]);
  } catch {
    return '';
  }
}
