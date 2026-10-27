/**
 * 模型 MCP 服务：模型读取与列表
 * （自 `service.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R03）。
 *
 * 从**权威 Y.Doc** 派生模型节点上下文；不写任何状态。
 */
import type { CanvasRoom } from "../sync/index.js";
import type { CanvasNodeData, ModelContentVersion } from "@woohaa3/contracts";
import {
  readGroupAppearanceForNode,
  animationSnapshotHash,
  filmSetAnimationsOf,
  decodeFilmSetNodeData,
  decodeModelContentVersion,
  decodeModelPlacement,
  isFilmSetNode,
  isModelAuthoringNodeType,
  readModelCameras,
  resolveModelReferenceInputs
} from "@woohaa3/contracts";
import type { GetModelNodeInput, GetModelNodeOutcome, ListModelNodesOutcome, ModelNodeSummary } from "./service-types.js";

/** The scene camera remains addressable even when a legacy saved-camera collection exists. */
export function readAuthoringCameras(data: CanvasNodeData | undefined, nodeType: string) {
  const saved = readModelCameras(data);
  const scene = nodeType === "composite-asset" ? decodeFilmSetNodeData(data) : null;
  return scene?.ok ? [{ ...scene.value.sceneCamera, id: "scene-camera", name: "Scene camera", order: 0,
    elevation: scene.value.sceneCamera.elevation ?? 0, aspect: scene.value.sceneCamera.aspect ?? "16:9" },
    ...saved.filter(camera => camera.id !== "scene-camera")] : saved;
}

/** 读取片场节点的完整 items-only 定义与默认片段运行时视图。 */
export function readAnimationDefinition(
  data: CanvasNodeData | undefined
): NonNullable<Extract<GetModelNodeOutcome, { ok: true }>["animation"]> | undefined {
  const decoded = decodeFilmSetNodeData(data);
  if (!decoded.ok) return undefined;
  const animation = decoded.value;
  return {
    title: animation.title,
    sceneCamera: animation.sceneCamera,
    ...(animation.origin ? { origin: animation.origin } : {}),
    scenePlacement: animation.scenePlacement,
    filmSetContent: animation.filmSetContent,
    filmSetAnimations: filmSetAnimationsOf(animation),
    initialCamera: {
      azimuth: animation.camera.azimuth,
      elevation: animation.camera.elevation,
      distance: animation.camera.distance,
      aspect: animation.camera.aspect,
      focusOffset: animation.camera.focusOffset
    },
    timeline: animation.timeline
  };
}

/** 校验并读取本节点模型内容版本；缺失或非法时返回 null。 */
export function readModelContentVersion(input: unknown): ModelContentVersion | null {
  const decoded = decodeModelContentVersion(input);
  return decoded.ok ? decoded.value : null;
}

