/**
 * 非复合内容节点（模型脚本）的渲染身份判定
 * （自扩展 `preview-identity` 拆出，change: 2026-10-17-decouple-film-set-from-canvas-service）。
 *
 * 复合内容（片场等）的身份判定属于对应扩展的帧端口；这里只保留模型脚本节点的通用规则：
 * 源码哈希与 version/placement/scenePlacement 不变即视为同一快照。
 */
import { hashModelScript, type CanvasNodeData } from "@woohaa3/contracts";

export function modelPreviewIdentityMatches(before: CanvasNodeData | undefined, after: CanvasNodeData | undefined): boolean {
  const beforeSource = typeof before?.modelScript === "string" ? before.modelScript : "";
  const afterSource = typeof after?.modelScript === "string" ? after.modelScript : "";
  return (
    hashModelScript(beforeSource) === hashModelScript(afterSource) &&
    JSON.stringify([before?.extensionId, before?.modelScriptVersion, before?.modelPlacement, before?.scenePlacement]) ===
      JSON.stringify([after?.extensionId, after?.modelScriptVersion, after?.modelPlacement, after?.scenePlacement])
  );
}
