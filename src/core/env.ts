/** 读取并清理一个可选环境变量。 */
export function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** 读取必需环境变量；缺失时给出适合青龙日志查看的错误信息。 */
export function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) {
    throw new Error(`缺少环境变量 ${name}，请在青龙「环境变量」中添加后重试`);
  }
  return value;
}

/**
 * 将青龙中常见的多账号变量拆成数组。
 * 默认兼容换行、& 和 @ 分隔，不拆分 Cookie 自身常见的分号。
 */
export function splitAccounts(value: string | undefined): string[] {
  if (!value) return [];

  return value
    .split(/[\n&@]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}
