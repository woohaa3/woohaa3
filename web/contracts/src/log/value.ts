/**
 * 日志字段的值序列化（对应 change: unify-host-client-logging 的 design D3）。
 *
 * 存在的理由只有一条：**日志采集不能因为一个字段而丢掉整条记录**。业务代码随手传进来的
 * 东西可能是 `Error`、循环引用对象、`undefined`，也可能是带控制字符的长文本。这里把它们
 * 收敛成**单行、有界、可 JSON 序列化**的字符串。
 *
 * 口径参考成熟实现（Sentry `errorText`）：不可序列化时给稳定占位，而不是抛错或返回空串，
 * 否则排障时看到的是"这条日志什么都没有"，比没有日志更误导。
 */

/** 单条文本的默认上限（码点）。超长截断并留省略号。 */
export const LOG_MESSAGE_LIMIT = 2048;

/** 属性值的上限（码点）：属性是补充细节，不该装整份响应体。 */
export const LOG_ATTRIBUTE_VALUE_LIMIT = 256;

/**
 * 按**码点**截断，不会把代理对（emoji、部分中文）切成半个字符。
 *
 * 与 telemetry 的 `truncateByCodePoints` 同一取向：按 `Array.from` 得到的码点计数，而不是
 * `String#length` 的 UTF-16 码元数。
 */
export function truncateByCodePoints(value: string, limit: number): string {
  if (limit <= 0) return "";
  const points = Array.from(value);
  if (points.length <= limit) return value;
  return `${points.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

/**
 * 控制字符与换行折叠成单个空格。
 *
 * 日志是**行**协议：一条记录必须能占一行，否则文件通道的按行解析会被一条多行错误打断。
 */
export function foldSingleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * 把任意值转成可读文本。永不抛错。
 *
 * - `Error` 只取 `message`：堆栈进入日志会让单条记录膨胀，而且我们更关心"为什么失败"。
 * - `undefined` 保留字面量而不是变成空串，便于区分"没有这个字段"和"字段值是空"。
 * - 其余对象走 `JSON.stringify`，失败（循环引用、BigInt 混用等）时给稳定占位。
 */
export function logValueToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return "[function]";
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    // 循环引用、getter 抛错、BigInt 在 JSON 里等：统一给一个稳定占位。
    return "[unserializable]";
  }
}

/** `logValueToString` + 单行折叠 + 码点截断，日志出口实际使用的入口。 */
export function logText(value: unknown, limit = LOG_MESSAGE_LIMIT): string {
  return truncateByCodePoints(foldSingleLine(logValueToString(value)), limit);
}
