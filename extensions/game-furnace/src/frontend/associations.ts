/**
 * 游戏炼丹炉节点关联字段（纯读写）
 * （change: 2026-10-10-add-game-furnace-extension，按 integration 新架构重实现）。
 *
 * 炼丹炉节点是**通用**纯模型扩展节点（`extension3d`）：它的 `nodeData` 只保存稳定关联
 * （`projectStorageKey` / `inputHash` / `activeBuildId`），项目内容本体保存在后端内容寻址对象
 * 里。本模块只做纯校验/读取/构造 patch，不 import 宿主 store、DOM 或 Node API。
 */
import type { CanvasNodeData } from "@woohaa3/contracts";
import { COMPOSITE_ASSET_NODE_TYPE } from "@woohaa3/contracts";
import { GAME_FURNACE_PLUGIN_ID } from "../shared/types.js";

/** 节点上保存的项目关联（全部可选；缺省表示尚未初始化）。 */
export type GameFurnaceAssociation = {
  projectStorageKey?: string;
  inputHash?: string;
  activeBuildId?: string;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** 从 nodeData 读取关联；非法/缺失字段忽略（不猜、不补）。 */
export function readGameFurnaceAssociation(data: CanvasNodeData | undefined): GameFurnaceAssociation {
  const record = (data ?? {}) as Record<string, unknown>;
  const association: GameFurnaceAssociation = {};
  const projectStorageKey = readString(record.projectStorageKey);
  const inputHash = readString(record.inputHash);
  const activeBuildId = readString(record.activeBuildId);
  if (projectStorageKey) association.projectStorageKey = projectStorageKey;
  if (inputHash) association.inputHash = inputHash;
  if (activeBuildId) association.activeBuildId = activeBuildId;
  return association;
}

/**
 * 构造 `nodeData.patch` 值：保留既有 `modelScript` 等通用字段，只覆盖提供关联字段。
 *
 * `undefined` 的字段不写入（不删除既有值）；`null` 显式清除。
 */
export function gameFurnaceAssociationPatch(
  data: CanvasNodeData | undefined,
  next: Partial<Record<keyof GameFurnaceAssociation, string | null>>
): Record<string, unknown> {
  const patch: Record<string, unknown> = { ...((data ?? {}) as Record<string, unknown>) };
  for (const key of ["projectStorageKey", "inputHash", "activeBuildId"] as const) {
    if (!(key in next)) continue;
    const value = next[key];
    if (value === null) delete patch[key];
    else if (typeof value === "string" && value.trim() !== "") patch[key] = value;
  }
  return patch;
}

/** 关联是否已具备可打开的项目（有 storageKey）。 */
export function hasOpenableProject(association: GameFurnaceAssociation): boolean {
  return typeof association.projectStorageKey === "string";
}

/**
 * 严格业务身份：复合资产节点 + 节点数据声明本扩展。
 *
 * change: 2026-10-11-extract-film-set-extension（frontend-plugin-runtime spec）：同一公共类别
 * type 可承载多个业务，宿主/业务 MUST NOT 按 type 或注册顺序猜 owner。这里按**当前**持久化事实
 * （`composite-asset` + `nodeData.extensionId === "game-furnace"`）自校验（D1 复合资产节点、
 * D11 共享 type + 必填 extensionId）。
 *
 * 不使用模型源码相等做后备识别（生产禁用脚本探测；旧缺身份节点只在离线 reader 分类）。
 */
export function isGameFurnaceNode(
  canvas: { document: { nodes: readonly { id: string; type: string }[] }; nodeData: Record<string, unknown> } | null,
  nodeId: string | null | undefined
): boolean {
  if (!canvas || !nodeId) return false;
  const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
  if (node?.type !== COMPOSITE_ASSET_NODE_TYPE) return false;
  const data = (canvas.nodeData[nodeId] ?? {}) as Record<string, unknown>;
  return data.extensionId === GAME_FURNACE_PLUGIN_ID;
}
