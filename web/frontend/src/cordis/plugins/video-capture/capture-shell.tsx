/**
 * 视频截帧共享主体（hook + 展示组件）
 * （change: 2026-10-10-add-video-node-focus-workspace，任务 3.1/3.2）。
 *
 * 从原 `frame-capture-dialog.tsx` 抽出可复用的播放/捕获/帧集合逻辑：
 * - `useCaptureSession`：绑定一个 `FrameCaptureSource`，提供播放/暂停/seek/静音、首/当前/尾帧
 *   捕获、多帧选择/删除/清空、添加选中/全部、逐项结果与失败重试；所有状态都是会话内可丢弃态。
 * - `CapturePlaybackControls` / `CaptureButtons` / `CaptureFrameList` / `CaptureFooter`：Dialog 与
 *   聚焦工作区共用的展示层，各自外层 shell 决定布局与提交动作。
 *
 * busy 期间禁止重复捕获/添加/移除；object URL 在移除/清空/dispose 时 revoke。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emptyCaptureState, type CaptureState, type FrameCaptureSource } from "./capture-source.js";
export type { CaptureState, FrameCaptureSource } from "./capture-source.js";
import type { CapturedFrameEntry, FrameAddReceipt } from "./types.js";
import { clampRange, formatVideoTime, resolveFirstVideoFrameTime, resolveLastVideoFrameTime } from "./video-geometry.js";
import { toSafeCaptureError } from "./capture-frames.js";
import { Button, MuteIcon, PauseIcon, PlayIcon, TrashIcon, VolumeIcon } from "@woohaa3/ui";
import { DialogIconButton } from "@woohaa3/ui/dialogs";

export type CaptureKind = "first" | "current" | "last";

/** showcase/test 注入的初始会话状态（生产不传）；不参与网络或规范写入。 */
export type CaptureInitialState = {
  frames?: readonly CapturedFrameEntry[];
  receipts?: readonly FrameAddReceipt[];
  busy?: CaptureKind | "add" | null;
  error?: string | null;
  video?: Partial<CaptureState>;
};

export type CaptureSessionOptions = {
  /** 解码源；SSR/尚未挂载时为 null，此时状态回落到 `initial`。 */
  source: FrameCaptureSource | null;
  instanceId: string;
  targetNodeId: string;
  /** 添加动作：返回逐项回执（幂等重试由注入实现保证）。 */
  onAddFrames: (input: {
    instanceId: string;
    targetNodeId: string;
    frames: readonly CapturedFrameEntry[];
    signal?: AbortSignal;
  }) => Promise<readonly FrameAddReceipt[]>;
  /** 全部成功导入后的回调（Dialog 用它请求关闭；focus 忽略以保留现场）。 */
  onAllAdded?: () => void;
  initial?: CaptureInitialState;
};

