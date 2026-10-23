/**
 * Canvas Script 受限执行：语义 recorder 与输出解码
 * （change: 2026-10-13-add-canvas-script-authoring，任务 2.3 / 2.4 / 2.5 / design D2、D4）。
 *
 * recorder 在隔离 realm 内把 `canvas` API 调用记录为有序的 `AgentPlanOperation[]`（见
 * prelude.ts）；本模块是**宿主编译门**：把 realm 输出重新走一遍 contracts 严格 codec。
 *
 * 为什么在宿主重跑 codec：realm 内记录只是「尽量早发现」，realm 之外的宿主边界必须能独立
 * 判定输入合法，不依赖「prelude 一定正确」。因此即使 prelude 被绕过，未知字段与非法 ref
 * 形式仍会在 host 侧被拒绝。
 *
 * change: 2026-10-22-remove-agent-execution-limits，任务 5.1 / 6.1：源码字节、操作数与 API
 * 调用预算不再作为应用侧拒绝条件；本模块只补齐 codec 与「记录阶段」诊断，执行时长由可取消的
 * 隔离执行与真实资源故障表达。
 */
import {
  canvasScriptError,
  decodeAgentPlanOperations,
  type AgentPlanOperation,
  type CanvasScriptError
} from "@woohaa3/contracts";
import { CanvasScriptEngine, type CanvasScriptExecutionInput } from "./engine.js";

export type RecordScriptInput = {
  source: string;
  nodeKinds: readonly string[];
  positionAbsMax: number;
  /** 可选的显式取消/截止时间（epoch 毫秒）；缺省不设应用侧时长上限。 */
  deadlineMs?: number;
  heapLimitBytes?: number;
  /** 外部取消信号：用户停止时可从执行器外终止隔离执行。 */
  signal?: AbortSignal;
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
    const execution: CanvasScriptExecutionInput = {
      source: input.source,
      nodeKinds: input.nodeKinds,
      positionAbsMax: input.positionAbsMax,
      ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
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
