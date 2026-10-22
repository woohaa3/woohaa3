/**
 * 视频 dialogs 会话服务
 * （change: port-video-editing-dialogs，任务 2.4 / 2.5 / 3.4 / 4.1；design D3/D6/D7；
 *  change: 2026-10-10-add-video-node-focus-workspace，任务 3.3：帧导入与成功回执去重拆到
 *  `OpenCaptureFrames`，本类只拥有 dialog 实例生命周期与视频编辑确认）。
 *
 * 拥有两个 dialog 的 session 生命周期：
 * - 只从 canonical ready video mapping 解析出的稳定身份打开 dialog（payload 由调用方解析）；
 * - 截帧添加：委托注入的 `OpenCaptureFrames`（逐项回执、部分失败可重试、幂等去重）；
 * - 编辑确认：为含标注的 intent 上传稳定 preview 并一次性回传完整 intents；
 * - dispose / 关闭时撤销 registrations、pending 请求、object URLs 与打开实例。
 *
 * 所有网络与写入都经注入的 `mediaRemote` / `canvasSession`；本模块不直接拼 API path、
 * 不持有 Blob 之外的临时表示进入规范状态。
 */
import {
  normalizeVideoEditIntents,
  sortVideoEditIntents,
  type CanvasCommand,
  type CanvasNodeData,
  type StoredAsset,
  type VideoEditIntent
} from "@woohaa3/contracts";
import { mediaUrlFor } from "../../services/paths.js";
import { VIDEO_FRAME_CAPTURE_DIALOG_ID, VIDEO_EDIT_DIALOG_ID } from "./ids.js";
import type { VideoDialogPayload } from "./types.js";
import type { CanvasSession, DialogsService, MediaRemoteService } from "../../contracts.js";

export type VideoDialogsSessionDeps = {
  dialogs: DialogsService;
  mediaRemote: MediaRemoteService;
  session: CanvasSession;
  /** 读取目标节点当前 intents（供单条删除合并写回）。 */
  readNodeIntents?: (nodeId: string) => readonly VideoEditIntent[];
  /** 当前画布身份：标记图上传要带画布提示（POST /api/media?canvas=<id>）。 */
  canvasId?: () => string | null;
};

export type OpenVideoDialogResult = { ok: true; instanceId: string } | { ok: false; error: string };

export class VideoDialogsSession {
  private readonly openedInstances = new Set<string>();
  private disposed = false;
  /** 各编辑实例的目标节点（instanceId → nodeId），供 confirm 定位写入目标。 */
  private readonly editTargets = new Map<string, string>();

  constructor(private readonly deps: VideoDialogsSessionDeps) {}

  openFrameCapture(payload: VideoDialogPayload): OpenVideoDialogResult {
    return this.open(VIDEO_FRAME_CAPTURE_DIALOG_ID, payload);
  }

  openVideoEdit(payload: VideoDialogPayload): OpenVideoDialogResult {
    const result = this.open(VIDEO_EDIT_DIALOG_ID, payload);
    if (result.ok) this.editTargets.set(result.instanceId, payload.targetNodeId);
    return result;
  }

  private open(dialogId: string, payload: VideoDialogPayload): OpenVideoDialogResult {
    if (this.disposed) return { ok: false, error: "视频弹窗能力已释放" };
    const result = this.deps.dialogs.open({ dialogId, payload });
    if (!result.ok) return { ok: false, error: result.error };
    this.openedInstances.add(result.instance.instanceId);
    return { ok: true, instanceId: result.instance.instanceId };
  }

