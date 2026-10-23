/**
 * Canvas Script 版本与预算事实源
 * （change: 2026-10-13-add-canvas-script-authoring，任务 1.1 / design D2、D4）。
 *
 * 这一份常量同时供执行器与能力声明消费，避免声明与实现漂移。它只表达隔离执行屏障与
 * 标识符长度约束，不包含任何可拒绝完整合法工作的总量额度。
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
 * 执行与提交的事实参数
 * （change: 2026-10-22-remove-agent-execution-limits，任务 5.1 / 6.1 / design D6）。
 *
 * 这里**不再**包含可拒绝合法脚本的应用侧额度：源码字节（原 128 KiB）、执行时长（原 2 秒）、
 * 展开操作数（原 256）、计划 JSON 字节（原 1 MiB）、单次 API 调用次数（原 4096）以及主体/全局
 * 并发与排队上限（原 2/8/32）都已删除。取代它们的是：
 * - **隔离执行 + 外部取消**：脚本承载于可 ``terminate()`` 的独立故障域，用户停止可达；
 * - **真实资源边界**：`heapLimitBytes` / `stackLimitBytes` 只表达执行器选用的隔离屏障大小，
 *   不是「超出即拒绝合法工作」的业务额度；真实分配失败按实际资源故障报告；
 * - **确定性校验**：双跑一致性与严格 codec 继续生效。
 *
 * `maxIdentifierChars` 是标识符/展示标题的长度约束（真实表达边界），不限制作品内容总量。
 */
export const CANVAS_SCRIPT_LIMITS = {
  /** 隔离执行 realm 的堆上限（执行器屏障；不是业务额度）。 */
  heapLimitBytes: 256 * 1024 * 1024,
  /** 隔离执行 realm 的调用栈上限（执行器屏障）。 */
  stackLimitBytes: 4 * 1024 * 1024,
  /** 标识符/展示标题的单字段长度约束。 */
  maxIdentifierChars: 200
} as const;

export type CanvasScriptLimits = typeof CANVAS_SCRIPT_LIMITS;
