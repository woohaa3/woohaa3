/** Bounded model authoring batches; Canvas Script remains responsible for canvas structure. */
import type { ModelCamera } from "./model-cameras.js";
import type { ModelContentVersion } from "./model-definition.js";

export const MODEL_SCRIPT_BATCH_LIMITS = {
  maxNodes: 64,
  maxSourceChars: 200_000,
  maxExpandedSourceBytes: 1024 * 1024,
  maxExecutionMs: 15_000,
  maxResponseBytes: 1024 * 1024,
  maxConcurrentBatches: 2,
} as const;

export type ModelScriptBatchItem = {
  nodeId: string;
  /** Appended after commonSource with a newline, in an independent scene execution. */
  source: string;
  expectedModelContentHash?: string;
  /** Replace the whole camera set; omission preserves it. */
  cameras?: ModelCamera[];
  /** Required when cameras is supplied; obtain from get_model_nodes. */
  expectedCamerasHash?: string;
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
  cameraCount: number;
  camerasHash: string;
};
/** Stored with the command in the same transaction, without source text. */
export type ModelScriptBatchMeta = {
  submissionHash: string;
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
        cameras: ModelCamera[];
        camerasHash: string;
        references: import("./domain/model-reference-inputs.js").ModelReferenceInput[];
      }>;
    };
