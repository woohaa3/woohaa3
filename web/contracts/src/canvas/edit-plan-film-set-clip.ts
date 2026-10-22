/**
 * 拍摄镜头净差异规划：源镜头定义 + 受影响预览的完整布局闭包
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 2.5 / design D3）。
 *
 * 从 `edit-plan-film-set.ts` 拆出以保持文件体积守卫。本模块只做：
 * - 比较 before/after 的每个片场节点的镜头集合，得出新增/删除/定义变化的镜头；
 * - 对新增/删除的镜头捕获**预览节点布局**（ID、位置、尺寸、parent、zIndex、归属 nodeData），
 *   使撤销删除能恢复原节点 ID/位置/尺寸，重做创建得到同一落点；预览的**移除**方向交给
 *   同批次的 reconciliation（受保护预览不能被普通 node-remove 直接删除）。
 *
 * 对象绑定差异只在**共享对象**上属于镜头定义变化；对象增删引起的绑定差异由对象级
 * restore/remove 承担，不在此重复记录（避免同一变化被两次回放）。所有镜头定义写入都走
 * 稳定 clipId + `film-set-clip-state` 并发前置条件，绝不整份回写客户端旧集合。
 */
import type { EditOperation, EditPrecondition } from "./edit-command.js";
import { decodeFilmSetNodeData, type FilmSetNodeData } from "./canvas-node-model.js";
import { isFilmSetNode } from "./domain/core/composite-asset-identity.js";
import { isShotPreviewNodeType, FILM_SET_SHOT_PREVIEW_NODE_TYPE } from "./domain/core/shot-preview-node.js";
import { absentFilmSetClipHash, filmSetClipStateHash } from "./film-set-clip-edit.js";
import { shotPreviewNodeId } from "./film-set-shot-preview.js";
import { filmSetAnimationsOf } from "./film-set-clip-view.js";
import type { FilmSetAnimationClip } from "./film-set-animations.js";
import type { CanvasNodeData, ServerCanvas, Woohaa3CanvasSerializedNode } from "./domain/index.js";

export type FilmSetClipPlanPiece = {
  forwardOps: EditOperation[];
  inverseOps: EditOperation[];
  forwardPre: EditPrecondition[];
  inversePre: EditPrecondition[];
};

/**
 * 镜头定义 + 预览布局闭包净差异规划。
 *
 * 逆操作里对象级操作先于镜头操作（对象恢复需先建立 item，镜头定义才能引用它）；正向同序，
 * 因此这里只产出镜头与预览相关操作，调用方负责把它们排在对象操作之后。
 */
export function planFilmSetClipDiffs(
  before: ServerCanvas,
  after: ServerCanvas,
  commonNodes: readonly Woohaa3CanvasSerializedNode[]
): FilmSetClipPlanPiece {
  const piece: FilmSetClipPlanPiece = { forwardOps: [], inverseOps: [], forwardPre: [], inversePre: [] };
  for (const node of commonNodes) {
    if (!isFilmSetNode(node.type, after.nodeData[node.id] ?? before.nodeData[node.id])) continue;
    const beforeAnimation = animationForPlan(before, node.id);
    const afterAnimation = animationForPlan(after, node.id);
    if (!beforeAnimation || !afterAnimation) continue;

    const beforeClips = filmSetAnimationsOf(beforeAnimation).clips;
    const afterClips = filmSetAnimationsOf(afterAnimation).clips;
    const beforeById = new Map(beforeClips.map((clip) => [clip.id, clip]));
    const afterById = new Map(afterClips.map((clip) => [clip.id, clip]));
    const sharedItems = new Set(
      beforeAnimation.filmSetContent.items.map((item) => item.id).filter((id) => afterAnimation.filmSetContent.items.some((item) => item.id === id))
    );
    const beforeDefault = filmSetAnimationsOf(beforeAnimation).defaultClipId;
    const afterDefault = filmSetAnimationsOf(afterAnimation).defaultClipId;
    let wroteDefaultForward = false;
    let wroteDefaultInverse = false;

    // 新增镜头（按 after 顺序）：写入定义与 after 默认，补齐确定性落点的预览节点。
    for (const clip of afterClips) {
      if (beforeById.has(clip.id)) continue;
      piece.forwardOps.push(clipSetOperation(node.id, clip, afterDefault));
      piece.forwardPre.push({ kind: "film-set-clip-state", nodeId: node.id, clipId: clip.id, clipHash: absentFilmSetClipHash() });
      wroteDefaultForward = true;
      pushPreviewAdd(piece.forwardOps, piece.forwardPre, after, node.id, clip.id);
      // 撤销新增：移除定义（预览由 reconciliation 同批清理）。
      piece.inverseOps.push({ kind: "film-set-clip-remove", nodeId: node.id, clipId: clip.id, defaultClipId: beforeDefault });
      piece.inversePre.push({ kind: "film-set-clip-state", nodeId: node.id, clipId: clip.id, clipHash: filmSetClipStateHash(afterAnimation, clip.id) });
      wroteDefaultInverse = true;
    }

    // 定义变化（重命名、类型转换、时间线/构图/动作、共享对象绑定）：整份镜头定义替换。
    for (const clip of afterClips) {
      const previous = beforeById.get(clip.id);
      if (!previous) continue;
      if (!clipDefinitionChanged(previous, clip, sharedItems)) continue;
      piece.forwardOps.push(clipSetOperation(node.id, clip, afterDefault));
      piece.forwardPre.push({ kind: "film-set-clip-state", nodeId: node.id, clipId: clip.id, clipHash: filmSetClipStateHash(beforeAnimation, clip.id) });
      piece.inverseOps.push(clipSetOperation(node.id, previous, beforeDefault));
      piece.inversePre.push({ kind: "film-set-clip-state", nodeId: node.id, clipId: clip.id, clipHash: filmSetClipStateHash(afterAnimation, clip.id) });
      wroteDefaultForward = true;
      wroteDefaultInverse = true;
    }

    // 删除镜头（按 before 顺序）：前向移除定义并保护预览归属；逆向恢复定义 + 原预览布局。
    for (const clip of beforeClips) {
      if (afterById.has(clip.id)) continue;
      piece.forwardOps.push({ kind: "film-set-clip-remove", nodeId: node.id, clipId: clip.id, defaultClipId: afterDefault });
      piece.forwardPre.push({ kind: "film-set-clip-state", nodeId: node.id, clipId: clip.id, clipHash: filmSetClipStateHash(beforeAnimation, clip.id) });
      const preview = existingPreview(before, node.id, clip.id);
      if (preview) piece.forwardPre.push({ kind: "film-set-shot-preview-state", previewNodeId: preview.id, filmSetNodeId: node.id, clipId: clip.id });
      piece.inverseOps.push(clipSetOperation(node.id, clip, beforeDefault));
      piece.inversePre.push({ kind: "film-set-clip-state", nodeId: node.id, clipId: clip.id, clipHash: absentFilmSetClipHash() });
      pushPreviewAdd(piece.inverseOps, piece.inversePre, before, node.id, clip.id);
      wroteDefaultForward = true;
      wroteDefaultInverse = true;
    }

    // 仅默认镜头切换（无镜头定义变化）：写回新默认镜头所在镜头的既有定义以携带默认。
    if (beforeDefault !== afterDefault) {
      if (!wroteDefaultForward && afterDefault) {
        const clip = afterById.get(afterDefault);
        if (clip) {
          piece.forwardOps.push(clipSetOperation(node.id, clip, afterDefault));
          piece.forwardPre.push({ kind: "film-set-clip-state", nodeId: node.id, clipId: clip.id, clipHash: filmSetClipStateHash(beforeAnimation, clip.id) });
        }
      }
      if (!wroteDefaultInverse && beforeDefault) {
        const clip = beforeById.get(beforeDefault);
        if (clip) {
          piece.inverseOps.push(clipSetOperation(node.id, clip, beforeDefault));
          piece.inversePre.push({ kind: "film-set-clip-state", nodeId: node.id, clipId: clip.id, clipHash: filmSetClipStateHash(afterAnimation, clip.id) });
        }
      }
    }
  }
  return piece;
}

