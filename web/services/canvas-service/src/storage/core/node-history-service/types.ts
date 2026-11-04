/**
 * 节点生成历史服务：共享端口、输入与上下文
 * （自 `node-history-service.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R02）。
 *
 * 只承载类型与共享上下文；无状态、无副作用。恢复、登记、查询与容量协作者都接受同一
 * `NodeHistoryServiceContext`，从而保持同一 repository/room/verifier 与唯一恢复 owner。
 */
import type {
  ContentContributionResolver,
  MediaStorageScope,
  ModelCamera,
  ModelScriptBatchMeta,
  NodeGenerationKind,
  NodeHistoryModelPlacement,
  NodeHistoryOutcome,
  ServerCanvas,
  StoredAsset
} from "@woohaa3/contracts";
import type { CanvasCommand } from "@woohaa3/contracts";
import type { NodeHistoryRepository } from "../node-history-contracts.js";

/**
 * 版本化命令批次的结构形状（与 wire 的 `CanvasCommandBatch` 同构）。
 *
 * core 不得 import `@woohaa3/contracts/canvas-yjs`（依赖边界只允许主入口）；room 端的
 * 具体批次类型结构兼容，由 composition 适配。
 */
export type NodeHistoryCommandBatch = {
  protocolVersion: number;
  canvasId: string;
  commandId: string;
  baseRevision: number;
  actorId: string;
  commands: CanvasCommand[];
};

/**
 * 派生提交结果（`submitDerived` 命中的既有回执或新提交结论）。
 *
 * 与 `CanvasRoom.submitDerived` 的返回保持结构兼容；历史模块只消费 revision/status。
 */
export type NodeHistoryDerivedResult =
  | { ok: true; status: "accepted" | "duplicate"; revision: number; noop: boolean }
  | { ok: false; code: string; message: string };

/**
 * 只读/提交 room 的最小端口（避免 core 反向依赖 sync 模块）。
 * 由 composition 用真实 `CanvasRoom` 适配。
 */
export type NodeHistoryRoomPort = {
  lookupCommand?: (commandId: string) => Promise<{
    revision: number;
    /** 冻结的提交元数据；合并用它携带请求摘要做「同身份不同参数」判定。 */
    modelBatch?: { submissionHash: string };
  } | null>;
  exportCanvas(): { ok: true; canvas: ServerCanvas } | { ok: false; message: string };
  submit(batch: NodeHistoryCommandBatch): Promise<
    | { ok: true; status: "accepted" | "duplicate"; revision: number; noop: boolean }
    | { ok: false; code: string; message: string }
  >;
  /**
   * 串行「读改写」提交（change: 2026-10-27-merge-same-type-node-history，design D5/D7）。
   *
   * 在 room 队列内先查 durable 回执（命中即幂等），否则按**最新权威画布**派生命令批次。
   * 缺省时调用方回退到 `exportCanvas` + `submit`（测试/最小端口）。
   */
  submitDerived?: (input: {
    commandId: string;
    expectedModelBatchHash?: string;
    derive: (canvas: ServerCanvas) =>
      | {
          ok: true;
          batch: NodeHistoryCommandBatch;
          modelBatch?: ModelScriptBatchMeta;
        }
      | { ok: false; code: string; message: string }
      | Promise<
          | {
              ok: true;
              batch: NodeHistoryCommandBatch;
              modelBatch?: ModelScriptBatchMeta;
            }
          | { ok: false; code: string; message: string }
        >;
  }) => Promise<NodeHistoryDerivedResult>;
};

export type NodeHistoryRestoreOutcome =
  | { ok: true; revision: number; entryId: string; alreadyCurrent: boolean }
  | { ok: false; code: string; message: string };

export type RegisterTaskHistoryInput = {
  canvasId: string;
  nodeId: string;
  runId: string;
  /** Task worker key（通常等于 runId）；写入 source.taskKey 供溯源（change: l0-generation-provenance）。 */
  taskKey?: string;
  /** 该次执行使用的模型身份（Task 记录的 modelKey）；写入 source.modelId。 */
  modelKey?: string;
  jobId?: string;
  kind: "text" | "image" | "video" | "audio";
  createdAt: string;
  output:
    | { mediaKind: "text"; text: string }
    | {
        mediaKind: "image" | "video" | "audio";
        asset: StoredAsset;
        posterAsset?: StoredAsset;
        durationSeconds?: number;
      };
};

