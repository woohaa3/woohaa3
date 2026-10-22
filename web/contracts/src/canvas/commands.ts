/**
 * 画布命令模型（任务 2.2 / design D3）。
 *
 * 正常写入只走命令：HTTP 的 command endpoint、离线 outbox 重放、未来 Yjs 语义写入都
 * 复用同一套命令。完整画布 replace 只保留给 create / 运维 import / 测试 fixture。
 *
 * 每个命令都是纯 JSON 且带 `type` 判别字段；`canvasId` / `expectedRevision` /
 * `operationId` / `actorId` 由批次（`CanvasCommandBatch`）承载，命令本身不重复携带。
 */
import type { CanvasNodeData, StoredAsset, StoredJob, Woohaa3CanvasJsonObject, Woohaa3CanvasNode } from "./domain/index.js";
import { isFilmSetClipPatchOp, type FilmSetClipPatchOp } from "./film-set-clip-ops.js";

/** 创建节点时可一次性连一条来自已有节点的边（「拉线创建」）。 */
export type CanvasNodeConnectInput = {
  fromNodeId: string;
  label?: string;
  /**
   * 新边的客户端稳定 ID（change: add-frontend-speculative-canvas-state，design D7）。
   * 与服务端共享 reducer 的语义：缺失时回退到本地生成值，但正常编辑器必须显式提供，
   * 以保证本地 working projection 与服务端生成同一实体。
   */
  edgeId?: string;
};

import { isEditApplyCommand, type EditApplyCommand } from "./edit-command.js";
import type {
  FilmSetLocalTransform
} from "./film-set-content.js";

/**
 * 片场对象级权威操作（change: 2026-10-09-add-film-set-object-motion-and-editing，任务 2.3；
 * change: 2026-10-11-extract-film-set-extension，D8/D10 —— items-only）。
 *
 * 固定 `nodeId` / `itemId`，reducer 从**最新权威集合**读取对应 item 后原子更新，绝不用客户端
 * 旧完整数组覆盖其他项，也不按数组序号定位。items 只保存几何与基础变换：对象动作/播放配置
 * 一律通过 `filmSet.clipPatch` 的 binding 表达，故这里只有 transform / delete。
 */
export type FilmSetItemPatchOp =
  | { kind: "transform"; localTransform: FilmSetLocalTransform; expectedLocalTransform?: FilmSetLocalTransform }
  | { kind: "delete" };

export type CanvasCommand =
  | EditApplyCommand
  | { type: "canvas.setTitle"; title: string }
  | {
      type: "node.add";
      node: Pick<Woohaa3CanvasNode, "id" | "type" | "position"> & Partial<Pick<Woohaa3CanvasNode, "width" | "height" | "parentId" | "zIndex">>;
      nodeData?: CanvasNodeData;
      connect?: CanvasNodeConnectInput;
    }
  | {
      type: "node.update";
      nodeId: string;
      position?: { x: number; y: number };
      width?: number;
      height?: number;
      parentId?: string | null;
      zIndex?: number;
    }
  | { type: "node.remove"; nodeIds: readonly string[] }
  /** `value: null` 等价于删除该 nodeData 键。 */
  | { type: "nodeData.patch"; nodeId: string; value: CanvasNodeData | null }
  /** 片场对象级权威更新；`nodeId` 必须是 `animation3d`。 */
  | { type: "filmSet.itemPatch"; nodeId: string; itemId: string; op: FilmSetItemPatchOp }
  | { type: "filmSet.clipPatch"; nodeId: string; clipId: string; expectedHash: string; op: FilmSetClipPatchOp }
  | {
      type: "edge.add";
      edge: {
        id?: string;
        source: string;
        target: string;
        sourceHandle?: string | null;
        targetHandle?: string | null;
        data?: Woohaa3CanvasJsonObject;
      };
    }
  | { type: "edge.remove"; edgeId: string }
  /** 新增或整体替换一个资产（按 id upsert）。 */
  | { type: "asset.upsert"; asset: StoredAsset }
  | { type: "asset.remove"; assetId: string }
  | { type: "job.upsert"; job: StoredJob }
  | { type: "job.remove"; jobId: string };

export type CanvasCommandType = CanvasCommand["type"];

export const CANVAS_COMMAND_TYPES: readonly CanvasCommandType[] = [
  "edit.apply",
  "canvas.setTitle",
  "node.add",
  "node.update",
  "node.remove",
  "nodeData.patch",
  "filmSet.itemPatch",
  "filmSet.clipPatch",
  "edge.add",
  "edge.remove",
  "asset.upsert",
  "asset.remove",
  "job.upsert",
  "job.remove"
];

