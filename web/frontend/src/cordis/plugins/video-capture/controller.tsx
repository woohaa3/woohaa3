/**
 * 视频编辑入口控制器
 * （change: port-video-editing-dialogs，任务 4.1–4.3；design D2/D9）。
 *
 * 把两个 dialog 的注册、打开实例跟踪、帧导入与 intent 提交接到 Task Execution Plugin scope：
 * - 只从**当前 canonical ready video mapping** 解析稳定视频身份（design D2/D9）；
 * - 打开/confirm 只经 Dialog Service + Media Remote + Canvas Session；
 * - dispose 撤销 renderer registrations、listeners、打开的实例与 session 记录。
 *
 * 不持有全局 modal manager；不做 DOM 级 Escape/焦点管理（由 Dialog Host 统一拥有）。
 */
import type { CanvasNodeData, ServerCanvas, VideoEditIntent } from "@woohaa3/contracts";
import { resolveCanonicalMediaUrl } from "../../services/media-remote.js";
import { createVideoEditRenderer } from "./video-edit-dialog.js";
import { createFrameCaptureRenderer } from "./frame-capture-dialog.js";
import { VideoDialogsSession } from "./session.js";
import { OpenCaptureFrames } from "./capture-frames.js";
import { VIDEO_EDIT_DIALOG_ID, VIDEO_FRAME_CAPTURE_DIALOG_ID } from "./ids.js";
import { frameCaptureDefinition, videoEditDefinition } from "./definitions.js";
import type { VideoDialogPayload } from "./types.js";
import type { VideoEditController } from "./controller-types.js";
import type { CanvasSession, DialogsService, MediaRemoteService } from "../../contracts.js";

export type VideoDialogsControllerDeps = {
  dialogs: DialogsService;
  mediaRemote: MediaRemoteService;
  session: CanvasSession;
  /** 读取节点当前 intents（用于单条删除/打开草稿）。 */
  readNodeIntents: (nodeId: string) => readonly VideoEditIntent[];
  /** 解析节点位置（帧节点落点）。 */
  resolveNodePosition?: (nodeId: string) => { x: number; y: number } | null;
  /** 当前画布身份：画布内截帧/标记图上传与视频预览要带画布提示。 */
  canvasId?: () => string | null;
};

export type VideoDialogsController = {
  controller: VideoEditController;
  /** 打开截帧 dialog（供其它入口复用）。 */
  openFrameCapture(input: { canvas: ServerCanvas | null; nodeId: string }): { ok: boolean; error?: string };
  /**
   * 打开截帧 dialog（**只解析节点自身输出**；双击入口，design D6）。
   * 不优先 `edit_video` input mapping。
   */
  openOwnOutputFrameCapture(input: { canvas: ServerCanvas | null; nodeId: string }): { ok: boolean; error?: string };
  /** Host-resolved immutable camera video; uses the same frame picker/import owner. */
  openFrozenVideoFrameCapture(payload: VideoDialogPayload): { ok: boolean; error?: string };
  dispose(): void;
};

export type ReadyVideoResolution =
  | { ok: true; assetId: string; storageKey: string; url: string; posterUrl?: string; targetNodeId: string }
  | { ok: false; reason: string };

/**
 * 从目标节点解析该节点**自身**的 canonical ready 视频输出
 * （change: enable-video-node-live-preview，design D6）。
 *
 * 与 `resolveCanonicalReadyVideo` 不同：**不**考虑 `edit_video` input mapping。双击的对象是
 * 节点当前显示的输出视频，因此只接受节点自己的 `outputAssetId`，且要求 `status: ready`、
 * `mediaKind: video`、稳定 storageKey 与受控同源 URL。
 */
export function resolveOwnReadyVideo(canvas: ServerCanvas | null, nodeId: string): ReadyVideoResolution {
  if (!canvas) return { ok: false, reason: "画布尚未加载，暂不可截帧" };
  const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
  if (!node) return { ok: false, reason: "目标节点不存在" };
  if (node.type !== "video") return { ok: false, reason: "目标节点不是视频节点" };
  const nodeData = canvas.nodeData as Record<string, CanvasNodeData | undefined>;
  const own = nodeData[nodeId]?.outputAssetId;
  if (typeof own !== "string" || own === "") return { ok: false, reason: "视频尚未就绪或授权失效" };
  const asset = canvas.assets.find((entry) => entry.id === own);
  if (!asset || asset.mediaKind !== "video" || asset.status !== "ready") {
    return { ok: false, reason: "视频尚未就绪或授权失效" };
  }
  const storageKey = typeof asset.metadata?.storageKey === "string" ? asset.metadata.storageKey : "";
  if (!storageKey) return { ok: false, reason: "视频缺少稳定存储标识" };
  const url = resolveCanonicalMediaUrl(asset, canvas.id);
  if (!url) return { ok: false, reason: "视频地址不受控" };
  const posterUrl = typeof asset.posterUrl === "string" && asset.posterUrl !== "" ? asset.posterUrl : undefined;
  return { ok: true, assetId: asset.id, storageKey, url, ...(posterUrl ? { posterUrl } : {}), targetNodeId: nodeId };
}