export type RegisterModelHistoryInput = {
  canvasId: string;
  nodeId: string;
  sourceHash: string;
  modelScript: string;
  language: string;
  version: string;
  createdAt: string;
  /** 登记时节点的显式摆放（有则纳入「当前」identity，避免同脚本多版本全中）。 */
  placement?: NodeHistoryModelPlacement;
};

/**
 * 失败/取消/中断归档输入
 * （change: 2026-10-12-unify-generation-history-strip，design D3）。
 */
export type RegisterTaskFailureInput = {
  canvasId: string;
  nodeId: string;
  runId: string;
  /** Task worker key（通常等于 runId）；写入 source.taskKey。 */
  taskKey?: string;
  /** 该次执行使用的模型身份（Task 记录的 modelKey）；写入 source.modelId。 */
  modelKey?: string;
  jobId?: string;
  kind: NodeGenerationKind;
  outcome: Exclude<NodeHistoryOutcome, "succeeded">;
  message: string;
  code?: string;
  createdAt: string;
  /** 提交时基线内容引用（用于“恢复执行前内容”）。 */
  baseline?: {
    identity: string;
    nodeType: string;
    entryId?: string;
    outputAssetId?: string;
  };
  /** 安全输入摘要（有界）。 */
  inputSummary: string;
};

/**
 * 「回退/恢复」留档输入（change: 模型编辑历史）。
 */
export type RegisterModelEditInput = {
  canvasId: string;
  nodeId: string;
  sourceHash: string;
  modelScript: string;
  language: string;
  version: string;
  placement: NodeHistoryModelPlacement;
  createdAt: string;
  modelCameras?: ModelCamera[];
};

export type NodeHistoryServiceContext = {
  repository: NodeHistoryRepository;
  resolveRoom: (canvasId: string) => Promise<NodeHistoryRoomPort | null>;
  mediaVerifier?: { exists(storageKey: string, scope?: MediaStorageScope): Promise<boolean> };
  /** 已激活的内容 codec。缺省时片场组历史仍走内核解码。 */
  content?: ContentContributionResolver;
  log: (event: Record<string, unknown>) => void;
  now: () => string;
};

export type NodeHistoryApplicationServiceOptions = {
  repository: NodeHistoryRepository;
  resolveRoom: (canvasId: string) => Promise<NodeHistoryRoomPort | null>;
  /** 媒体对象校验（可选；缺失时不做远端存在性检查）。 */
  mediaVerifier?: { exists(storageKey: string, scope?: MediaStorageScope): Promise<boolean> };
  logger?: (event: Record<string, unknown>) => void;
  /** 时间源（测试可注入）；缺省系统时钟。 */
  now?: () => string;
  /** 与画布命令同一份内容注册表。传入后片场组历史只信 owner codec。 */
  content?: ContentContributionResolver;
  /**
   * 是否存在未结算的编辑会话（prepared 回执）。
   *
   * 清空历史必须拒绝：删掉归档义务会让正在进行的会话最终无法结算。
   * 未注入时视为无会话（独立单元/测试）。
   */
  hasActiveEditSession?: (canvasId: string, nodeId: string) => Promise<boolean>;
};

/** 用户显式清空某节点历史的输入。 */
export type ClearNodeHistoryInput = {
  canvasId: string;
  nodeId: string;
};

export type NodeHistoryClearOutcome =
  | { ok: true; removed: number }
  | { ok: false; code: string; message: string };

/** 同类型节点合并输入（change: 2026-10-27-merge-same-type-node-history）。 */
export type MergeNodeHistoryInput = {
  canvasId: string;
  targetNodeId: string;
  sourceNodeId: string;
  operationId: string;
  /** 调用方看到的来源当前内容身份；不一致即 conflict。 */
  expectedSourceCurrentIdentity?: string;
  /** 调用方看到的目标当前内容身份；不一致即 conflict。 */
  expectedTargetCurrentIdentity?: string;
};

/** 合并结果（成功携带稳定计数与修订）。 */
export type MergeNodeHistoryOutcome =
  | {
      ok: true;
      targetNodeId: string;
      sourceNodeId: string;
      revision: number;
      copied: number;
      duplicates: number;
      evicted: number;
      alreadyMerged: boolean;
    }
  | { ok: false; code: string; message: string };