/** 版本化命令批次的编解码信封（未来 wire 契约可复用）。 */
export type CanvasCommandBatch = {
  canvasId: string;
  expectedRevision: number;
  operationId: string;
  actorId: string;
  commands: CanvasCommand[];
};

export type CanvasCommandBatchDecodeResult =
  | { ok: true; batch: CanvasCommandBatch }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 校验命令的**结构**（判别字段、必填字段类型）。
 *
 * 这里只做「是不是一条格式正确的命令」，不判断它能不能作用在当前画布上——后者是
 * 命令应用器的引用完整性职责，需要看到画布才能判断。
 */
export function isCanvasCommand(value: unknown): value is CanvasCommand {
  if (!isRecord(value)) return false;
  const type = value.type;
  switch (type) {
    case "edit.apply": return isEditApplyCommand(value);
    case "canvas.setTitle":
      return typeof value.title === "string";
    case "node.add":
      return isNodeAdd(value);
    case "node.update":
      return isNonEmptyString(value.nodeId);
    case "node.remove":
      return Array.isArray(value.nodeIds) && value.nodeIds.every(isNonEmptyString);
    case "nodeData.patch":
      return isNonEmptyString(value.nodeId)
        && (value.value === null || isRecord(value.value));
    case "filmSet.itemPatch":
      return isNonEmptyString(value.nodeId)
        && isNonEmptyString(value.itemId)
        && isRecord(value.op)
        && typeof value.op.kind === "string";
    case "filmSet.clipPatch":
      return isNonEmptyString(value.nodeId) && isNonEmptyString(value.clipId)
        && isNonEmptyString(value.expectedHash) && isFilmSetClipPatchOp(value.op);
    case "edge.add":
      return isRecord(value.edge)
        && isNonEmptyString(value.edge.source)
        && isNonEmptyString(value.edge.target);
    case "edge.remove":
      return isNonEmptyString(value.edgeId);
    case "asset.upsert":
      return isRecord(value.asset) && isNonEmptyString(value.asset.id);
    case "asset.remove":
      return isNonEmptyString(value.assetId);
    case "job.upsert":
      return isRecord(value.job) && isNonEmptyString(value.job.id);
    case "job.remove":
      return isNonEmptyString(value.jobId);
    default:
      return false;
  }
}

/** 解码不受信任的批次输入（HTTP body / outbox 记录）。 */
export function decodeCanvasCommandBatch(input: unknown): CanvasCommandBatchDecodeResult {
  if (!isRecord(input)) return { ok: false, reason: "批次必须是对象" };
  const { canvasId, expectedRevision, operationId, actorId, commands } = input;
  if (!isNonEmptyString(canvasId)) return { ok: false, reason: "canvasId 缺失或非法" };
  if (!Number.isInteger(expectedRevision) || (expectedRevision as number) < 0) {
    return { ok: false, reason: "expectedRevision 必须是非负整数" };
  }
  if (!isNonEmptyString(operationId)) return { ok: false, reason: "operationId 缺失或非法" };
  if (!isNonEmptyString(actorId)) return { ok: false, reason: "actorId 缺失或非法" };
  if (!Array.isArray(commands) || commands.length === 0) {
    return { ok: false, reason: "commands 必须是非空数组" };
  }
  const invalidIndex = commands.findIndex((command) => !isCanvasCommand(command));
  if (invalidIndex >= 0) return { ok: false, reason: `第 ${invalidIndex} 条命令格式非法` };
  return {
    ok: true,
    batch: {
      canvasId,
      expectedRevision: expectedRevision as number,
      operationId,
      actorId,
      commands: commands as CanvasCommand[]
    }
  };
}

function isNodeAdd(value: Record<string, unknown>): boolean {
  const node = value.node;
  if (!isRecord(node)) return false;
  if (!isNonEmptyString(node.id) || !isNonEmptyString(node.type)) return false;
  if (!isRecord(node.position)) return false;
  if (typeof node.position.x !== "number" || typeof node.position.y !== "number") return false;
  if (value.connect !== undefined) {
    if (!isRecord(value.connect) || !isNonEmptyString(value.connect.fromNodeId)) return false;
    // edgeId 可选（迁移窗口），但提供时必须是合法字符串。
    if (value.connect.edgeId !== undefined && !isNonEmptyString(value.connect.edgeId)) return false;
  }
  return true;
}
