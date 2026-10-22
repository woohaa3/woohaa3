/**
 * 宿主录制服务的装配
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 6.1 / 6.3 / 7.1）。
 *
 * 把「权威画布读取、Media 上传、执行器派发」三个宿主能力接到 `HostRecordingService`：
 * - 画布读取走 canvas-service 的权威房间（不读 Y.Doc、不读 working projection）；
 * - 上传走 Media 的进程内端口（stable storageKey + checksum）；
 * - 派发走已注册的执行器通道（无执行器时返回明确原因）。
 *
 * 未装配执行器通道或内容扩展没有录制端口时返回 `null`，路由据此给 503。
 */
import { recordingAttemptDirectory, stageRecordingResources, removeRecordingAttempt } from "./attempt-files.js";
import { YJS_SYNC_PROTOCOL_VERSION, type CanvasContentRuntime, type CanvasCommand } from "@woohaa3/contracts";
import type { CanvasService } from "@woohaa3/canvas-service";
import type { BackendMediaPort } from "@woohaa3/contracts";
import { HostRecordingService } from "./host-service.js";
import { createExecutorDispatcher } from "./dispatcher.js";
import { RecordingActivityProjector } from "./activity.js";
import type { RecordingExecutorChannel } from "./channel.js";

export type HostRecordingAssemblyInput = {
  contentRuntime: CanvasContentRuntime | undefined;
  canvas: CanvasService;
  media: BackendMediaPort;
  executor: RecordingExecutorChannel | null;
  logger?: (event: Record<string, unknown>) => void;
  /** 活动浮层投影（每 attempt 一条记录）。 */
  publishActivity?: (job: import("@woohaa3/contracts").BackgroundActivityJob) => void;
};

/** 未装配时返回 null；装配失败只记录原因，不影响宿主其它能力。 */
export async function createHostRecordingService(
  input: HostRecordingAssemblyInput
): Promise<HostRecordingService | null> {
  const runtime = input.contentRuntime;
  if (!runtime?.recording) {
    input.logger?.({ event: "recording-service-unavailable", reason: "no-runtime" });
    return null;
  }
  const executor = input.executor;
  if (!executor || !executor.available) {
    input.logger?.({ event: "recording-service-unavailable", reason: "no-executor" });
    return null;
  }
  const send = (message: Record<string, unknown>): boolean => executor.sendControl(message);
  const subscribe = (listener: (payload: Record<string, unknown>) => void): (() => void) =>
    executor.onControl(listener);
  let sequence = 0;
  const dispatcher = createExecutorDispatcher({
    send,
    subscribe,
    nextSequence: () => {
      sequence += 1;
      return sequence;
    },
    ...(input.logger ? { logger: input.logger } : {})
  });

  // 活动投影：每次 attempt 一条、5% 分桶、终态不复活；浮层自己负责 10 秒移除。
  const projector = input.publishActivity
    ? new RecordingActivityProjector(input.publishActivity)
    : null;

  return new HostRecordingService({
    runtime,
    // 进程内 facade 直接吃 canvasId，不再走一次 HTTP；录制读的是「这张画布」的素材。
    canvas: {
      ...createCanvasReader(input.canvas),
      ...(input.media.resources
        ? { readMedia: (storageKey: string, canvasId?: string) => input.media.resources!.read(storageKey, canvasId) }
        : {})
    },
    upload: createMediaUploader(input.media),
    dispatch: async request => {
      const directory = recordingAttemptDirectory(executor.directory, request.identity.attemptId);
      try {
        await stageRecordingResources({ directory, snapshot: request.snapshot, signal: request.signal,
          // 录制快照冻结了 origin.canvasId：素材就是该画布作用域下的对象，按它读才不会落到主存储。
          ...(input.media.resources
            ? { read: (storageKey: string) => input.media.resources!.read(storageKey, request.snapshot.origin.canvasId) }
            : {}) });
        const result = await dispatcher(request);
        if (result.ok) {
          const { join } = await import("node:path");
          const expected = join(directory, `artifact-${request.identity.attemptId.replace(/[^a-zA-Z0-9_-]/g, "_")}.mp4`);
          if (result.claim.path !== expected) return { ok: false, stage: "RECORDING_ERROR_STAGE_MUX", code: "recording-artifact-path-invalid", message: "成片不在本次任务私有目录内", transient: false };
        }
        return result;
      } catch (error) {
        return { ok: false, stage: "RECORDING_ERROR_STAGE_DECODE", code: "recording-resource-invalid", message: error instanceof Error ? error.message : "素材准备失败", transient: false };
      }
    },
    cleanupAttempt: identity => removeRecordingAttempt(recordingAttemptDirectory(executor.directory, identity.attemptId)),
    executor,
    ...(projector
      ? {
          publishActivity: job => {
            // 协调器已给出状态/进度；这里再做一次去重与分桶，避免重复/乱序穿透到 UI。
            projector.publish({
              jobId: job.id.split(":")[1] ?? job.id,
              attemptId: job.id.split(":")[2] ?? "attempt",
              canvasId: job.canvasId,
              nodeId: job.nodeId ?? "",
              title: job.title,
              purpose: "export",
              state:
                job.status === "succeeded"
                  ? "succeeded"
                  : job.status === "failed"
                    ? "failed"
                    : job.status === "cancelled"
                      ? "cancelled"
                      : job.status === "queued"
                        ? "queued"
                        : "rendering",
              completedFrames: Math.round((job.progress ?? 0) * 100),
              totalFrames: 100,
              ...(job.detail ? { error: job.detail } : {}),
              updatedAt: job.updatedAt
            });
          }
        }
      : {}),
    ...(input.logger ? { logger: input.logger } : {})
  });
}

