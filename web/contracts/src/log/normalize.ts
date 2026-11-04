/**
 * 日志归一（对应 change: unify-host-client-logging 的 design D3）。
 *
 * **为什么在出口归一而不是收紧调用点签名**：`ctx.log.scope(module)` 的入参类型是
 * `Record<string, unknown>`，扩展已经在用这个形状写日志。收紧签名等于要求所有扩展同步改，
 * 而归一的收益（有界、可分析、可脱敏）在出口就能拿到。所以调用点零改动，出口承担收敛。
 *
 * 归一规则：
 * - 已知字段（`level`/`event`/`message`/`errorCode`/`traceId`）按各自约束取值，非法即缺省或丢弃；
 * - **其余标量字段进 `attrs`**，键名与值都过脱敏与上限；
 * - 非标量字段序列化成文本后进 `attrs`（仍然有界）；
 * - 永不抛错：任何异常都退化成最小可用记录，绝不因为日志失败打断业务。
 */
import {
  LOG_ATTRIBUTE_VALUE_LIMIT,
  LOG_ERROR_CODE_PATTERN,
  LOG_EVENT_PATTERN,
  LOG_LIMITS,
  LOG_LEVELS,
  LOG_MESSAGE_LIMIT,
  LOG_MODULE_PATTERN,
  LOG_SCHEMA_VERSION,
  LOG_TRACE_ID_PATTERN,
  type LogAttrValue,
  type LogLevel,
  type LogRecord,
  type LogRuntime
} from "./record.js";
import { redactLogText, isSensitiveLogKey, REDACTED } from "./redact.js";
import { logText, truncateByCodePoints } from "./value.js";

/** 归一的输入。`raw` 就是调用方传进来的那个普通对象。 */
export type NormalizeLogInput = {
  module: string;
  runtime: LogRuntime;
  raw: Record<string, unknown>;
  /** 毫秒时间戳；出口传进来便于测试注入。 */
  now: number;
  pid?: number;
  runId?: string;
};

/**
 * 已经作为信封字段消费掉的键：不再重复进 `attrs`。
 *
 * `detail` / `msg` 是历史写法里常见的 message 别名，一并认掉。
 */
const RESERVED_KEYS = new Set(["level", "event", "message", "detail", "msg", "errorCode", "traceId", "time", "schema", "module", "runtime"]);

/** 模块名与事件名的容错：非法形状先尝试 slug 化，而不是丢掉整条记录。 */
function readIdentifier(value: unknown, pattern: RegExp, fallback: string): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (pattern.test(raw)) return raw;
  const slug = raw.replace(/[^a-z0-9._:-]+/g, "-").replace(/^[^a-z0-9]+|-+$/g, "");
  if (slug !== "" && pattern.test(slug)) return slug;
  const sanitized = truncateByCodePoints(slug === "" ? fallback : slug, LOG_LIMITS.identifier);
  return pattern.test(sanitized) ? sanitized : fallback;
}

function readLevel(value: unknown): LogLevel {
  if (typeof value === "string") {
    const lowered = value.toLowerCase();
    if ((LOG_LEVELS as readonly string[]).includes(lowered)) return lowered as LogLevel;
  }
  // Cordis 的数值级别：ERROR=0、INFO=1、WARN=2、DEBUG=3。
  if (typeof value === "number") {
    if (value === 0) return "error";
    if (value === 2) return "warn";
    if (value === 3) return "debug";
  }
  return "info";
}

function readOptionalText(value: unknown, limit: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = redactLogText(value, limit);
  return text === "" ? undefined : text;
}

/** 标量直接保留类型（便于按数值聚合），其余一律先转文本。 */
function toAttrValue(value: unknown): LogAttrValue | undefined {
  if (typeof value === "string") return truncateByCodePoints(value, LOG_LIMITS.attributeValue);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return undefined;
  const text = logText(value, LOG_LIMITS.attributeValue);
  return text === "" ? undefined : text;
}

/**
 * 把 `raw` 里未被消费的字段投影成 `attrs`。
 *
 * 键名规则：合法标识符直接用小写形式；否则序列化成一个稳定的扁平键（保留可读性），
 * 避免因键名不合规而整对丢弃。命中敏感键名的，值替换成占位而不是丢键。
 */
function projectAttributes(raw: Record<string, unknown>): Record<string, LogAttrValue> | undefined {
  const attrs: Record<string, LogAttrValue> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= LOG_LIMITS.attributes) break;
    if (RESERVED_KEYS.has(key)) continue;
    const normalizedKey = truncateByCodePoints(key.trim().toLowerCase(), LOG_LIMITS.identifier);
    if (normalizedKey === "") continue;
    if (isSensitiveLogKey(normalizedKey)) {
      attrs[normalizedKey] = REDACTED;
      count += 1;
      continue;
    }
    const projected = toAttrValue(value);
    if (projected === undefined) continue;
    // 字符串走脱敏；数值与布尔没有可脱敏内容。
    attrs[normalizedKey] = typeof projected === "string" ? redactLogText(projected, LOG_ATTRIBUTE_VALUE_LIMIT) : projected;
    count += 1;
  }
  return count === 0 ? undefined : attrs;
}

/**
 * 归一一条日志。
 *
 * 失败时退化：只保证 `schema/time/level/runtime/module/event` 六个必填字段成立，
 * 其余能留就留。这样即使调用方传了会抛错的 getter（`JSON.stringify` 里触发），
 * 也不会让一条日志变成异常。
 */
export function normalizeLogRecord(input: NormalizeLogInput): LogRecord {
  const { module, runtime, raw, now, pid, runId } = input;
  const record: LogRecord = {
    schema: LOG_SCHEMA_VERSION,
    time: new Date(now).toISOString(),
    level: readLevel(raw.level),
    runtime,
    module: readIdentifier(module, LOG_MODULE_PATTERN, "unknown"),
    event: readIdentifier(raw.event, LOG_EVENT_PATTERN, "log")
  };

  const message = readOptionalText(raw.message ?? raw.detail ?? raw.msg, LOG_MESSAGE_LIMIT);
  if (message !== undefined) record.message = message;

  const errorCode = typeof raw.errorCode === "string" ? raw.errorCode.trim().toLowerCase() : undefined;
  if (errorCode !== undefined && LOG_ERROR_CODE_PATTERN.test(errorCode)) record.errorCode = errorCode;

  if (typeof raw.traceId === "string" && LOG_TRACE_ID_PATTERN.test(raw.traceId.toLowerCase())) {
    record.traceId = raw.traceId.toLowerCase();
  }
  if (pid !== undefined) record.pid = pid;
  if (runId !== undefined && runId !== "") record.runId = runId;

  try {
    const attrs = projectAttributes(raw);
    if (attrs !== undefined) record.attrs = attrs;
  } catch {
    // 属性投影失败不影响主记录：宁可少细节，不可丢事件。
  }

  return record;
}