export function useCaptureSession(options: CaptureSessionOptions) {
  const { source, instanceId, targetNodeId, onAddFrames } = options;
  const initial = options.initial;
  const [videoState, setVideoState] = useState<CaptureState>(() => ({ ...emptyCaptureState(), ...(initial?.video ?? {}) }));
  const [frames, setFrames] = useState<CapturedFrameEntry[]>(() => (initial?.frames ? [...initial.frames] : []));
  const [busy, setBusy] = useState<CaptureKind | "add" | null>(initial?.busy ?? null);
  const [error, setError] = useState<string | null>(initial?.error ?? null);
  const [receipts, setReceipts] = useState<readonly FrameAddReceipt[]>(initial?.receipts ?? []);
  const [pendingFrameIds, setPendingFrameIds] = useState<readonly string[]>(
    (initial?.receipts ?? []).filter((receipt) => !receipt.ok).map((receipt) => receipt.frameId)
  );
  const framesRef = useRef<CapturedFrameEntry[]>(initial?.frames ? [...initial.frames] : []);
  const busyRef = useRef(false);
  const activeRef = useRef<AbortController | null>(null);
  const allAddedRef = useRef(options.onAllAdded);
  allAddedRef.current = options.onAllAdded;

  // Each setup owns one source/target generation, including StrictMode effect replay.
  useEffect(() => {
    const active = new AbortController();
    activeRef.current = active;
    busyRef.current = Boolean(initial?.busy);
    setBusy(initial?.busy ?? null);
    framesRef.current = [...(initial?.frames ?? [])];
    setFrames(framesRef.current);
    setReceipts(initial?.receipts ?? []);
    setPendingFrameIds((initial?.receipts ?? []).filter(receipt => !receipt.ok).map(receipt => receipt.frameId));
    setError(initial?.error ?? null);
    const sync = () => {
      if (!active.signal.aborted) setVideoState(initial?.video ? { ...emptyCaptureState(), ...initial.video } : source?.state() ?? emptyCaptureState());
    };
    sync();
    const unsubscribe = source?.subscribe(sync);
    return () => {
      active.abort();
      unsubscribe?.();
      source?.pause();
      for (const frame of framesRef.current) revokeObjectUrl(frame.url);
      framesRef.current = [];
      if (activeRef.current === active) activeRef.current = null;
    };
  }, [source, instanceId, targetNodeId]);

  const generation = () => activeRef.current;
  const isActive = (active: AbortController | null) => active !== null && activeRef.current === active && !active.signal.aborted;

  const duration = videoState.duration;
  const ready = videoState.ready && duration > 0 && videoState.width > 0;
  const selectedCount = useMemo(() => frames.filter((frame) => frame.selected).length, [frames]);

  const seek = useCallback(async (time: number) => {
    if (!source) return;
    const active = generation();
    if (!isActive(active)) return;
    await withinCaptureGeneration(source.seek(time), active!.signal, "视频定位超时，请重试");
    if (isActive(active)) setVideoState(source.state());
  }, [source]);

  const togglePlayback = useCallback(async () => {
    if (!source || !ready || busyRef.current) return;
    const active = generation();
    setError(null);
    try {
      if (!videoState.playing) {
        if (duration > 0 && videoState.currentTime >= duration - 0.05) await seek(0);
        if (!isActive(active)) return;
        await source.play();
      } else {
        source.pause();
      }
    } catch (playbackError) {
      if (!isActive(active)) return;
      setError(playbackError instanceof Error ? playbackError.message : "视频播放失败");
    } finally {
      if (isActive(active)) setVideoState(source.state());
    }
  }, [duration, ready, seek, source, videoState.currentTime, videoState.playing]);

  const seekPlayback = useCallback(
    (time: number) => {
      if (!ready || busyRef.current) return;
      const active = generation();
      void seek(time).catch(() => { if (isActive(active)) setError("视频定位失败"); });
    },
    [ready, seek]
  );

  const captureFrame = useCallback(
    async (kind: CaptureKind) => {
      if (!source || !ready || duration <= 0 || busyRef.current) return;
      const active = generation();
      if (!isActive(active)) return;
      const time = kind === "first"
        ? resolveFirstVideoFrameTime()
        : kind === "last"
          ? resolveLastVideoFrameTime(duration)
          : clampRange(source.state().currentTime, 0, duration);
      busyRef.current = true;
      setBusy(kind);
      setError(null);
      try {
        await seek(time);
        if (!isActive(active)) return;
        const blob = await withinCaptureGeneration(source.capture(), active!.signal, "截取画面超时，请重试");
        if (!isActive(active)) return;
        if (!blob.size) throw new Error("截取的图片为空，请重试");
        const url = createObjectUrl(blob);
        if (!url) throw new Error("无法创建截帧预览，请重新进入后重试");
        const entry: CapturedFrameEntry = {
          id: createFrameId(),
          blob,
          timeSeconds: clampRange(time, 0, duration),
          url,
          selected: true
        };
        if (!isActive(active)) {
          revokeObjectUrl(entry.url);
          return;
        }
        const next = [...framesRef.current, entry];
        framesRef.current = next;
        setFrames(next);
      } catch (captureError) {
        if (isActive(active)) setError(toSafeCaptureError(captureError));
      } finally {
        if (!isActive(active)) return;
        busyRef.current = false;
        setBusy(null);
        setVideoState(source.state());
      }
    },
    [duration, ready, seek, source]
  );

  const toggleFrame = useCallback((frameId: string) => {
    if (busyRef.current) return;
    setFrames((previous) => {
      const next = previous.map((frame) => (frame.id === frameId ? { ...frame, selected: !frame.selected } : frame));
      framesRef.current = next;
      return next;
    });
  }, []);

  const removeFrame = useCallback((frameId: string) => {
    if (busyRef.current) return;
    const frame = framesRef.current.find((entry) => entry.id === frameId);
    revokeObjectUrl(frame?.url ?? null);
    setFrames((previous) => {
      const next = previous.filter((entry) => entry.id !== frameId);
      framesRef.current = next;
      return next;
    });
    setReceipts((previous) => previous.filter((receipt) => receipt.frameId !== frameId));
  }, []);

  const clearFrames = useCallback(() => {
    if (busyRef.current) return;
    for (const frame of framesRef.current) revokeObjectUrl(frame.url);
    framesRef.current = [];
    setFrames([]);
    setReceipts([]);
    setPendingFrameIds([]);
    setError(null);
  }, []);

  // 只重试失败项；已成功项保留、不再重复上传（幂等重试，design D3）。
  const addFrames = useCallback(
    async (targets: readonly CapturedFrameEntry[]) => {
      if (targets.length === 0 || busyRef.current) return;
      const active = generation();
      if (!isActive(active)) return;
      busyRef.current = true;
      setBusy("add");
      setError(null);
      try {
        const results = await onAddFrames({ instanceId, targetNodeId, frames: targets, signal: active!.signal });
        if (!isActive(active)) return;
        // Missing receipts are failures; successful frames leave the retry set immediately.
        const completed = targets.map(frame => results.find(result => result.frameId === frame.id) ?? {
          frameId: frame.id, timeSeconds: frame.timeSeconds, ok: false, error: "未收到添加回执，请重试"
        });
        setReceipts(completed);
        const failedIds = completed.filter(receipt => !receipt.ok).map(receipt => receipt.frameId);
        setPendingFrameIds(failedIds);
        const succeededIds = new Set(completed.filter(receipt => receipt.ok).map(receipt => receipt.frameId));
        const next = framesRef.current.filter(frame => {
          if (!succeededIds.has(frame.id)) return true;
          revokeObjectUrl(frame.url);
          return false;
        });
        framesRef.current = next;
        setFrames(next);
        if (failedIds.length === 0) allAddedRef.current?.();
        else setError(`部分帧添加失败（${failedIds.length} 项），可只重试失败项`);
      } catch (addError) {
        if (!isActive(active)) return;
        setError(addError instanceof Error ? addError.message : "添加视频帧失败");
      } finally {
        if (!isActive(active)) return;
        busyRef.current = false;
        setBusy(null);
      }
    },
    [instanceId, onAddFrames, targetNodeId]
  );

  const addSelected = useCallback(() => { void addFrames(framesRef.current.filter((frame) => frame.selected)); }, [addFrames]);
  const addAll = useCallback(() => { void addFrames(framesRef.current); }, [addFrames]);
  const retryFailed = useCallback(() => {
    const failed = new Set(pendingFrameIds);
    void addFrames(framesRef.current.filter((frame) => failed.has(frame.id)));
  }, [addFrames, pendingFrameIds]);
  const setMuted = useCallback((muted: boolean) => {
    if (!source) return;
    source.setMuted(muted);
    setVideoState(source.state());
  }, [source]);

  return {
    videoState, duration, ready, frames, receipts, pendingFrameIds, busy,
    busyNow: busy !== null, error, selectedCount,
    setError, togglePlayback, seekPlayback, captureFrame, toggleFrame, removeFrame,
    clearFrames, addSelected, addAll, retryFailed, setMuted
  };
}

