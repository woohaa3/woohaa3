/**
 * 桌面「生成视频」控件：宿主任务适配
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 7.1 / 7.3）。
 *
 * 行为差异（相对浏览器路径）：
 * - 提交后立刻释放播放器：不锁可见播放头、不 acquire 捕捉门；
 * - 切片段/隐藏/卸载只**停止观察**，不取消任务；
 * - 取消是显式按钮，`too-late` 时明确告知正在保存；
 * - 进度来自宿主查询，阶段文案与活动浮层共用。
 */
import { Button } from "@woohaa3/frontend/extension-api";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RecordingStatusView } from "@woohaa3/contracts";
import type { FilmSetContext as Context } from "./context.js";
import {
  createRecordingDriver,
  recordingStageLabel,
  type RecordingDriver
} from "./native-recording-client.js";

export type NativeVideoExportProps = {
  ctx: Context;
  disabled: boolean;
  /** 目标节点与片段（来自当前聚焦片段）。 */
  target: { nodeId: string; clipId: string; displayVersion?: string; title: string } | null;
  onBusyChange: (busy: boolean) => void;
};

/** 生成请求 id：同一目标重试复用同一 id（宿主幂等）；改目标则换 id。 */
export function recordingRequestId(target: { nodeId: string; clipId: string; displayVersion?: string }): string {
  return `export:${target.nodeId}:${target.clipId}:${target.displayVersion ?? "current"}`;
}

export function NativeVideoExportControl({ ctx, disabled, target, onBusyChange }: NativeVideoExportProps) {
  const [status, setStatus] = useState<RecordingStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const jobRef = useRef<string | null>(null);
  const abortedRef = useRef(false);

  const driver = useRef<RecordingDriver | null>(null);
  if (!driver.current) {
    driver.current = createRecordingDriver({
      remote: ctx.canvasRemote as never,
      canvasId: ctx.canvasState.getCanvas()?.id ?? ""
    });
  }

  // 卸载/隐藏只停止观察：**不**取消宿主任务。
  useEffect(() => {
    abortedRef.current = false;
    return () => {
      abortedRef.current = true;
    };
  }, []);

  const run = useCallback(async () => {
    if (disabled || !target) return;
    setError(null);
    setMessage(null);
    onBusyChange(true);
    const submission = await driver.current!.submit({
      requestId: recordingRequestId(target),
      nodeId: target.nodeId,
      clipId: target.clipId,
      ...(target.displayVersion ? { displayVersion: target.displayVersion } : {})
    });
    if (!submission.ok) {
      setError(submission.message);
      onBusyChange(false);
      return;
    }
    jobRef.current = submission.submission.jobId;
    const result = await driver.current!.wait(submission.submission.jobId, value => {
      // 页面隐藏后不再更新 UI，但任务继续跑。
      if (!abortedRef.current) setStatus(value);
    });
    if (abortedRef.current) return;
    if (result.ok) {
      setStatus(result.status);
      setMessage("视频已生成，已放在片场右侧");
    } else if ("status" in result) {
      // 本地等待超时：任务仍在宿主里跑，只停止这里的观察。
      setStatus(result.status);
      setMessage(result.message);
    } else {
      setError(result.message);
    }
    onBusyChange(false);
  }, [disabled, target, onBusyChange]);

  const cancel = useCallback(async () => {
    const jobId = jobRef.current;
    if (!jobId) return;
    const result = await driver.current!.cancel(jobId);
    if (result.ok) {
      setMessage("已取消生成");
      onBusyChange(false);
      return;
    }
    // `too-late` 时如实告知正在保存，不谎称取消成功。
    setError(result.message);
  }, [onBusyChange]);

  const busy = status !== null && !["succeeded", "cancelled", "failed", "stale"].includes(status.state);
  const label = status ? recordingStageLabel(status) : "生成视频";

  return <>
    <Button
      size="sm"
      disabled={disabled || busy || !target}
      onClick={() => void run()}
      title="在后台生成当前片段的视频，并添加到片场右侧"
    >
      {busy ? label : "生成视频"}
    </Button>
    {busy ? <>
      <progress
        aria-label="视频生成进度"
        max={status?.totalFrames || 1}
        value={status?.completedFrames ?? 0}
      />
      <Button size="sm" disabled={status?.state === "committing"} onClick={() => void cancel()}>
        取消生成
      </Button>
    </> : null}
    {error ? <p role="alert">{error}</p> : message ? <p role="status">{message}</p> : null}
  </>;
}
