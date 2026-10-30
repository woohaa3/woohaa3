/**
 * 片场 owner 的交互与呈现归属声明（change: 2026-10-28-generic-extension-content-ownership，任务 4.2）。
 *
 * 宿主只按注册表询问，不再从 `shotPreview` 字段或 `film-set` 字面量猜测 hover、双击与选择保护。
 */
import {
  FILM_SET_SHOT_PREVIEW_NODE_TYPE,
  isCompositeAssetNodeType,
  readFilmSetGroupMarker,
  shotPreviewOwnershipOf,
  type ContentInteractionPolicy
} from "@woohaa3/contracts";

function ownershipOf(data: unknown) {
  return shotPreviewOwnershipOf(data);
}

export const filmSetInteractionPolicy: ContentInteractionPolicy = {
  isManagedNode(type, data) {
    if (type === "group" && readFilmSetGroupMarker(data) !== null) return true;
    return type === FILM_SET_SHOT_PREVIEW_NODE_TYPE && ownershipOf(data) !== null;
  },
  selectionActions(action, type, data) {
    if (isCompositeAssetNodeType(type)) return { allowed: false, reason: "旧 composite 片场只读；请先迁移为 film-set group" };
    if (type !== FILM_SET_SHOT_PREVIEW_NODE_TYPE || !ownershipOf(data)) return { allowed: true };
    if (action === "delete") return { allowed: false, reason: "拍摄镜头预览需在拍摄镜头管理中删除" };
    if (action === "copy" || action === "cut") return { allowed: false, reason: "拍摄镜头预览不能单独复制或剪切；复制所属片场会一并复制其镜头" };
    return { allowed: false, reason: "拍摄镜头预览属于源镜头，不能单独操作" };
  },
  hoverPlaybackTarget(type, data) {
    if (type !== FILM_SET_SHOT_PREVIEW_NODE_TYPE) return null;
    const ownership = ownershipOf(data);
    return ownership ? { ownerNodeId: ownership.filmSetNodeId, entityId: ownership.clipId } : null;
  },
  doubleClickTarget(type, data) {
    if (type !== FILM_SET_SHOT_PREVIEW_NODE_TYPE) return null;
    const ownership = ownershipOf(data);
    return ownership ? { kind: "shot-preview", nodeId: ownership.filmSetNodeId, entityId: ownership.clipId } : null;
  }
};
