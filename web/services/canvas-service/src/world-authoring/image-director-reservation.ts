import { createHash } from "node:crypto";
import { canvasPointToGround, effectiveCanvasNodeSize, SHARED_WORLD_VERSION, stableStringify, type FrozenImageDirectorSource, type ImageDirectorSceneReservation, type ServerCanvas } from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import type { CanvasRoom } from "../sync/room.js";
import { imageDirectorOccupancy, planImageDirectorPlacement, type PreparedImageDirectorCandidate } from "./image-director-placement.js";

export function imageDirectorId(operationId: string, suffix: string): string {
  return `image-director:${operationId}:${suffix}`;
}

export function imageDirectorSourceGround(canvas: ServerCanvas, nodeId: string) {
  const nodes = new Map(canvas.document.nodes.map(node => [node.id, node]));
  const source = nodes.get(nodeId);
  if (!source || source.type !== "image" || !source.position) throw new Error("来源图片不存在");
  let x = source.position.x, y = source.position.y, parent = source.parentId;
  const seen = new Set([nodeId]);
  while (parent) {
    const node = nodes.get(parent);
    if (!node?.position || seen.has(parent)) throw new Error("来源图片的父节点无效");
    seen.add(parent); x += node.position.x; y += node.position.y; parent = node.parentId;
  }
  const size = effectiveCanvasNodeSize(source);
  return canvasPointToGround({ x: x + size.width / 2, y: y + size.height + 32 });
}

export async function reserveImageDirectorScene(room: CanvasRoom, input: { canvasId: string; operationId: string; requestId?: string; source: FrozenImageDirectorSource }, authorize: () => Promise<boolean>): Promise<ImageDirectorSceneReservation> {
  const commandId = `image-director-reserve:${input.operationId}`;
  const hash = createHash("sha256").update(stableStringify(input)).digest("hex");
  const result = await room.submitDerived({ commandId, expectedModelBatchHash: hash, async derive(canvas) {
    let origin;
    try { origin = imageDirectorSourceGround(canvas, input.source.sourceNodeId); }
    catch (error) { return { ok: false as const, code: "source-missing", message: error instanceof Error ? error.message : "来源图片不存在" }; }
    const shape: PreparedImageDirectorCandidate = { footprints: [{ min: { u: -1.5, v: -1.5 }, max: { u: 1.5, v: 1.5 } }], camera: { position: { u: 0, v: 0 } } };
    const placement = planImageDirectorPlacement(shape, await imageDirectorOccupancy(canvas), origin, "below-image");
    if (!placement) return { ok: false as const, code: "placement-unavailable", message: "无法确定导演区放置位置" };
    const reservation = { nodeId: imageDirectorId(input.operationId, "area"), areaId: imageDirectorId(input.operationId, "area-id"), scopeVersion: imageDirectorId(input.operationId, "reserved-scope"), bounds: { min: { ...placement.bounds.min }, max: { ...placement.bounds.max } } };
    const source = { operationId: input.operationId, sourceNodeId: input.source.sourceNodeId, assetId: input.source.assetId, contentVersion: input.source.contentVersion };
    return { ok: true as const, batch: { protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: input.canvasId, commandId, actorId: "image-director-scene", baseRevision: canvas.revision, commands: [{ type: "node.add" as const, node: { id: reservation.nodeId, type: "scene-area", position: { x: 0, y: 0 } }, nodeData: { title: "导演区 · 生成中", imageDirectorSource: source, sceneArea: { kind: "scene-area", version: SHARED_WORLD_VERSION, areaId: reservation.areaId, scopeVersion: reservation.scopeVersion, animationOrigin: { u: (reservation.bounds.min.u + reservation.bounds.max.u) / 2, v: (reservation.bounds.min.v + reservation.bounds.max.v) / 2 }, bounds: reservation.bounds } } }] }, modelBatch: { submissionHash: hash, nodes: [], imageDirectorReservation: reservation } };
  } }, { authorize });
  if (!result.ok) throw new Error(result.message);
  if (!result.modelBatch?.imageDirectorReservation) throw new Error("导演区创建回执不可用");
  return result.modelBatch.imageDirectorReservation;
}

export async function settleImageDirectorReservation(room: CanvasRoom, input: { canvasId: string; reservation: ImageDirectorSceneReservation; status: "failed" | "cancelled" }, authorize: () => Promise<boolean>): Promise<void> {
  const commandId = `image-director-${input.status}:${input.reservation.nodeId}`;
  const result = await room.submitDerived({ commandId, async derive(canvas) {
    const data = canvas.nodeData[input.reservation.nodeId];
    const area = data?.sceneArea as Record<string, unknown> | undefined;
    if (!area || area.areaId !== input.reservation.areaId || area.scopeVersion !== input.reservation.scopeVersion || data?.title !== "导演区 · 生成中") return { ok: false as const, code: "reservation-changed", message: "导演区已变化" };
    return { ok: true as const, batch: { protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: input.canvasId, commandId, actorId: "image-director-scene", baseRevision: canvas.revision, commands: [{ type: "nodeData.patch" as const, nodeId: input.reservation.nodeId, value: { title: input.status === "cancelled" ? "导演区 · 已停止" : "导演区 · 生成失败" } }] } };
  } }, { authorize });
  if (!result.ok && result.code !== "reservation-changed") throw new Error(result.message);
}
