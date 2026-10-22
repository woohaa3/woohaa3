/**
 * 扩展节点复制 Drop 分派（宿主，通用）
 * （change: 2026-10-10-add-game-furnace-extension，任务 4.3/4.4；
 *  change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D5：目标由 accepted
 *  Rust 查询固定，宿主不再用规范矩形自行复判）。
 *
 * 与「片场 drop」共用同一 `filmSetDrop` 分派点：拖动一批来源节点落在**通用纯模型扩展节点**
 * 范围内并释放时，把释放委托给该节点类型对应的 `canvas.node-drop` contribution。宿主只做
 * 通用目标裁决与 slot 分派，不 import 任何业务收集/项目实现；命令提交与幂等由 extension 自持。
 *
 * 目标 identity 由调用方先用 accepted `queryDropTarget` 固定（最上层实际节点、来源排除），本模块
 * 只按该 identity 裁决 owner 可用性与消费。查询不可用时消费为明确失败，**不**回退 TS 矩形几何。
 *
 * change: 2026-10-18-restrict-film-set-drop-to-models：新增可选 `acceptsSources`，只用于拖动提示
 * 是否点亮目标；释放裁决仍由 `onDrop` 独立完成。
 */
import { COMPOSITE_ASSET_NODE_TYPE, type ServerCanvas } from "@woohaa3/contracts";

/**
 * 一次 drop 解析结果：
 * - `null`：无扩展接收方命中（调用方继续后续裁决）；
 * - `{ handled: true }`：某扩展已消费（接受或明确拒绝）；
 * - `{ handled: true, feedback }`：预览阶段的可选反馈（仅供 dragover 展示）。
 */
export type NodeDropDispatch = { handled: boolean; feedback?: string | null };

/** 扩展接收方的最小接口（由宿主 slot 适配；避免耦合具体 registry 类型）。 */
export type NodeDropTarget = {
  dropLabel?: string;
  nodeType: string;
  matchesTarget?: (input: { canvas: ServerCanvas; targetNodeId: string }) => boolean;
  /**
   * 这批拖动来源是否会被该接收方接收（可选）。只影响拖动提示是否点亮目标；
   * 释放裁决仍只由 `onDrop` 完成，未实现时缺省视为接收。
   */
  acceptsSources?: (input: {
    canvas: ServerCanvas;
    targetNodeId: string;
    sourceNodeIds: readonly string[];
  }) => boolean;
  onDrop: (input: {
    canvas: ServerCanvas;
    targetNodeId: string;
    sourceNodeIds: readonly string[];
    point: { x: number; y: number };
  }) => boolean;
  onPreview?: (input: { canvas: ServerCanvas; targetNodeId: string; sourceNodeIds: readonly string[] }) => string | null;
};

/**
 * 已固定的 drop 目标解析（由宿主用 accepted `queryDropTarget` 派生）：
 * - `unavailable`：查询不可用/过期/缺能力，调用方 MUST NOT 提交移动或导入；
 * - `none`：查询成功但该点无节点，继续普通移动；
 * - `target`：命中的最上层实际节点 identity。
 */
export type DropTargetResolution =
  | { status: "unavailable"; reason: string }
  | { status: "none" }
  | { status: "target"; nodeId: string };

function matchingTargets(targets: readonly NodeDropTarget[], canvas: ServerCanvas, hit: { type: string; id: string }): NodeDropTarget[] {
  return targets.filter((target) => target.nodeType === hit.type
    && (!target.matchesTarget || target.matchesTarget({ canvas, targetNodeId: hit.id })));
}

/**
 * 这批来源是否会被该接收方接收（拖动提示用）。
 *
 * 未实现 `acceptsSources` 的贡献保持既有行为（视为接收）；谓词抛错时按「不接收」处理，
 * 避免把坏掉的扩展判定渲染成可接收提示。
 */
export function ownerAcceptsSources(
  owner: NodeDropTarget | undefined,
  canvas: ServerCanvas,
  targetNodeId: string,
  sourceNodeIds: readonly string[]
): boolean {
  if (!owner?.acceptsSources) return true;
  try { return owner.acceptsSources({ canvas, targetNodeId, sourceNodeIds }); }
  catch { return false; }
}

const unavailable = "此节点的素材接收方不可用，请检查扩展配置。";
const queryUnavailable = "拖入目标查询不可用，请稍后重试。";

function resolveTarget(targets: readonly NodeDropTarget[], canvas: ServerCanvas, resolution: DropTargetResolution) {
  // 查询失败与「范围外」严格区分：不可用时不返回 null，避免回退普通移动（design D5）。
  if (resolution.status === "unavailable") return { failed: true as const };
  if (resolution.status === "none") return null;
  const hit = canvas.document.nodes.find((node) => node.id === resolution.nodeId);
  if (!hit || (hit.type !== COMPOSITE_ASSET_NODE_TYPE && !targets.some(target => target.nodeType === hit.type))) return null;
  try { return { failed: false as const, hit, owners: matchingTargets(targets, canvas, hit) }; }
  catch { return { failed: false as const, hit, owners: [] as NodeDropTarget[] }; }
}

/** Disabled/unknown/ambiguous targets and unavailable queries consume the drop without moving sources. */
export function previewNodeDrop(targets: readonly NodeDropTarget[], canvas: ServerCanvas, sourceNodeIds: readonly string[], resolution: DropTargetResolution): string | null {
  const target = resolveTarget(targets, canvas, resolution);
  if (!target) return null;
  if (target.failed) return queryUnavailable;
  if (target.owners.length !== 1) return unavailable;
  try { return target.owners[0]!.onPreview?.({ canvas, targetNodeId: target.hit.id, sourceNodeIds }) ?? null; }
  catch { return unavailable; }
}

export function dropNodeDrop(targets: readonly NodeDropTarget[], canvas: ServerCanvas, sourceNodeIds: readonly string[], point: { x: number; y: number }, resolution: DropTargetResolution): boolean {
  const target = resolveTarget(targets, canvas, resolution);
  if (!target) return false;
  if (target.failed) return true;
  if (target.owners.length !== 1) return true;
  try { return target.owners[0]!.onDrop({ canvas, targetNodeId: target.hit.id, sourceNodeIds, point }) || target.hit.type === COMPOSITE_ASSET_NODE_TYPE; }
  catch { return true; }
}