/**
 * 从目标节点解析 canonical ready 视频：优先其 `edit_video` 输入 mapping，其次其自身输出。
 * 只接受稳定 storageKey + 受控同源 URL；否则返回不可编辑原因（design D2/D9/D3）。
 */
export function resolveCanonicalReadyVideo(canvas: ServerCanvas | null, nodeId: string): ReadyVideoResolution {
  if (!canvas) return { ok: false, reason: "画布尚未加载，暂不可编辑视频" };
  const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
  if (!node) return { ok: false, reason: "目标节点不存在" };
  const nodeData = canvas.nodeData as Record<string, CanvasNodeData | undefined>;
  const candidateAssetIds = collectCandidateAssetIds(nodeId, nodeData);
  if (candidateAssetIds.length === 0) return { ok: false, reason: "缺少可编辑的 ready 视频输入" };
  for (const assetId of candidateAssetIds) {
    const asset = canvas.assets.find((entry) => entry.id === assetId);
    if (!asset || asset.mediaKind !== "video" || asset.status !== "ready") continue;
    const storageKey = typeof asset.metadata?.storageKey === "string" ? asset.metadata.storageKey : "";
    if (!storageKey) continue;
    const url = resolveCanonicalMediaUrl(asset, canvas.id);
    if (!url) continue;
    const posterUrl = typeof asset.posterUrl === "string" && asset.posterUrl !== "" ? asset.posterUrl : undefined;
    return {
      ok: true,
      assetId: asset.id,
      storageKey,
      url,
      ...(posterUrl ? { posterUrl } : {}),
      targetNodeId: nodeId
    };
  }
  return { ok: false, reason: "视频尚未就绪或授权失效" };
}

function collectCandidateAssetIds(
  nodeId: string,
  nodeData: Record<string, CanvasNodeData | undefined>
): string[] {
  const ids: string[] = [];
  const mappings = nodeData[nodeId]?.inputMapping ?? [];
  for (const mapping of mappings) {
    const explicit = (mapping.sourceAssetIds ?? []).filter((id): id is string => typeof id === "string" && id !== "");
    const sourceOutput = nodeData[mapping.sourceNodeId]?.outputAssetId;
    const candidates = explicit.length > 0 ? explicit : typeof sourceOutput === "string" ? [sourceOutput] : [];
    for (const id of candidates) if (!ids.includes(id)) ids.push(id);
  }
  const own = nodeData[nodeId]?.outputAssetId;
  if (typeof own === "string" && own !== "" && !ids.includes(own)) ids.push(own);
  return ids;
}

