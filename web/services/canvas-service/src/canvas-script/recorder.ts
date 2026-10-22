/**
 * Canvas Script 受限执行：语义 recorder 与输出解码
 * （change: 2026-10-13-add-canvas-script-authoring，任务 2.3 / 2.4 / 2.5 / design D2、D4）。
 *
 * recorder 在隔离 realm 内把 `canvas` API 调用记录为有序的 `AgentPlanOperation[]`（见
 * prelude.ts）；本模块是**宿主编译门**：把 realm 输出重新走一遍 contracts 严格 codec。
 *
 * 为什么在宿主重跑 codec：realm 内记录只是「尽量早发现」，realm 之外的宿主边界必须能独立
 * 判定输入合法，不依赖「prelude 一定正确」。因此即使 prelude 被绕过，未知字段、非法 ref
 * 形式、超限 prompt 仍会在 host 侧被拒绝。
 *
 * 源码字节、时间、内存、操作数/API 调用预算都在 engine/prelude 落实；本模块不重复判定，
 * 只补齐 codec 与「记录阶段」诊断。
 */
import {
  CANVAS_SCRIPT_LIMITS,
  canvasScriptError,
  canvasScriptSourceBytes,
  decodeAgentPlanOperations,
  type AgentPlanOperation,
  type CanvasScriptError
} from "@woohaa3/contracts";
import { CanvasScriptEngine, type CanvasScriptExecutionInput } from "./engine.js";

export type RecordScriptInput = {
  source: string;
  nodeKinds: readonly string[];
  promptMaxChars: number;
  positionAbsMax: number;
  /** 共享请求 deadline（epoch 毫秒）；双跑共享。 */
  deadlineMs: number;
  maxOperations?: number;
  heapLimitBytes?: number;
};

export type RecordScriptOutcome =
  | { ok: true; operations: AgentPlanOperation[]; apiCalls: number }
  | { ok: false; error: CanvasScriptError };

/** 记录器：引擎 + host 侧严格解码。 */
export class CanvasScriptRecorder {
  private readonly engine: CanvasScriptEngine;

  constructor(engine: CanvasScriptEngine = new CanvasScriptEngine()) {
    this.engine = engine;
  }

  async record(input: RecordScriptInput): Promise<RecordScriptOutcome> {
    // 源码字节在执行/分配前兜底（codec 已判，这里防止非 protocol 调用方绕过）。
    const bytes = canvasScriptSourceBytes(input.source);
    if (bytes > CANVAS_SCRIPT_LIMITS.sourceMaxBytes) {
      return {
        ok: false,
        error: canvasScriptError("script-limit-exceeded", "decode", `源码 ${bytes} 字节超过上限`, { field: "source" })
      };
    }

    const execution: CanvasScriptExecutionInput = {
      source: input.source,
      nodeKinds: input.nodeKinds,
      promptMaxChars: input.promptMaxChars,
      positionAbsMax: input.positionAbsMax,
      deadlineMs: input.deadlineMs,
      ...(input.maxOperations !== undefined ? { maxOperations: input.maxOperations } : {}),
      ...(input.heapLimitBytes !== undefined ? { heapLimitBytes: input.heapLimitBytes } : {})
    };
    const executed = await this.engine.execute(execution);
    if (!executed.ok) return { ok: false, error: executed.error };

    // realm 之外再走一次严格 codec：未知字段/非法结构/超限 prompt 在此拒绝。
    const decoded = decodeAgentPlanOperations(executed.operations);
    if (!decoded.ok) {
      return {
        ok: false,
        error: canvasScriptError(decoded.code, "record", decoded.message, {
          ...(decoded.operationIndex !== undefined ? { operationIndex: decoded.operationIndex } : {}),
          ...(decoded.field !== undefined ? { field: decoded.field } : {}),
          suggestion: "修正脚本的 API 调用后重试"
        })
      };
    }
    return { ok: true, operations: decoded.value, apiCalls: executed.apiCalls };
  }
}
