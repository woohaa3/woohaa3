/**
 * Model authoring batches; Canvas Script remains responsible for canvas structure.
 *
 * change: 2026-10-22-remove-agent-execution-limits，任务 5.3：原 `MODEL_SCRIPT_BATCH_LIMITS`
 * （批次 64 模型、单项 20 万字符、展开/响应 1 MiB、15 秒、并发 2 批）已删除。完整批次由实际
 * 资源调度并一次原子保存，不再按固定数量/字节/时长/并发拒绝合法工作。
 *
 * 保留的 `MODEL_BATCH_PAGING` 只是读取分页参数（可继续读取，不是总量截断）。
 */
import type { ModelContentVersion } from "./model-definition.js";

/** 批次读取的分页参数（传输语义；大响应可继续读取）。 */
export const MODEL_BATCH_PAGING = {
  /** get_model_nodes 单页 nodeIds 数缺省值。 */
  defaultPageNodes: 64,
} as const;

export type ModelScriptBatchItem = {
  nodeId: string;
  /** Appended after commonSource with a newline, in an independent scene execution. */
  source: string;
  expectedModelContentHash?: string;
};
export type ModelScriptBatchRequest = {
  canvasId: string;
  requestId: string;
  version?: "woohaa-model-js-v2";
  commonSource?: string;
  items: ModelScriptBatchItem[];
};
export type ModelBatchIssue = {
  index: number;
  nodeId: string;
  code: string;
  message: string;
};
export type ModelBatchFailure = {
  ok: false;
  code: string;
  message: string;
  errors?: ModelBatchIssue[];
};
export type ModelBatchNodeSummary = {
  nodeId: string;
  modelContentVersion: ModelContentVersion;
  validation: "passed";
  geometry: {
    min: number[] | null;
    max: number[] | null;
    operationCount: number;
  };
};
/** Stored with the command in the same transaction, without source text. */
export type ModelScriptBatchMeta = {
  submissionHash: string;
  worldConversion?: import("./world-conversion.js").WorldConversionReceipt;
  imageDirectorScene?: import("./image-director-scene.js").ImageDirectorSceneReceipt;
  imageDirectorReservation?: import("./image-director-scene.js").ImageDirectorSceneReservation;
  statistics?: import("./scene-ir-v2/stats.js").ModelSceneStatistics;
  breakdown?: import("./scene-ir-v2/stats.js").ModelSceneStatisticsBreakdown;
  nodes: ModelBatchNodeSummary[];
};
export type ModelScriptBatchOutcome =
  | ModelBatchFailure
  | {
      ok: true;
      canvasId: string;
      requestId: string;
      commandId: string;
      revision: number;
      duplicate: boolean;
      noop: boolean;
      validatedOnly: boolean;
      nodes: ModelBatchNodeSummary[];
    };
export type GetModelNodesInput = {
  canvasId: string;
  nodeIds: string[];
  includeSource?: boolean;
};
export type ModelNodesOutcome =
  | ModelBatchFailure
  | {
      ok: true;
      canvasId: string;
      revision: number;
      nodes: Array<{
        nodeId: string;
        nodeType: string;
        title: string;
        prompt: string;
        modelContentVersion?: ModelContentVersion;
        source?: string;
        version?: string;
        status?: "ok" | "failed";
              references: import("./domain/model-reference-inputs.js").ModelReferenceInput[];
      }>;
    };
