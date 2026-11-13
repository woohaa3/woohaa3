import { createHash } from "node:crypto";
import { stableStringify, type ImageDirectorSceneReceipt } from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import type { CanvasRoom } from "../sync/room.js";

export type FinalizeInput = {
  canvasId: string;
  operationId: string;
  commandId: string;
  reservation: { nodeId: string; areaId: string; scopeVersion: string; bounds: { min: { u: number; v: number }; max: { u: number; v: number } } };
  source: ImageDirectorSceneReceipt["source"];
  beforeNodeIds: readonly string[];
};

const failure = (code: string, message: string) => ({ ok: false as const, code, message });

/** Trusted host entry: finalize the reserved director area after scene tools wrote models/cameras. */
export async function finalizeImageDirectorScene(room: CanvasRoom, input: FinalizeInput, options: { authorize: () => Promise<boolean>; signal?: AbortSignal }) {
  const hash = createHash("sha256").update(stableStringify(input)).digest("hex");
  const result = await room.submitDerived({ commandId: input.commandId, expectedModelBatchHash: hash, async derive(canvas) {
    if (options.signal?.aborted) return failure("cancelled", "提交已取消");
    const areaNode = canvas.document.nodes.find(node => node.id === input.reservation.nodeId);
    const data = canvas.nodeData[input.reservation.nodeId] as Record<string, unknown> | undefined;
    const area = data?.sceneArea as Record<string, unknown> | undefined;
    const provenance = { operationId: input.operationId, sourceNodeId: input.source.sourceNodeId, assetId: input.source.assetId, contentVersion: input.source.contentVersion };
    if (!areaNode || areaNode.type !== "scene-area" || !area || area.areaId !== input.reservation.areaId || area.scopeVersion !== input.reservation.scopeVersion || stableStringify(data?.imageDirectorSource) !== stableStringify(provenance)) return failure("reservation-conflict", "生成中的导演区已被修改或删除");
    const before = new Set(input.beforeNodeIds);
    const created = canvas.document.nodes.filter(node => !before.has(node.id));
    const modelNodeIds = created.filter(node => node.type === "model3d").map(node => node.id);
    if (modelNodeIds.length === 0) return failure("scene-empty", "导演区尚未创建任何模型");
    const cameraNodeId = created.find(node => node.type === "world-camera")?.id;
    const receipt: ImageDirectorSceneReceipt = { operationId: input.operationId, source: input.source, areaNodeId: input.reservation.nodeId, modelNodeIds, ...(cameraNodeId ? { cameraNodeId } : {}) };
    const { imageDirectorGeneration: _generation, ...rest } = data ?? {} as Record<string, unknown>;
    const commands = [{ type: "nodeData.patch" as const, nodeId: input.reservation.nodeId, value: { ...rest, title: "导演区" } }];
    return { ok: true as const, batch: { protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: input.canvasId, commandId: input.commandId, actorId: "image-director-scene", baseRevision: canvas.revision, commands }, modelBatch: { submissionHash: hash, nodes: [], imageDirectorScene: receipt } };
  } }, options);
  if (!result.ok) return result;
  const receipt = result.modelBatch?.imageDirectorScene;
  return receipt ? { ok: true as const, receipt, revision: result.revision, duplicate: result.status === "duplicate" } : failure("receipt-unavailable", "提交回执不可用");
}

export async function lookupImageDirectorScene(room: CanvasRoom, commandId: string, authorize: () => Promise<boolean>) {
  if (!await authorize()) return failure("read-forbidden", "无权读取该画布");
  const record = await room.lookupCommand(commandId);
  return record?.modelBatch?.imageDirectorScene ? { ok: true as const, receipt: record.modelBatch.imageDirectorScene, revision: record.revision } : failure("receipt-not-found", "未找到提交回执");
}
