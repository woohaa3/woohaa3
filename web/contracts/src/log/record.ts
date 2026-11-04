/**
 * 宿主日志记录契约（对应 change: unify-host-client-logging 的 design D2/D3）。
 *
 * 这是一份**出口信封**，不是业务 DTO：它描述"一条日志长什么样"，让落盘文件、导出产物与
 * 分析脚本共享同一个解析口径。业务代码不该直接构造 `LogRecord`——调用方仍然用
 * `ctx.log.scope(module)(普通对象)`，归一发生在出口。
 *
 * 三条口径：
 * - **有界**：每个字段都有上限，`LOG_LIMITS` 是唯一来源；
 * - **可分析**：标识字段（`module`/`event`/`errorCode`）形状固定，可以直接聚合，
 *   自由文本只出现在 `message` 与 `attrs` 的值里；
 * - **结构上装不下大数据**：没有"透传任意对象"的通道。
 */
import { LOG_ATTRIBUTE_VALUE_LIMIT, LOG_MESSAGE_LIMIT } from "./value.js";

// 信封与序列化的上限同源：调用方只 import record.js 也能拿到这两个常量。
export { LOG_ATTRIBUTE_VALUE_LIMIT, LOG_MESSAGE_LIMIT };

/** 当前信封版本。新增必填字段或改变语义时递增，解析侧按它分流。 */
export const LOG_SCHEMA_VERSION = 1 as const;

export type LogLevel = "debug" | "info" | "warn" | "error";

/** 记录由哪个运行时产生。前端目前不落盘，但保留取值以便将来接入时不改信封。 */
export type LogRuntime = "host" | "web";

export type LogAttrValue = string | number | boolean;

export type LogRecord = {
  schema: typeof LOG_SCHEMA_VERSION;
  /** ISO 8601。 */
  time: string;
  level: LogLevel;
  runtime: LogRuntime;
  /** 产生日志的模块，如 `canvas`、`task`。 */
  module: string;
  /** 事件名，如 `canvas-sync-upstream-failed`。 */
  event: string;
  /** 已脱敏、已截断的自由文本。 */
  message?: string;
  /** 稳定短错误码，便于聚合；不稳定的一律折成 `unknown`。 */
  errorCode?: string;
  /** 补充细节。键数与值长度都有上限。 */
  attrs?: Record<string, LogAttrValue>;
  /** 服务端透传的 W3C trace id（32 位小写十六进制）。 */
  traceId?: string;
  /** 进程号：多个宿主进程写同一日志目录时用来区分来源。 */
  pid?: number;
  /** 桌面壳注入的本次运行标识（`WOOHAA_DESKTOP_RUN_DIR` 的末段）。 */
  runId?: string;
};

export const LOG_LIMITS = {
  /** `message` 的码点上限。 */
  message: LOG_MESSAGE_LIMIT,
  /** 单个属性值的码点上限。 */
  attributeValue: LOG_ATTRIBUTE_VALUE_LIMIT,
  /** 属性对数上限；超出丢弃（不报错）。 */
  attributes: 32,
  /** 模块名与事件名的字符上限。 */
  identifier: 64
} as const;

/** 模块名：小写字母开头，其后小写字母、数字与连字符。 */
export const LOG_MODULE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
/** 事件名：允许点号分段（`sync.upstream.closed`）与冒号分段。 */
export const LOG_EVENT_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
/** 稳定错误码。 */
export const LOG_ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
/** W3C trace id。 */
export const LOG_TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** `a` 是否达到 `min` 的阈值。出口过滤与前端过滤共用同一判断。 */
export function logLevelAtLeast(level: LogLevel, min: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[min];
}
