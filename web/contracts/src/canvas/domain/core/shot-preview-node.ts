/**
 * 拍摄镜头预览节点的中立身份原语
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，D2）。
 *
 * 叶子模块：不 import 任何画布契约，供 domain 规范化、连接规则与上层预览契约共用**同一份**
 * 类型判别与 ID 前缀常量，避免 `domain` → 业务模块的循环依赖。
 *
 * 预览节点是内部类型，不在普通「新建节点」菜单暴露；其稳定身份与归属闭包见
 * `canvas/film-set-shot-preview.ts`（codec、SHA-256 身份与布局纯函数）。
 */
import { managedNodeRelationOf } from "../../managed-node.js";

export const FILM_SET_SHOT_PREVIEW_NODE_TYPE = "film-set-shot-preview" as const;

/** 稳定节点 ID 前缀（`shot-preview:` + 完整 SHA-256 的 base64url，固定 43 字符）。 */
export const SHOT_PREVIEW_ID_PREFIX = "shot-preview:" as const;

/** 身份摘要输入的规范前缀（版本化元组首元素；一旦发布不得更改）。 */
export const SHOT_PREVIEW_IDENTITY_PREFIX = "film-set-shot-preview-v1" as const;

/** 32 字节摘要的 base64url（无填充）编码长度：固定 43。 */
export const SHOT_PREVIEW_ID_ENCODED_LENGTH = 43;

/** 是否为拍摄镜头预览节点类型（只按 canonical type 判别，不看归属数据）。 */
export function isShotPreviewNodeType(type: string | undefined): boolean {
  return type === FILM_SET_SHOT_PREVIEW_NODE_TYPE;
}

/** Canonical media retains shot reference semantics after the legacy type upgrade. */
export function isShotPreviewNode(type: string | undefined, data: unknown): boolean {
  return isShotPreviewNodeType(type)
    || ((type === "image" || type === "video") && managedNodeRelationOf(data)?.extensionId === "film-set");
}

/** 是否为本画布中合法形态的预览节点 ID（前缀 + 固定长度 base64url）。 */
export function isShotPreviewNodeIdShape(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith(SHOT_PREVIEW_ID_PREFIX)) return false;
  const encoded = value.slice(SHOT_PREVIEW_ID_PREFIX.length);
  return encoded.length === SHOT_PREVIEW_ID_ENCODED_LENGTH && /^[A-Za-z0-9_-]+$/.test(encoded);
}
