/**
 * 模型 MCP 服务：镜头单条/批量读写
 * （自 `service.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R03）。
 *
 * `submitDerived` 在 room 串行队列内先查回执（重试幂等），否则按**最新权威集合**应用纯函数
 * 变更并提交完整 `nodeData.patch`。
 */
import type { CanvasNodeData } from "@woohaa3/contracts";
import {
  applyModelCameraMutationBatch,
  applyModelCameraMutationCommand,
  isModelAuthoringNodeType,
  readModelCameras, decodeFilmSetNodeData
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION, type CanvasCommandBatch } from "@woohaa3/contracts/canvas-yjs";
import { readAuthoringCameras } from "./model-reader.js";
import type {
  ModelMcpServiceDependencies,
  MutateCamerasBatchInput,
  MutateCamerasBatchOutcome,
  MutateCamerasInput,
  MutateCamerasOutcome
} from "./service-types.js";

/** 单条镜头读改写（change: add-model-camera-mcp-crud）。 */
export async function mutateCameras(
  deps: ModelMcpServiceDependencies,
  actorId: string,
  input: MutateCamerasInput
): Promise<MutateCamerasOutcome> {
  const canvasId = input.canvasId?.trim() ?? "";
  const nodeId = input.nodeId?.trim() ?? "";
  const requestId = input.requestId?.trim() ?? "";
  if (canvasId === "") return { ok: false, code: "malformed-request", message: "canvasId 不能为空" };
  if (nodeId === "") return { ok: false, code: "malformed-request", message: "nodeId 不能为空" };
  if (requestId === "") return { ok: false, code: "malformed-request", message: "requestId 不能为空" };

  const room = await deps.resolveRoom(canvasId);
  if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${canvasId} 不存在` };

  const commandId = `model-camera:${canvasId}:${nodeId}:${requestId}`;
  const result = await room.submitDerived({
    commandId,
    derive: (canvas) => {
      const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
      if (!node) return { ok: false, code: "unknown-node", message: `节点 ${nodeId} 不存在` };
      if (!isModelAuthoringNodeType(node.type)) return { ok: false, code: "invalid-node-type", message: `节点 ${nodeId} 不是模型节点` };
      const data = canvas.nodeData[nodeId] as CanvasNodeData | undefined;
      const scene = node.type === "composite-asset" ? decodeFilmSetNodeData(data) : null;
      const sceneOnly = scene?.ok && [input.mutation].some(m => m.kind !== "create" && m.id === "scene-camera");
      if (sceneOnly && [input.mutation].some(m => m.kind === "create" || m.id !== "scene-camera" || !["update", "reset"].includes(m.kind))) return { ok: false, code: "unknown-camera", message: "Only the selected scene camera may be updated" };
      const current = sceneOnly && scene?.ok ? [{ ...scene.value.sceneCamera, id: "scene-camera", name: "Scene camera", order: 0, elevation: scene.value.sceneCamera.elevation ?? 0, aspect: scene.value.sceneCamera.aspect ?? "16:9" }] : readModelCameras(data);
      const applied = applyModelCameraMutationCommand(current, input.mutation, {
        nodeId,
        seed: `${nodeId}:${requestId}`
      });
      if (!applied.ok) return { ok: false, code: applied.code, message: applied.message };
      const batch: CanvasCommandBatch = {
        protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
        canvasId,
        commandId,
        baseRevision: canvas.revision,
        actorId,
        commands: [{ type: "nodeData.patch", nodeId, value: (sceneOnly ? { sceneCamera: { azimuth: applied.cameras[0]!.azimuth, elevation: applied.cameras[0]!.elevation, distance: applied.cameras[0]!.distance, aspect: applied.cameras[0]!.aspect, ...(applied.cameras[0]!.focusOffset ? { focusOffset: applied.cameras[0]!.focusOffset } : {}) } } : { modelCameras: applied.cameras }) as CanvasNodeData }]
      };
      return { ok: true, batch };
    }
  });
  if (!result.ok) return { ok: false, code: result.code, message: result.message };

  const latest = room.exportCanvas();
  const cameras = latest.ok
    ? input.mutation.kind !== "create" && input.mutation.id === "scene-camera"
      ? readAuthoringCameras(latest.canvas.nodeData[nodeId] as CanvasNodeData | undefined, "composite-asset")
      : readModelCameras(latest.canvas.nodeData[nodeId] as CanvasNodeData | undefined)
    : [];
  return {
    ok: true,
    canvasId,
    nodeId,
    commandId,
    duplicate: result.status === "duplicate",
    noop: result.noop,
    cameras
  };
}

/** 批量镜头读改写（change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 4.4）。 */
export async function mutateCamerasBatch(
  deps: ModelMcpServiceDependencies,
  actorId: string,
  input: MutateCamerasBatchInput
): Promise<MutateCamerasBatchOutcome> {
  const canvasId = input.canvasId?.trim() ?? "";
  const nodeId = input.nodeId?.trim() ?? "";
  const requestId = input.requestId?.trim() ?? "";
  if (canvasId === "") return { ok: false, code: "malformed-request", message: "canvasId 不能为空" };
  if (nodeId === "") return { ok: false, code: "malformed-request", message: "nodeId 不能为空" };
  if (requestId === "") return { ok: false, code: "malformed-request", message: "requestId 不能为空" };
  if (!Array.isArray(input.mutations) || input.mutations.length === 0) {
    return { ok: false, code: "malformed-request", message: "mutations 必须是非空数组" };
  }

  const room = await deps.resolveRoom(canvasId);
  if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${canvasId} 不存在` };

  const commandId = `model-camera-batch:${canvasId}:${nodeId}:${requestId}`;
  const result = await room.submitDerived({
    commandId,
    derive: (canvas) => {
      const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
      if (!node) return { ok: false, code: "unknown-node", message: `节点 ${nodeId} 不存在` };
      if (!isModelAuthoringNodeType(node.type)) return { ok: false, code: "invalid-node-type", message: `节点 ${nodeId} 不是模型节点` };
      const data = canvas.nodeData[nodeId] as CanvasNodeData | undefined;
      const scene = node.type === "composite-asset" ? decodeFilmSetNodeData(data) : null;
      const sceneOnly = scene?.ok && input.mutations.some(m => m.kind !== "create" && m.id === "scene-camera");
      if (sceneOnly && input.mutations.some(m => m.kind === "create" || m.id !== "scene-camera" || !["update", "reset"].includes(m.kind))) return { ok: false, code: "unknown-camera", message: "Only the selected scene camera may be updated" };
      const current = sceneOnly && scene?.ok ? [{ ...scene.value.sceneCamera, id: "scene-camera", name: "Scene camera", order: 0, elevation: scene.value.sceneCamera.elevation ?? 0, aspect: scene.value.sceneCamera.aspect ?? "16:9" }] : readModelCameras(data);
      const applied = applyModelCameraMutationBatch(current, input.mutations, {
        nodeId,
        seed: `${nodeId}:${requestId}`
      });
      if (!applied.ok) {
        return {
          ok: false,
          code: applied.code,
          message: applied.failedIndex >= 0 ? `${applied.message}（第 ${applied.failedIndex + 1} 条）` : applied.message
        };
      }
      const batch: CanvasCommandBatch = {
        protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
        canvasId,
        commandId,
        baseRevision: canvas.revision,
        actorId,
        commands: [{ type: "nodeData.patch", nodeId, value: (sceneOnly ? { sceneCamera: { azimuth: applied.cameras[0]!.azimuth, elevation: applied.cameras[0]!.elevation, distance: applied.cameras[0]!.distance, aspect: applied.cameras[0]!.aspect, ...(applied.cameras[0]!.focusOffset ? { focusOffset: applied.cameras[0]!.focusOffset } : {}) } } : { modelCameras: applied.cameras }) as CanvasNodeData }]
      };
      return { ok: true, batch };
    }
  });
  if (!result.ok) return { ok: false, code: result.code, message: result.message };

  const latest = room.exportCanvas();
  const cameras = latest.ok
    ? input.mutations.some(mutation => mutation.kind !== "create" && mutation.id === "scene-camera")
      ? readAuthoringCameras(latest.canvas.nodeData[nodeId] as CanvasNodeData | undefined, "composite-asset")
      : readModelCameras(latest.canvas.nodeData[nodeId] as CanvasNodeData | undefined)
    : [];
  return {
    ok: true,
    canvasId,
    nodeId,
    commandId,
    duplicate: result.status === "duplicate",
    noop: result.noop,
    cameras
  };
}
