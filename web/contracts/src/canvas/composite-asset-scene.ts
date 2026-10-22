/** Apply the common asset root once, without changing authored model source or part identities. */
import { decodeFilmSetLocalTransform } from "./film-set-content.js";
import type { SceneV2Op } from "./scene-ir-v2.js";
export function compositeAssetSceneOps(ops: readonly SceneV2Op[], scenePlacement: unknown): SceneV2Op[] {
  const decoded = decodeFilmSetLocalTransform(scenePlacement);
  if (!decoded.ok) throw new Error(`复合资产根变换非法：${decoded.reason}`);
  const root = decoded.value;
  if (root.scale === 1 && root.yaw === 0 && root.offset.x === 0 && root.offset.y === 0 && root.offset.z === 0) return [...ops];
  const rootId = "\u0000composite-asset";
  if (ops.some(op => "id" in op && op.id === rootId)) throw new Error("模型部件占用复合资产保留根身份");
  return [{ t: "group", id: rootId, parent: null, material: null, color: null, position: [root.offset.x, root.offset.y, root.offset.z], rotation: [0, root.yaw * 180 / Math.PI, 0], scale: [root.scale, root.scale, root.scale] }, ...ops.map(op => "parent" in op && op.parent ? op : "id" in op && op.t !== "material" ? { ...op, parent: rootId } : op)] as SceneV2Op[];
}
