/**
 * 服务端 canvas room：类型定义
 * （自 `room.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R27）。
 */
import type { ServerCanvas } from "@woohaa3/contracts";
import type { ModelScriptBatchMeta, CanvasScriptSubmissionMeta } from "@woohaa3/contracts";
import type { MediaStorage } from "@woohaa3/contracts";
import type { YjsDocumentRepository } from "./yjs-repository.js";

export type RoomSubmitOptions = {
  spatialContext?: import("../world-authoring/spatial-leases.js").SpatialWriteContext;
  signal?: AbortSignal;
  /**
   * 每画布访问屏障的 write 复核（change: 2026-10-13-add-enterprise-access-and-production-deployment，
   * 任务 4.5/6.2/6.3）。
   *
   * **在 room 串行队列内**、应用与持久 commit **之前**调用（`executeCommand` 内联执行，不额外排队）。
   * 返回 false 即拒绝该命令且不产生新 revision/不广播；撤 write 与 commit 因此通过同一队列排序，
   * 检查与持久之间没有无保护授权窗口。缺省不注入（历史行为不变）。
   */
  authorize?: () => Promise<boolean>;
  /**
   * Canvas script 首次提交元数据（change: 2026-10-13-add-canvas-script-authoring）。
   *
   * 由脚本提交路径在 `executeDerived` 中从 derive 结果附加；与画布 update 同事务持久化，
   * noop 也保存，只含 digest/版本/refs/首次摘要，绝不含源码。
   */
  script?: CanvasScriptSubmissionMeta;
  modelBatch?: ModelScriptBatchMeta;
  /** Immutable scene-area authority receipt (T06) persisted with the command. */
  worldAuthoring?: import("@woohaa3/contracts").WorldAuthoringCommandReceipt;
};

export type RoomCommandResult =
  | {
      ok: true;
      status: "accepted" | "duplicate";
      commandId: string;
      /** 事务后的业务 revision。 */
      revision: number;
      /** 是否为 no-op（有效命令但无净变化）。 */
      noop: boolean;
      /** accepted 且有净变化时，分发给 room 客户端的 update。 */
      update: Uint8Array | null;
      /**
       * Canvas script 首次提交元数据（change: 2026-10-13-add-canvas-script-authoring）。
       *
       * 只有脚本提交路径会带；duplicate 时是**冻结的首次值**（不是从当前画布重建）。
       * 只含 digest/版本/refs/首次摘要，绝不含源码。
       */
      script?: CanvasScriptSubmissionMeta;
      modelBatch?: ModelScriptBatchMeta;
      /** Frozen scene-area authority receipt; duplicate returns the first value. */
      worldAuthoring?: import("@woohaa3/contracts").WorldAuthoringCommandReceipt;
      /** duplicate 时标记该回执来自 durable 首次记录。 */
      duplicate?: boolean;
    }
  | {
      ok: false;
      status: "rejected" | "failed";
      commandId: string;
      code: string;
      message: string;
      retryable?: boolean;
      currentRevision?: number;
      preconditionIndex?: number;
      conflict?: import("../world-authoring/spatial-leases.js").LeaseConflict;
      spatialReason?: string;
    };

/** published 前进的来源：本 room 执行的命令，或从远端同步上游合入的 update。 */
export type RoomUpdateOrigin = "command" | "upstream";

/**
 * room 广播回调：由 WebSocket 层注入。只有 durable 成功后才会被调用。
 *
 * `room` 只用 `canvasId` 定位目标；用结构化类型避免与 `CanvasRoom` 类形成类型环。
 */
export type RoomBroadcast = (input: {
  room: { canvasId: string };
  update: Uint8Array;
  revision: number;
  origin: RoomUpdateOrigin;
}) => void;

export type ExternalUpdateResult =
  | { ok: true; changed: boolean; revision: number }
  | { ok: false; code: string; message: string };

export type CanvasRoomState =
  | "loading"
  | "ready"
  /** 加载/校验失败：不可写，保留诊断，等待人工介入（spec「损坏隔离」）。 */
  | "quarantined";

export type CanvasRoomOptions = {
  content?: import("@woohaa3/contracts").ContentContributionResolver;
  lifecycle?: import("@woohaa3/contracts").ManagedNodeLifecycleResolver;
  canvasId: string;
  repository: YjsDocumentRepository;
  mediaStorage?: MediaStorage;
  now?: () => string;
  /** 由 WebSocket 层注入；用于把 durable update 广播给该 room 的所有客户端。 */
  broadcast?: RoomBroadcast;
  /** 资产引用校验开关（运行时必须开）。 */
  verifyAssets?: boolean;
  /**
   * 新画布 bootstrap：Yjs 文档不存在时，返回该 canvas 的规范聚合作为初始 checkpoint。
   *
   * 返回 `null` 表示该 canvas 在结构化存储中也不存在——此时不创建文档，room 保持
   * `not-found` 隔离。只有 `not-found`（文档不存在）会触发；文档存在但损坏一律隔离，
   * 绝不用空文档覆盖。
   */
  bootstrap?: () => Promise<ServerCanvas | null>;
  /**
   * 远端同步上游的完整 Yjs 状态；本地文档不存在时先于 `bootstrap` 尝试。
   * 返回 `null` 表示上游没有该画布或不可达，继续走 `bootstrap`。
   */
  seedFromUpstream?: () => Promise<Uint8Array | null>;
  /** room epoch 生成器（测试用确定性实现）；默认随机。 */
  generateRoomEpoch?: () => string;
  /**
   * 命令提交 durable 成功后的观察者（change: 模型编辑历史）。
   *
   * 用于在 `modelPlacement` patch 落地后留档一条历史版本；回调在提交之后、广播之前
   * 调用，失败不影响命令结果。接收提交后的完整聚合与命令列表。
   */
  onCommitted?: (input: { canvas: ServerCanvas; commands: readonly unknown[] }) => void;
  /**
   * 命令 durable 且产生净变化后的 revision delta 观察者
   * （change: add-agent-canvas-authoring-mcp，任务 3.4）。
   *
   * 供有界增量日志记录 before/after；只在实际推进 revision 时调用，失败不影响命令结果。
   */
  onDelta?: (input: { before: ServerCanvas; after: ServerCanvas }) => void;
  /**
   * 存储 sequence 冲突后自动重载 room 的观察者
   * （change: 2026-10-29-recover-storage-seq-conflict）。
   *
   * 每次尝试重载调用一次；`recovered=false` 表示存储读取失败或文档已不可用（room 被隔离）。
   * 只用于诊断日志，不影响恢复流程本身。
   */
  onStorageSeqRecovered?: (input: { canvasId: string; attempt: number; recovered: boolean }) => void;
};
