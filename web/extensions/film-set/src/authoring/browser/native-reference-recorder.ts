/**
 * 桌面壳的参考录制驱动：改为宿主任务
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 7.2）。
 *
 * 与 `createShotReferenceRecorder`（浏览器逐帧循环）的区别：
 * - **不** acquire 捕捉门、不 seek 可见播放头、不等 `nextPaint`；
 * - 只把「哪个片场/片段需要参考」交给宿主，由执行器在独立进程渲染；
 * - 切片段/隐藏/重载不取消任务；缓存 ready 仍以权威 `asset.upsert` 为准。
 *
 * 模式交接（design D7）：一旦采用 native claim，前端**不再**为同一参考启动生产循环；
 * 需要回退时由宿主撤销 claim（`__WOOHAA_NATIVE_RECORDING__ = false`）。
 */
import type { ShotReferenceRecordTarget } from "./shot-reference-recorder.js";
import type { RecordingStatusView } from "@woohaa3/contracts";
import { createRecordingDriver, describeRecordingFailure, type RecordingDriver } from "./native-recording-client.js";

export type NativeReferenceRecorderDeps = {
  driver: RecordingDriver;
  canvasId: string;
  /** 视觉内容身份（进入幂等 request id，避免同片段不同内容互相覆盖）。 */
  contentIdentityOf(target: ShotReferenceRecordTarget): string;
  /** 轮询间隔；参考任务优先级低，可以更稀疏。 */
  pollIntervalMs?: number;
};

export type NativeReferenceRecorderResult =
  | { ok: true; jobId: string; status: RecordingStatusView }
  | { ok: false; error: string; code: string; transient: boolean };

/**
 * 创建参考录制器（与 `ShotReferenceRecorder` 同签名）。
 *
 * 返回的 `ok` 只代表**宿主任务已完成并保存**；版本缓存仍由调用方在权威资产回填后发布。
 */
export function createNativeReferenceRecorder(deps: NativeReferenceRecorderDeps) {
  return async (target: ShotReferenceRecordTarget): Promise<NativeReferenceRecorderResult> => {
    const contentIdentity = deps.contentIdentityOf(target);
    const requestId = `reference-v2:${target.filmSetNodeId}:${target.clipId}:${contentIdentity}:${target.profileKey}`;
    const submitted = await deps.driver.submit({
      requestId,
      purpose: "reference",
      nodeId: target.filmSetNodeId,
      clipId: target.clipId,
      // 调度目标不携带权威构图；由宿主按冻结片段选择横版/竖版 profile。
      displayVersion: target.contentIdentity
    });
    if (!submitted.ok) {
      return {
        ok: false,
        code: submitted.code,
        transient: isTransientCode(submitted.code),
        error: submitted.message
      };
    }
    const waited = await deps.driver.wait(submitted.submission.jobId);
    if (waited.ok) {
      return { ok: true, jobId: submitted.submission.jobId, status: waited.status };
    }
    // 仍在后台跑：不是失败，但本轮没有可发布结果；调用方稍后由权威资产回填。
    if ("status" in waited) {
      return {
        ok: false,
        code: "recording-still-running",
        transient: true,
        error: describeRecordingFailure("recording-still-running", waited.message)
      };
    }
    return { ok: false, code: waited.code, transient: isTransientCode(waited.code), error: waited.message };
  };
}

/**
 * 是否值得重试（参考录制按 2s→30s 退避，最多 5 次）。
 *
 * 只有执行器未就绪/失联/丢帧/编码瞬态才算；输入非法、权限、真实资源故障等由源变化或
 * 用户显式重试处理。
 */
export function isTransientCode(code: string): boolean {
  return (
    code === "recording-executor-unavailable" ||
    code === "recording-still-running" ||
    // change: 2026-10-22-remove-agent-execution-limits，任务 7.5：总时长预算 → 执行器失联
    // watchdog；保留旧码为瞬态以兼容既有回执。
    code === "recording-dispatch-timeout" ||
    code === "recording-executor-unresponsive" ||
    code === "recording-device-lost" ||
    code === "capture-readiness-timeout" ||
    code === "recording-media-not-ready" ||
    code === "recording-pipeline-not-ready" ||
    code === "recording-readback-timeout" ||
    code === "unavailable"
  );
}

/** 供装配处使用：按可用性选择 native 或浏览器录制器。 */
export function selectReferenceRecorder<T>(input: {
  native: boolean;
  nativeRecorder: () => T;
  browserRecorder: () => T;
}): T {
  return input.native ? input.nativeRecorder() : input.browserRecorder();
}

/** 便捷构造：由 CanvasRemoteService 生成 driver（画布 id 固定）。 */
export function createReferenceDriver(input: {
  remote: Parameters<typeof createRecordingDriver>[0]["remote"];
  canvasId: string;
  pollIntervalMs?: number;
}): RecordingDriver {
  return createRecordingDriver({
    remote: input.remote,
    canvasId: input.canvasId,
    ...(input.pollIntervalMs !== undefined ? { pollIntervalMs: input.pollIntervalMs } : {})
  });
}
