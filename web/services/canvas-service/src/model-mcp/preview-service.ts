import { isFilmSetGroupNode } from "@woohaa3/contracts";
/** Authority lookup and generic native rendering orchestration. 内容扩展的规则经端口注入，宿主不 import 其实现。 */
import { compositeAssetSceneOps, v2SceneExtent, decodeModelPlacement, hashModelScript, isFilmSetNode, isModelAuthoringNodeType, type CanvasNodeData } from "@woohaa3/contracts";
import { modelPreviewIdentityMatches } from "./content-identity.js";
import { RENDER_VERSION, renderCacheKey, type RendererSceneRequest } from "../model-renderer/index.js";
import { executeSceneIr, normalizeCaptureOptions } from "./script-executor.js";
import type { ModelMcpServiceDependencies, RenderPreviewInput, RenderPreviewOutcome, RenderPreviewMetadata } from "./service-types.js";

export async function renderPreview(
  deps: ModelMcpServiceDependencies,
  renderCache: NonNullable<ModelMcpServiceDependencies["renderCache"]> | ReturnType<typeof import("../model-renderer/index.js").createRenderCache>,
  input: RenderPreviewInput
): Promise<RenderPreviewOutcome> {
  const canvasId = input.canvasId?.trim() ?? "", nodeId = input.nodeId?.trim() ?? "";
  if (!canvasId || !nodeId) return { ok: false, code: "malformed-request", message: "canvasId 和 nodeId 不能为空" };
  const normalized = normalizeCaptureOptions({ ...(input.width !== undefined ? { width: input.width } : {}), ...(input.height !== undefined ? { height: input.height } : {}), ...(input.background !== undefined ? { background: input.background } : {}), ...(input.cameraPreset !== undefined ? { cameraPreset: input.cameraPreset } : {}) });
  if (!normalized.ok) return normalized;
  const room = await deps.resolveRoom(canvasId);
  if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${canvasId} 不存在` };
  const exported = room.exportCanvas();
  if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };
  const node = exported.canvas.document.nodes.find(entry => entry.id === nodeId);
  if (!node) return { ok: false, code: "unknown-node", message: `节点 ${nodeId} 不存在` };
  if (isFilmSetGroupNode(node, exported.canvas.nodeData[nodeId]) && !deps.contentFrames?.matches(node.type, exported.canvas.nodeData[nodeId])) return { ok: false, code: "content-runtime-unavailable", message: "片场内容预览能力未装配" };
  if (!isModelAuthoringNodeType(node.type) && !deps.contentFrames?.matches(node.type, exported.canvas.nodeData[nodeId])) return { ok: false, code: "invalid-node-type", message: `节点 ${nodeId} 不是可预览的模型节点` };
  const data = exported.canvas.nodeData[nodeId] as CanvasNodeData | undefined;
  const timeSeconds = input.timeSeconds ?? 0;
  if (!Number.isFinite(timeSeconds) || timeSeconds < 0) return { ok: false, code: "malformed-request", message: "timeSeconds 必须是非负有限数值" };
  let capture = normalized.options;
  let sourceHash: string;
  let cacheSourceHash: string;
  let animationIdentity: string | undefined;
  let actualClipId: string | undefined;
  let animationMetadata: Pick<RenderPreviewMetadata, "animation"> = {};
  let scene: Omit<RendererSceneRequest, "requestId" | "capture">;
  const contentFrames = deps.contentFrames;
  const contentAdapter = contentFrames && contentFrames.matches(node.type, data) ? contentFrames : undefined;
  if (contentAdapter) {
    // 把本次预览的画布 id 绑定进读取端口：素材读取必须落在该画布的存储作用域，否则远端画布
    // 的素材会去主存储找而不存在（内容扩展只按 storageKey 调 `read`）。
    const readMedia = deps.readMedia;
    const prepared = await contentAdapter.preparePreviewFrame({ nodeId, node, data, canvas: exported.canvas, assets: exported.canvas.assets, ...(input.clipId !== undefined ? { clipId: input.clipId } : {}), timeSeconds, ...(readMedia ? { read: (storageKey: string) => readMedia(storageKey, canvasId) } : {}) });
    if (!prepared.ok) return prepared;
    sourceHash = prepared.sourceHash; cacheSourceHash = sourceHash; animationIdentity = prepared.animationIdentity; actualClipId = prepared.clipId;
    animationMetadata = prepared.metadata; scene = prepared.scene;
    if (input.cameraPreset === undefined) capture = { ...capture, cameraPreset: "initial" };
  } else if (isFilmSetNode(node.type, data)) {
    return { ok: false, code: "content-runtime-unavailable", message: "复合内容预览能力不可用（未装配内容扩展）" };
  } else {
    const source = typeof data?.modelScript === "string" ? data.modelScript : "";
    if (!source.trim()) return { ok: false, code: "no-source", message: "节点没有可预览的 modelScript" };
    if (timeSeconds !== 0 || capture.cameraPreset === "initial") return { ok: false, code: "malformed-request", message: "静态节点不支持动画采样或 initial camera preset" };
    const execution = await executeSceneIr(source, data?.modelScriptVersion, deps.scriptExecutor ?? {});
    if (!execution.ok) return { ok: false, code: `model-script-${execution.stage}`, message: execution.message };
    sourceHash = hashModelScript(source);
    const placement = decodeModelPlacement(data?.modelPlacement);
    const ops = node.type === "composite-asset" ? compositeAssetSceneOps(execution.ops, data?.scenePlacement) : execution.ops;
    cacheSourceHash = hashModelScript(JSON.stringify({ sourceHash, placement, scenePlacement: node.type === "composite-asset" ? data?.scenePlacement : undefined }));
    scene = { sceneVersion: execution.sceneVersion, signature: hashModelScript(JSON.stringify({ version: execution.sceneVersion, ops })), extent: v2SceneExtent(ops), ops: ops as unknown[], ...(placement ? { placement: { offset: [placement.offset.x, placement.offset.y, placement.offset.z], scale: placement.scale, yaw: placement.yaw } } : {}) };
  }
  const cacheKey = renderCacheKey({ sourceHash: cacheSourceHash, sceneVersion: scene.sceneVersion, renderVersion: RENDER_VERSION, capture, ...(animationIdentity ? { animationIdentity, timeSeconds } : {}) });
  const metadata = (renderVersion: string, width: number, height: number, sceneSignature: string): RenderPreviewMetadata => ({ canvasId, nodeId, sourceHash, sceneSignature, sceneVersion: scene.sceneVersion, renderVersion, width, height, background: capture.background, cameraPreset: capture.cameraPreset, ...animationMetadata });
  const cached = renderCache.get(cacheKey);
  if (cached) return { ok: true, cached: true, pngBase64: cached.png.toString("base64"), metadata: metadata(cached.renderVersion, cached.width, cached.height, cached.sceneSignature) };
  if (!deps.rendererClient) return { ok: false, code: "renderer-unavailable", message: "未配置可用的原生 model renderer" };
  const rendered = await deps.rendererClient.render({ ...scene, requestId: `${nodeId}:${sourceHash}${animationIdentity ? `:${animationIdentity}:${timeSeconds}` : ""}`, capture });
  if (!rendered.ok) return rendered;
  const latest = room.exportCanvas();
  const latestNode = latest.ok ? latest.canvas.document.nodes.find(entry => entry.id === nodeId) : undefined;
  const latestData = latest.ok ? (latest.canvas.nodeData[nodeId] as CanvasNodeData | undefined) : undefined;
  const identityMatches = contentAdapter ? contentAdapter.identityMatches(data, latestData, actualClipId, exported.canvas, latest.ok ? latest.canvas : undefined) : modelPreviewIdentityMatches(data, latestData);
  if (!latest.ok || latestNode?.type !== node.type || !identityMatches) return { ok: false, code: "stale-source", message: "渲染期间权威定义已变化，请重新请求预览" };
  renderCache.set(cacheKey, { png: rendered.png, width: capture.width, height: capture.height, sceneSignature: scene.signature, renderVersion: rendered.renderVersion });
  return { ok: true, cached: false, pngBase64: rendered.png.toString("base64"), metadata: metadata(rendered.renderVersion, capture.width, capture.height, scene.signature) };
}