/** 读取 3D 节点当前的权威本地模型定义，供 MCP 在修改前获取上下文。 */
export async function getModelNode(
  resolveRoom: (canvasId: string) => Promise<CanvasRoom | null>,
  input: GetModelNodeInput,
  statistics?: (source: string, version: unknown) => Promise<
    | { ok: true; detail: import("./model-statistics.js").ModelStatisticsDetail }
    | { ok: false; code: string; message: string }
  >
): Promise<GetModelNodeOutcome> {
  const canvasId = input.canvasId?.trim() ?? "";
  const nodeId = input.nodeId?.trim() ?? "";
  if (canvasId === "") return { ok: false, code: "malformed-request", message: "canvasId 不能为空" };
  if (nodeId === "") return { ok: false, code: "malformed-request", message: "nodeId 不能为空" };

  const room = await resolveRoom(canvasId);
  if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${canvasId} 不存在` };
  const exported = room.exportCanvas();
  if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };
  const projected = projectModelNode(exported.canvas, nodeId, input.resource);
  if (!projected.ok || input.includeStatistics !== true || !statistics) return projected;
  if (projected.source.trim() === "") return projected;
  // 统计失败不把读取整体降级：节点内容仍可读，只是没有可引用的数字。
  const detail = await statistics(projected.source, projected.version);
  if (!detail.ok) return projected;
  return {
    ...projected,
    statistics: detail.detail.statistics,
    breakdown: detail.detail.breakdown
  };
}

/** Pure projection shared by single and batch reads of one authority snapshot. */
export function projectModelNode(canvas: import("@woohaa3/contracts").ServerCanvas, nodeId: string, resource?: "group-appearance"): GetModelNodeOutcome {
  const canvasId = canvas.id;
  const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
  if (!node) return { ok: false, code: "unknown-node", message: `节点 ${nodeId} 不存在` };
  if (resource === "group-appearance") {
    const data = canvas.nodeData[nodeId];
    if (node.type !== "group") return { ok: false, code: "invalid-node-type", message: "该节点没有组形象" };
    const appearance = readGroupAppearanceForNode(data);
    const model = appearance.value.model;
    return { ok: true, canvasId, nodeId, nodeType: node.type, resource, appearanceSource: appearance.source,
      ...(appearance.diagnostic ? { diagnostic: appearance.diagnostic } : {}), contentHash: model.contentVersion.contentHash,
      modelContentVersion: model.contentVersion, placement: model.placement, title: String(data?.title ?? "组形象"),
      prompt: "", source: model.modelScript, language: model.modelScriptLanguage, version: model.modelScriptVersion, references: [], cameras: [] };
  }
  if (!isModelAuthoringNodeType(node.type)) {
    return { ok: false, code: "invalid-node-type", message: `节点 ${nodeId} 不是模型节点，组形象必须显式指定 resource` };
  }

  const data = canvas.nodeData[nodeId] as CanvasNodeData | undefined;
  const references = resolveModelReferenceInputs(canvas, nodeId).references;
  const animation = readAnimationDefinition(data);
  const modelContentVersion = readModelContentVersion(data?.modelContentVersion);
  const placement = decodeModelPlacement(data?.modelPlacement);
  const decodedAnimation = isFilmSetNode(node.type, data) ? decodeFilmSetNodeData(data) : null;
  return {
    ok: true,
    canvasId,
    nodeId,
    nodeType: node.type,
    ...(modelContentVersion ? { modelContentVersion } : {}),
    ...(placement ? { placement } : {}),
    ...(decodedAnimation?.ok ? { snapshotHash: animationSnapshotHash(decodedAnimation.value) } : {}),
    title: typeof data?.title === "string" ? data.title : "模型",
    prompt: typeof data?.prompt === "string"
      ? data.prompt
      : typeof data?.panelPrompt === "string"
        ? data.panelPrompt
        : "",
    source: typeof data?.modelScript === "string" ? data.modelScript : "",
    ...(typeof data?.modelScriptLanguage === "string" ? { language: data.modelScriptLanguage } : {}),
    ...(typeof data?.modelScriptVersion === "string" ? { version: data.modelScriptVersion } : {}),
    ...(data?.modelScriptStatus ? { status: data.modelScriptStatus } : {}),
    ...(data?.modelScriptError !== undefined ? { error: data.modelScriptError } : {}),
    references,
    cameras: readAuthoringCameras(data, node.type),
    ...(animation ? { animation } : {})
  };
}

/**
 * 列出画布上的 3D 作者节点（change: replace-model-mcp-board-with-canvas-subscription）。
 */
export async function listModelNodes(
  resolveRoom: (canvasId: string) => Promise<CanvasRoom | null>,
  input: { canvasId?: string }
): Promise<ListModelNodesOutcome> {
  const canvasId = input.canvasId?.trim() ?? "";
  if (canvasId === "") return { ok: false, code: "malformed-request", message: "canvasId 不能为空" };
  const room = await resolveRoom(canvasId);
  if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${canvasId} 不存在` };
  const exported = room.exportCanvas();
  if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };

  const nodes: ModelNodeSummary[] = [];
  for (const node of exported.canvas.document.nodes) {
    if (!isModelAuthoringNodeType(node.type)) continue;
    const data = exported.canvas.nodeData[node.id] as CanvasNodeData | undefined;
    const hasScript = typeof data?.modelScript === "string" && data.modelScript !== "";
    const status = data?.modelScriptStatus;
    nodes.push({
      nodeId: node.id,
      nodeType: node.type,
      title: typeof data?.title === "string" ? data.title : "模型",
      prompt: typeof data?.prompt === "string"
        ? data.prompt
        : typeof data?.panelPrompt === "string"
          ? data.panelPrompt
          : "",
      references: resolveModelReferenceInputs(exported.canvas, node.id).references,
      hasScript,
      ...(status ? { status } : {}),
      pending: !hasScript || status === "failed",
      cameraCount: readAuthoringCameras(data, node.type).length
    });
  }
  return { ok: true, canvasId, nodes };
}