export function createVideoDialogsController(deps: VideoDialogsControllerDeps): VideoDialogsController {
  const session = new VideoDialogsSession({
    dialogs: deps.dialogs,
    mediaRemote: deps.mediaRemote,
    session: deps.session,
    readNodeIntents: deps.readNodeIntents,
    ...(deps.canvasId ? { canvasId: deps.canvasId } : {})
  });
  // 帧导入与成功回执去重（幂等重试）由独立管理器拥有；Dialog 与聚焦共用同一实例 identity 流程。
  const captureFrames = new OpenCaptureFrames({
    mediaRemote: deps.mediaRemote,
    session: deps.session,
    ...(deps.resolveNodePosition ? { resolveNodePosition: deps.resolveNodePosition } : {}),
    ...(deps.canvasId ? { canvasId: deps.canvasId } : {})
  });

  const openFrameCapture = (canvas: ServerCanvas | null, nodeId: string): { ok: boolean; error?: string } => {
    const resolved = resolveCanonicalReadyVideo(canvas, nodeId);
    if (!resolved.ok) return { ok: false, error: resolved.reason };
    const payload = toPayload(resolved, nodeId);
    const opened = session.openFrameCapture(payload);
    return opened.ok ? { ok: true } : { ok: false, error: opened.error };
  };

  /** 双击入口：只解析节点自身 ready 输出（design D6）。 */
  const openOwnOutputFrameCapture = (canvas: ServerCanvas | null, nodeId: string): { ok: boolean; error?: string } => {
    const resolved = resolveOwnReadyVideo(canvas, nodeId);
    if (!resolved.ok) return { ok: false, error: resolved.reason };
    const payload = toPayload(resolved, nodeId);
    const opened = session.openFrameCapture(payload);
    return opened.ok ? { ok: true } : { ok: false, error: opened.error };
  };

  // 注册两个 dialog：renderer 只消费注入动作；不 import 网络实现。
  const disposeCapture = deps.dialogs.registerDialog(VIDEO_FRAME_CAPTURE_DIALOG_ID, {
    definition: frameCaptureDefinition,
    renderer: createFrameCaptureRenderer({
      onAddFrames: ({ targetNodeId, frames, signal, source }) => captureFrames.addFrames(frames, targetNodeId, signal, source)
    })
  });
  const disposeEdit = deps.dialogs.registerDialog(VIDEO_EDIT_DIALOG_ID, {
    definition: videoEditDefinition,
    renderer: createVideoEditRenderer({
      onConfirm: ({ instanceId, intents, previews }) => session.confirmVideoEdit({ instanceId, intents, previews })
    })
  });

  const controller: VideoEditController = {
    resolveEntry({ canvas, nodeId, writable, pending, taskPending }) {
      // 只读不一定等于断网（也可能是画布连接被服务端关闭）：具体来源由同步状态气泡区分
      // （change: 2026-10-21-recover-canvas-connection-explicitly）。
      if (!writable) return { ok: false, reason: "画布当前只读，暂不可编辑视频" };
      if (pending) return { ok: false, reason: "节点仍在等待保存，暂不可编辑视频" };
      if (taskPending) return { ok: false, reason: "任务进行中，暂不可编辑视频" };
      const resolved = resolveCanonicalReadyVideo(canvas, nodeId);
      return resolved.ok ? { ok: true } : { ok: false, reason: resolved.reason };
    },

    openEdit({ canvas, nodeId, intentId, ownOutput }) {
      const resolved = ownOutput ? resolveOwnReadyVideo(canvas, nodeId) : resolveCanonicalReadyVideo(canvas, nodeId);
      if (!resolved.ok) return;
      const payload: VideoDialogPayload = {
        ...toPayload(resolved, nodeId),
        initialIntents: deps.readNodeIntents(nodeId),
        ...(intentId ? { initialIntentId: intentId } : {})
      };
      session.openVideoEdit(payload);
    },

    openFrameCapture({ canvas, nodeId }) {
      return openFrameCapture(canvas, nodeId);
    },

    removeIntent({ nodeId, intentId }) {
      session.removeIntent({ nodeId, intentId });
    },

    projectIntents(canvas, nodeId) {
      return deps.readNodeIntents(nodeId).map((intent) => ({
        id: intent.id,
        startSeconds: intent.startSeconds,
        ...(intent.endSeconds !== undefined ? { endSeconds: intent.endSeconds } : {}),
        prompt: intent.prompt,
        ...(intent.annotationPreview && canvas
          ? { annotationPreviewUrl: projectPreviewUrl(canvas, intent.annotationPreview.assetId) ?? undefined }
          : {}),
        annotationCount: intent.annotationShapes.length
      }));
    }
  };

  return {
    controller,
    openFrameCapture({ canvas, nodeId }) {
      return openFrameCapture(canvas, nodeId);
    },
    openOwnOutputFrameCapture({ canvas, nodeId }) {
      return openOwnOutputFrameCapture(canvas, nodeId);
    },
    openFrozenVideoFrameCapture(payload) {
      if (!deps.session.isWritable()) return { ok: false, error: "画布当前只读" };
      const opened = session.openFrameCapture(payload);
      return opened.ok ? { ok: true } : { ok: false, error: opened.error };
    },
    dispose() {
      captureFrames.dispose();
      session.dispose();
      disposeCapture();
      disposeEdit();
    }
  };
}

function toPayload(resolved: Extract<ReadyVideoResolution, { ok: true }>, nodeId: string): VideoDialogPayload {
  return {
    videoAssetId: resolved.assetId,
    videoStorageKey: resolved.storageKey,
    videoUrl: resolved.url,
    ...(resolved.posterUrl ? { posterUrl: resolved.posterUrl } : {}),
    targetNodeId: nodeId
  };
}

function projectPreviewUrl(canvas: ServerCanvas, assetId: string): string | null {
  const asset = canvas.assets.find((entry) => entry.id === assetId);
  if (!asset) return null;
  return resolveCanonicalMediaUrl(asset, canvas.id);
}