/**
 * 权威画布读取适配器。
 *
 * 读的是**已提交**房间快照；`readOnly`/`hasPendingDraft` 由调用方（前端/宿主）标注的语义决定，
 * 这里只负责提供数据与存活检查。
 */
export function createCanvasReader(canvas: CanvasService): import("./host-service.js").RecordingCanvasReader {
  return {
    async read({ canvasId, nodeId }) {
      const room = await canvas.sync?.registry.resolve(canvasId);
      const exported = room?.exportCanvas();
      if (!exported || !exported.ok) {
        return { ok: false, code: "recording-source-invalid", message: "画布不可用" };
      }
      const snapshot = exported.canvas;
      const node = snapshot.document.nodes.find(entry => entry.id === nodeId);
      if (!node) {
        return { ok: false, code: "recording-source-removed", message: "源节点已被删除" };
      }
      const nodeData = snapshot.nodeData[nodeId];
      const bounds = node as { position?: { x: number; y: number }; width?: number; height?: number };
      return {
        ok: true,
        revision: snapshot.revision ?? 0,
        assets: snapshot.assets,
        nodeData,
        node: { ...(bounds.width !== undefined ? { width: bounds.width } : {}), ...(bounds.height !== undefined ? { height: bounds.height } : {}) },
        // 来源 incarnation 只含身份，不含 revision：移动/改布局不应让运行中的任务失效。
        sourceIncarnation: `${canvasId}:${nodeId}`,
        layout: {
          x: bounds.position?.x ?? 0,
          y: bounds.position?.y ?? 0,
          width: bounds.width ?? 320
        },
        // 是否可写由调用方（HTTP 授权边界）决定；这里只保证数据来自已提交快照。
        writable: true,
        readOnly: false,
        hasPendingDraft: false
      };
    },
    async currentLayout({ canvasId, nodeId }) {
      const room = await canvas.sync?.registry.resolve(canvasId);
      const exported = room?.exportCanvas();
      if (!exported || !exported.ok) return null;
      const node = exported.canvas.document.nodes.find(entry => entry.id === nodeId);
      if (!node) return null;
      const bounds = node as { position?: { x: number; y: number }; width?: number; height?: number };
      return {
        x: bounds.position?.x ?? 0,
        y: bounds.position?.y ?? 0,
        width: bounds.width ?? 320
      };
    },
    async submit({ canvasId, commandId, commands }) {
      const room = await canvas.sync?.registry.resolve(canvasId);
      if (!room) return { ok: false, code: "canvas-unavailable", message: "画布不可用" };
      const result = await room.submitDerived({
        commandId,
        derive: current => ({
          ok: true,
          batch: {
            protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
            canvasId,
            commandId,
            baseRevision: current.revision ?? 0,
            actorId: "host-recording",
            commands: commands as CanvasCommand[]
          }
        })
      });
      if (!result.ok) return { ok: false, code: result.code, message: result.message };
      return { ok: true, duplicate: result.status === "duplicate" };
    },
  };
}

/** Media 端口 → 流式上传适配器（分块累积后走进程内导入）。 */
export function createMediaUploader(
  media: BackendMediaPort
): import("./host-service.js").RecordingUploader {
  return async ({ chunks, contentType, sizeBytes, canvasId, signal }) => {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of chunks) {
      if (signal.aborted) return { ok: false, code: "recording-cancelled", message: "上传已取消" };
      total += chunk.byteLength;
      if (total > sizeBytes) {
        return { ok: false, code: "recording-upload-size-mismatch", message: "上传字节数超过声明" };
      }
      parts.push(chunk);
    }
    if (total !== sizeBytes) {
      return { ok: false, code: "recording-upload-size-mismatch", message: "上传字节数与声明不一致" };
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.byteLength;
    }
    try {
      const metadata = await media.importBytes({
        bytesBase64: Buffer.from(merged).toString("base64"),
        contentType,
        // 远端画布的成片必须落到托管存储：否则成片只在单机主存储里，
        // 其他协作者看不到，换一台设备打开也是坏图。
        canvasId
      });
      return {
        ok: true,
        artifact: {
          storageKey: metadata.storageKey,
          checksum: metadata.checksum ?? "",
          contentType: metadata.contentType,
          size: metadata.size
        }
      };
    } catch (error) {
      return {
        ok: false,
        code: "recording-upload-failed",
        message: error instanceof Error ? error.message : "上传失败"
      };
    }
  };
}
