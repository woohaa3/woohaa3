/**
 * 受保护语义编辑 `edit.apply` 的**类型与边界**（change:
 * 2026-10-09-improve-canvas-workflow，任务 1.1 / design D5.2；2026-10-15 拆出以守住 500 行门禁）。
 *
 * 从 `edit-command.ts` 拆出，保持原公开路径不变（`edit-command.ts` 继续 re-export）。
 * 本模块只有类型与常量，无运行时依赖，是解码模块与命令模块的共同底座。
 *
 * 设计约束（与原模块一致）：
 * - 条件与操作用**结构化联合类型**表达，而非任意 JSON path；
 * - 有界、不可递归（`edit.apply` 不得嵌套 `edit.apply`）；
 * - `set` / `unset` 精确恢复合法字段，明确区分「字段不存在」与「null」；
 * - 条件针对「受保护编辑开始前」的规范状态检查，全部通过才执行内部操作，内部任一失败整批失败。
 */
import type { CanvasNodeData, Woohaa3CanvasJsonObject } from "./domain/index.js";

/** `edit.apply` 的硬上限；两端解码与 reducer 按同一份数值校验。 */
export const EDIT_APPLY_LIMITS = {
  /** 单次操作数上限。 */
  maxOperations: 256,
  /** 单次前置条件数上限。 */
  maxPreconditions: 256,
  /** 前置条件引用的节点数上限（delete 保护、恢复集合）。 */
  maxReferencedNodes: 512,
  /** 前置条件引用的边 ID 数上限。 */
  maxReferencedEdges: 512,
  /** 单条 edit.apply 的序列化 JSON 字节上限。 */
  maxPayloadBytes: 256 * 1024
} as const;

/** 可被 `edit.apply` 修改的节点结构字段白名单。 */
export const EDIT_NODE_FIELDS = ["position", "width", "height", "zIndex"] as const;
export type EditNodeField = (typeof EDIT_NODE_FIELDS)[number];

/**
 * 节点业务字段（nodeData）白名单。
 *
 * 仅允许名称与稳定项目关联，精确恢复字段缺失；不拥有任务进度或其它业务数据。
 * 结构化字段（prompt/parameters/taskStatus 等）由各自权威路径管理，撤销不得回退。
 */
export const EDIT_NODE_DATA_FIELDS = ["title", "projectStorageKey", "inputHash", "activeBuildId"] as const;
export type EditNodeDataField = (typeof EDIT_NODE_DATA_FIELDS)[number];

/** 字段快照：明确区分「不存在」与「null」。 */
export type EditFieldSnapshot =
  | { present: false }
  | { present: true; value: unknown };

export type EditNodeFieldSnapshot = { field: EditNodeField } & EditFieldSnapshot;
export type EditNodeDataFieldSnapshot = { field: EditNodeDataField } & EditFieldSnapshot;

/**
 * 结构化前置条件联合。所有条件都针对受保护编辑开始前的规范状态判定。
 */
export type EditPrecondition =
  /** 节点必须存在。 */
  | { kind: "node-exists"; nodeId: string }
  /** 节点必须不存在（恢复/创建撤销用）。 */
  | { kind: "node-missing"; nodeId: string }
  /** 节点结构字段必须等于快照（缺省字段按 present:false 精确匹配）。 */
  | { kind: "node-fields"; nodeId: string; fields: readonly EditNodeFieldSnapshot[] }
  /** 节点业务字段必须等于快照（精确区分缺省与 null）。 */
  | { kind: "node-data-fields"; nodeId: string; fields: readonly EditNodeDataFieldSnapshot[] }
  /** 关联边 ID 集合必须完全匹配（按稳定 edgeId）。 */
  | { kind: "incident-edge-ids"; nodeId: string; edgeIds: readonly string[] }
  /** 指定边必须不存在（恢复边）。 */
  | { kind: "edge-missing"; edgeId: string }
  /** 指定边必须存在（删除边/创建撤销）。 */
  | { kind: "edge-present"; edgeId: string }
  /** 画布标题必须匹配（撤销画布重命名）。 */
  | { kind: "canvas-title-equals"; title: string }
  /** 目标或级联范围内的节点都没有进行中任务。 */
  | { kind: "no-active-run"; nodeIds: readonly string[] }
  /** 指定资产必须存在且 ready（恢复引用检查）。 */
  | { kind: "asset-ready"; assetId: string }
  /** 草稿恢复引用的资产集合都必须存在（不要求 ready，缺失即拒绝整批）。 */
  | { kind: "assets-present"; assetIds: readonly string[] };

/**
 * 白名单编辑操作。刻意复用既有 node/edge 结构语义，不含 asset/job/嵌套 edit.apply。
 */
export type EditOperation =
  | { kind: "extension.edit"; extensionId: string; nodeId: string; op: unknown }
  | {
      kind: "node-add";
      node: {
        id: string;
        type: string;
        position: { x: number; y: number };
        width?: number;
        height?: number;
        zIndex?: number;
      };
      nodeData?: CanvasNodeData;
    }
  | {
      kind: "node-update";
      nodeId: string;
      position?: { x: number; y: number };
      width?: number;
      height?: number;
      zIndex?: number;
    }
  | { kind: "node-remove"; nodeIds: readonly string[] }
  | {
      kind: "edge-add";
      edge: {
        id: string;
        source: string;
        target: string;
        sourceHandle?: string | null;
        targetHandle?: string | null;
        data?: Woohaa3CanvasJsonObject;
      };
    }
  | { kind: "edge-remove"; edgeId: string }
  /** 合并写入业务字段（与 nodeData.patch 同语义）。 */
  | { kind: "node-data-set"; nodeId: string; value: CanvasNodeData }
  /** 精确移除业务字段（恢复「原本不存在」的状态）。 */
  | { kind: "node-data-unset"; nodeId: string; fields: readonly EditNodeDataField[] }
  /** 画布标题（撤销画布重命名）。 */
  | { kind: "canvas-title-set"; title: string };

export type EditApplyCommand = {
  type: "edit.apply";
  preconditions: readonly EditPrecondition[];
  operations: readonly EditOperation[];
};