/** Bound decoder work and release timers/listeners when this generation ends. */
function withinCaptureGeneration<T>(work: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (complete: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      complete();
    };
    const abort = () => finish(() => reject(new Error("截帧会话已结束")));
    const timer = setTimeout(() => finish(() => reject(new Error(message))), 10_000);
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal.aborted) abort();
  });
}

export type CaptureSession = ReturnType<typeof useCaptureSession>;

/** 播放/进度/静音工具条（Dialog 与聚焦共用）。 */
export function CapturePlaybackControls({ session }: { session: CaptureSession }) {
  const { videoState, duration, ready, busyNow } = session;
  return (
    <>
      <DialogIconButton
        label={videoState.playing ? "暂停视频" : "播放视频"}
        tooltip={videoState.playing ? "暂停" : "播放"}
        disabled={!ready || busyNow}
        icon={videoState.playing ? <PauseIcon className="dlg__icon" /> : <PlayIcon className="dlg__icon" />}
        onClick={() => void session.togglePlayback()}
      />
      <span className="video-frame-dialog__time">
        {formatVideoTime(videoState.currentTime)} / {formatVideoTime(duration)}
      </span>
      <input
        type="range"
        aria-label="视频播放进度"
        min={0}
        max={Math.max(duration, 0.01)}
        step={0.01}
        value={Math.min(videoState.currentTime, Math.max(duration, 0.01))}
        disabled={!ready || busyNow}
        onChange={(event) => session.seekPlayback(Number(event.target.value))}
      />
      <DialogIconButton
        label={videoState.muted ? "取消静音" : "静音"}
        tooltip={videoState.muted ? "取消静音" : "静音"}
        pressed={videoState.muted}
        disabled={!ready || busyNow}
        icon={videoState.muted ? <MuteIcon className="dlg__icon" /> : <VolumeIcon className="dlg__icon" />}
        onClick={() => session.setMuted(!videoState.muted)}
      />
    </>
  );
}