  /**
   * 编辑确认动作：校验 intents → 为含标注 intent 上传稳定 preview → 一次性提交
   * `asset.upsert` + `nodeData.patch`（design D6/D7）。失败保留草稿与已完成 session 结果。
   */
  async confirmVideoEdit(input: {
    instanceId: string;
    intents: readonly VideoEditIntent[];
    previews: ReadonlyMap<string, Blob>;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.disposed) return { ok: false, error: "视频弹窗能力已释放" };
    if (!this.deps.session.isWritable()) return { ok: false, error: "网络不可用，画布只读" };
    const normalized = normalizeVideoEditIntents(input.intents);
    if (!normalized.ok) return { ok: false, error: normalized.error };
    const targetNodeId = this.editTargets.get(input.instanceId);
    if (!targetNodeId) return { ok: false, error: "编辑目标节点已失效" };

    const assets: StoredAsset[] = [];
    const resolved: VideoEditIntent[] = [];
    for (const intent of sortVideoEditIntents(normalized.value)) {
      const blob = input.previews.get(intent.id);
      if (intent.annotationShapes.length > 0) {
        if (!blob) return { ok: false, error: `编辑点 ${intent.id} 缺少标记图` };
        let file: File;
        try {
          file = new File([blob], `video-annotation-${intent.id}.png`, { type: "image/png" });
        } catch {
          return { ok: false, error: "无法读取标记图" };
        }
        const uploaded = await this.deps.mediaRemote.upload({ file, canvasId: this.deps.canvasId?.() ?? undefined });
        if (!uploaded.ok) return { ok: false, error: uploaded.error };
        const asset = annotationAsset(uploaded.media, intent.id);
        assets.push(asset);
        resolved.push({
          ...intent,
          annotationPreview: { assetId: asset.id, storageKey: uploaded.media.storageKey, mediaType: "image/png" }
        });
      } else {
        const { annotationPreview: _preview, ...rest } = intent;
        void _preview;
        resolved.push(rest);
      }
    }

    if (!this.deps.session.isWritable()) return { ok: false, error: "网络不可用，画布只读" };
    const value: CanvasNodeData = { videoEditIntents: resolved };
    const commands: CanvasCommand[] = [
      ...assets.map((asset): CanvasCommand => ({ type: "asset.upsert", asset })),
      { type: "nodeData.patch", nodeId: targetNodeId, value }
    ];
    const result = this.deps.session.submitCommands(commands, `web-video-edit-${input.instanceId}`);
    if (!result.ok) return { ok: false, error: result.reason };
    return { ok: true };
  }

  /** 删除目标节点上的单个 intent（ExecutionPanel chips 的删除动作，任务 4.2）。 */
  removeIntent(instanceOrNodeId: { nodeId: string; intentId: string }): { ok: true } | { ok: false; error: string } {
    if (this.disposed) return { ok: false, error: "视频弹窗能力已释放" };
    if (!this.deps.session.isWritable()) return { ok: false, error: "网络不可用，画布只读" };
    const current = this.deps.readNodeIntents?.(instanceOrNodeId.nodeId) ?? [];
    const next = current.filter((intent) => intent.id !== instanceOrNodeId.intentId);
    const value: CanvasNodeData = { videoEditIntents: next };
    const result = this.deps.session.submitCommands(
      [{ type: "nodeData.patch", nodeId: instanceOrNodeId.nodeId, value }],
      `web-video-intent-remove-${Date.now().toString(36)}`
    );
    if (!result.ok) return { ok: false, error: result.reason };
    return { ok: true };
  }

  /** 记录/清理打开实例（Host 关闭后由 Plugin 观察快照调用）。 */
  forget(instanceId: string): void {
    this.openedInstances.delete(instanceId);
    this.editTargets.delete(instanceId);
  }

  /** dispose：关闭所有仍在打开的实例；释放 session 记录。 */
  dispose(): void {
    this.disposed = true;
    for (const instanceId of this.openedInstances) this.deps.dialogs.close(instanceId);
    this.openedInstances.clear();
    this.editTargets.clear();
  }
}

function annotationAsset(media: { storageKey: string; checksum: string; contentType: string; size: number; url: string }, intentId: string): StoredAsset {
  return {
    id: `asset-video-annotation-${media.checksum}`,
    title: `标记图 ${intentId}`,
    mediaKind: "image",
    source: "uploaded",
    status: "ready",
    createdAt: new Date().toISOString(),
    url: media.url || mediaUrlFor(media.storageKey),
    metadata: { storageKey: media.storageKey, checksum: media.checksum, contentType: media.contentType, size: media.size }
  };
}