function clipSetOperation(nodeId: string, clip: FilmSetAnimationClip, defaultClipId: string | null): Extract<EditOperation, { kind: "film-set-clip-set" }> {
  return { kind: "film-set-clip-set", nodeId, clipId: clip.id, clip: cloneClip(clip), defaultClipId };
}

/** 捕获某个镜头预览在给定画布中的确定落点并追加 node-add（含前置条件）。 */
function pushPreviewAdd(
  operations: EditOperation[],
  preconditions: EditPrecondition[],
  layoutSource: ServerCanvas,
  filmSetNodeId: string,
  clipId: string
): void {
  const previewId = shotPreviewNodeId(filmSetNodeId, clipId);
  const node = layoutSource.document.nodes.find((entry) => entry.id === previewId && isShotPreviewNodeType(entry.type));
  if (!node) return;
  const nodeData = layoutSource.nodeData[previewId] as CanvasNodeData | undefined;
  operations.push({
    kind: "node-add",
    node: {
      id: node.id,
      type: FILM_SET_SHOT_PREVIEW_NODE_TYPE,
      position: { ...node.position },
      ...(node.width !== undefined ? { width: node.width } : {}),
      ...(node.height !== undefined ? { height: node.height } : {}),
      ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
      ...(node.zIndex !== undefined ? { zIndex: node.zIndex } : {})
    },
    ...(nodeData && Object.keys(nodeData).length > 0 ? { nodeData } : {})
  });
  preconditions.push({ kind: "node-missing", nodeId: previewId });
  preconditions.push({ kind: "no-active-run", nodeIds: [previewId] });
}

/** 读取画布中某个既有预览节点（用于删除镜头前保护归属与布局）。 */
function existingPreview(canvas: ServerCanvas, filmSetNodeId: string, clipId: string) {
  const previewId = shotPreviewNodeId(filmSetNodeId, clipId);
  return canvas.document.nodes.find((entry) => entry.id === previewId && isShotPreviewNodeType(entry.type));
}

/**
 * 镜头定义（除对象增删引起的绑定外）是否发生净变化。
 *
 * 共享对象绑定变化属于镜头定义；对象增删的绑定差异由对象级 restore/remove 承担。
 */
function clipDefinitionChanged(previous: FilmSetAnimationClip, next: FilmSetAnimationClip, sharedItems: ReadonlySet<string>): boolean {
  const view = (clip: FilmSetAnimationClip) =>
    JSON.stringify({ ...stripBindings(clip), bindings: clip.bindings.filter((binding) => sharedItems.has(binding.itemId)) });
  return view(previous) !== view(next);
}

function stripBindings(clip: FilmSetAnimationClip): Omit<FilmSetAnimationClip, "bindings"> {
  const { bindings: _bindings, ...rest } = clip;
  return rest;
}

function cloneClip(clip: FilmSetAnimationClip): FilmSetAnimationClip {
  return JSON.parse(JSON.stringify(clip)) as FilmSetAnimationClip;
}

function animationForPlan(canvas: ServerCanvas, nodeId: string): FilmSetNodeData | null {
  const decoded = decodeFilmSetNodeData(canvas.nodeData[nodeId] as CanvasNodeData | undefined);
  return decoded.ok ? decoded.value : null;
}