/** 首/当前/尾帧捕获按钮。 */
export function CaptureButtons({ session }: { session: CaptureSession }) {
  const { ready, busyNow } = session;
  return (
    <div className="video-frame-dialog__capture" role="group" aria-label="截取帧操作">
      <Button size="sm" disabled={!ready || busyNow} onClick={() => void session.captureFrame("first")}>截取首帧</Button>
      <Button size="sm" tone="primary" disabled={!ready || busyNow} onClick={() => void session.captureFrame("current")}>截取当前帧</Button>
      <Button size="sm" disabled={!ready || busyNow} onClick={() => void session.captureFrame("last")}>截取尾帧</Button>
    </div>
  );
}

/** 已捕获帧列表：选择/取消、移除、逐项结果。 */
export function CaptureFrameList({ session }: { session: CaptureSession }) {
  const { frames, receipts, busyNow } = session;
  return (
    <aside className="video-frame-dialog__frames" aria-label="已截取视频帧">
      <div className="video-frame-dialog__frames-head">
        <strong>已截取帧</strong>
        <span>{frames.length} 个画面</span>
        <button type="button" disabled={frames.length === 0 || busyNow} onClick={session.clearFrames}>清空</button>
      </div>
      <div className="video-frame-dialog__frame-list">
        {frames.length > 0 ? (
          frames.map((frame, index) => {
            const receipt = receipts.find((entry) => entry.frameId === frame.id);
            const failed = receipt ? !receipt.ok : false;
            return (
              <div key={frame.id} className={`video-frame-dialog__frame${frame.selected ? " is-selected" : ""}${failed ? " is-failed" : ""}`}>
                <button
                  type="button"
                  className="video-frame-dialog__frame-toggle"
                  aria-pressed={frame.selected}
                  disabled={busyNow}
                  onClick={() => session.toggleFrame(frame.id)}
                >
                  {frame.url ? <img src={frame.url} alt={`视频帧 ${formatVideoTime(frame.timeSeconds)}`} /> : <span className="video-frame-dialog__frame-fallback">帧</span>}
                  <span className="video-frame-dialog__frame-time">{formatVideoTime(frame.timeSeconds)}</span>
                  {frame.selected ? <span className="video-frame-dialog__frame-check" aria-hidden="true">✓</span> : null}
                </button>
                <div className="video-frame-dialog__frame-copy">
                  <strong>截取帧 {String(index + 1).padStart(2, "0")}</strong>
                  <small>{formatVideoTime(frame.timeSeconds)}</small>
                  {receipt ? <small className={receipt.ok ? "is-ok" : "is-error"}>{receipt.ok ? "已添加" : receipt.error}</small> : null}
                </div>
                <DialogIconButton
                  label={`移除截取帧 ${index + 1}`}
                  tooltip="移除该帧"
                  icon={<TrashIcon className="dlg__icon" />}
                  disabled={busyNow}
                  onClick={() => session.removeFrame(frame.id)}
                />
              </div>
            );
          })
        ) : (
          <p className="video-frame-dialog__empty">还没有截取视频帧。截取的画面会显示在这里。</p>
        )}
      </div>
    </aside>
  );
}

/** Footer 主操作：选择计数 + 重试失败项 + 添加全部/选中。 */
export function CaptureFooterActions({ session }: { session: CaptureSession }) {
  const { frames, pendingFrameIds, busyNow, selectedCount } = session;
  return (
    <>
      <span>已选择 {selectedCount} / {frames.length}</span>
      <div className="video-frame-dialog__footer-actions">
        {pendingFrameIds.length > 0 ? (
          <Button size="sm" disabled={busyNow} onClick={session.retryFailed}>重试失败项（{pendingFrameIds.length}）</Button>
        ) : null}
        <Button size="sm" disabled={frames.length === 0 || busyNow} onClick={session.addAll}>添加全部帧</Button>
        <Button size="sm" tone="primary" disabled={selectedCount === 0 || busyNow} onClick={session.addSelected}>添加选中帧</Button>
      </div>
    </>
  );
}

function createFrameId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `frame-${random}`;
  return `frame-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createObjectUrl(blob: Blob): string | null {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  try {
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

function revokeObjectUrl(url: string | null): void {
  if (!url) return;
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}
