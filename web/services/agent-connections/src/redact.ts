/**
 * 连接诊断脱敏
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 1.4 / design D4）。
 *
 * 凭据、连接口令与 Woohaa grant 绝不进入日志、错误消息、事件或 DTO。本模块提供共享的
 * 脱敏工具，供两个扩展在写日志/构造错误前调用：命中已知敏感键或形似 token 的值都替换为
 * `[redacted]`，保留可读结构用于排障。
 */

const SENSITIVE_KEY_PATTERN = /(key|token|secret|password|authorization|auth|credential|api[-_]?key|grant)/i;

/** 形似 bearer/API Key 的独立 token：`sk-...`、`Bearer ...`、长 base64/hex 串。 */
const TOKEN_VALUE_PATTERN = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|[A-Za-z0-9_-]{32,})/;

export const REDACTED = "[redacted]";

export function redactString(value: string): string {
  return value.replace(new RegExp(TOKEN_VALUE_PATTERN, "g"), REDACTED);
}

/** 递归脱敏任意 JSON 结构；敏感键的整个值被替换，字符串值再做 token 形态检查。 */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactValue(entry);
    }
    return output;
  }
  return value;
}

/** 便于直接写入 host.logger 的诊断事件：事件名保留，字段整体脱敏。 */
export function redactEvent(event: Record<string, unknown>): Record<string, unknown> {
  return redactValue(event) as Record<string, unknown>;
}
