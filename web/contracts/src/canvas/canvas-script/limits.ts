/**
 * Canvas Script 版本与预算事实源
 * （change: 2026-10-13-add-canvas-script-authoring，任务 1.1 / design D2、D4）。
 *
 * 这一份常量同时供三处消费，避免能力声明与实际执行预算漂移：
 * - MCP `get_canvas_script_api` 的能力响应；
 * - Canvas 受限执行器的接收/记录/并发门禁；
 * - contracts 严格 codec 的接收前校验。
 *
 * 源码预算在**分配大对象之前**按 UTF-8 字节判定（`sourceMaxBytes`），不是按字符数。
 */

/** 受支持的脚本 API 版本；未知版本在副作用前拒绝。 */
export const CANVAS_SCRIPT_VERSIONS = ["woohaa-canvas-js-v1"] as const;

export type CanvasScriptVersion = (typeof CANVAS_SCRIPT_VERSIONS)[number];

/** 首版默认版本；`get_canvas_script_api` 与指南都引用它。 */
export const DEFAULT_CANVAS_SCRIPT_VERSION: CanvasScriptVersion = "woohaa-canvas-js-v1";

/** 脚本能力 version：能力语义变化时提升（回执与幂等身份都记它）。 */
export const CANVAS_SCRIPT_API_VERSION = 2 as const;

/** Canvas script 对外协议版本（回执/能力响应）；不兼容结构变化时提升。 */
export const CANVAS_SCRIPT_PROTOCOL_VERSION = 1 as const;

export function isCanvasScriptVersion(value: unknown): value is CanvasScriptVersion {
  return typeof value === "string" && (CANVAS_SCRIPT_VERSIONS as readonly string[]).includes(value);
}

/**
 * 执行与提交预算。
 *
 * `sourceMaxBytes` / `executionTimeoutMs` / `heapLimitBytes` 是**单次执行**预算；
 * `maxOperations` / `planMaxBytes` 是**记录输出**预算；并发与排队上限在服务端门禁生效。
 */
export const CANVAS_SCRIPT_LIMITS = {
  /** 源码 UTF-8 字节上限（接收前判定）。 */
  sourceMaxBytes: 128 * 1024,
  /** 单次执行（含双跑共享）总时间上限（毫秒）。 */
  executionTimeoutMs: 2_000,
  /** QuickJS 独立堆上限（字节）。 */
  heapLimitBytes: 32 * 1024 * 1024,
  /** QuickJS 调用栈上限（字节）。 */
  stackLimitBytes: 512 * 1024,
  /** 展开后语义操作数上限（记录时判定）。 */
  maxOperations: 256,
  /** 规范化计划 JSON 上限（字节）。 */
  planMaxBytes: 1024 * 1024,
  /** 单 principal 并发执行上限。 */
  maxConcurrentPerPrincipal: 2,
  /** 进程内全局并发执行上限。 */
  maxConcurrentGlobal: 8,
  /** 等待并发名额的排队上限（超出返回不可重试的繁忙错误）。 */
  maxQueueDepth: 32,
  /** 单次执行内 API 调用次数上限（含被拒绝调用）。 */
  maxApiCalls: 4_096
} as const;

export type CanvasScriptLimits = typeof CANVAS_SCRIPT_LIMITS;
