/**
 * 视频截帧 dialog renderer
 * （change: port-video-editing-dialogs，任务 2.1–2.5；design D2/D3/D6/D10；
 *  change: 2026-10-10-add-video-node-focus-workspace，任务 3.1：抽出共享主体，Dialog 只做 shell）。
 *
 * 只消费 Plugin 注入的稳定视频身份 + 同源播放 URL 与 `onAdd` 动作；不直接上传/提交命令，
 * 也不把 Blob/object URL 写入规范状态。播放/seek/静音、首/当前/尾帧捕获、多帧选择/清空、
 * 批量添加与逐项结果都由共享 `useCaptureSession` 提供；busy 时禁止隐式关闭与重复捕获
 * （dialog dismissible policy）。跨域 tainted canvas 的 SecurityError 映射为可恢复错误。
 */
import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogMediaWorkspace,
  DialogStage,
  DialogTitle
} from "../../services/dialogs/Dialog.js";
import { PlayIcon, PauseIcon } from "../../../shared/ui/index.js";
import type { DialogRendererProps } from "../../services/dialogs/renderer-registry.js";
import {
  useCaptureSession,
  CaptureButtons,
  CaptureFooterActions,
  CaptureFrameList,
  CapturePlaybackControls,
  type CaptureInitialState,
  type CaptureState
} from "./capture-shell.js";
import { videoElementSource } from "./capture-frames.js";
import type { FrameAddAction, VideoDialogPayload } from "./types.js";

type CreatorDeps = {
  /** 从 payload 与注入动作创建 renderer；返回的 renderer 由 Plugin 注册。 */
  onAddFrames: FrameAddAction;
  /**
   * showcase/test 注入的初始状态（生产不传）。仅用于展示已有帧、busy、错误与部分失败态；
   * 不参与任何网络或规范状态写入。
   */
  story?: FrameCaptureStorySeed;
};

export type FrameCaptureStorySeed = {
  frames?: readonly import("./types.js").CapturedFrameEntry[];
  error?: string | null;
  receipts?: readonly import("./types.js").FrameAddReceipt[];
  captureBusy?: "first" | "current" | "last" | "add" | null;
  video?: Partial<CaptureState>;
};

export function createFrameCaptureRenderer({ onAddFrames, story }: CreatorDeps) {  return function FrameCaptureRenderer({ instance, requestClose, setBusy }: DialogRendererProps) {
    const payload = instance.payload as VideoDialogPayload;
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [source, setSource] = useState<ReturnType<typeof videoElementSource> | null>(null);
    const initial: CaptureInitialState | undefined = story
      ? {
          ...(story.frames ? { frames: story.frames } : {}),
          ...(story.receipts ? { receipts: story.receipts } : {}),
          ...(story.captureBusy !== undefined ? { busy: story.captureBusy } : {}),
          ...(story.error !== undefined ? { error: story.error } : {}),
          ...(story.video ? { video: { ready: true, muted: story.video.muted ?? false, playing: story.video.playing ?? false, ...story.video } } : {})
        }
      : undefined;    const session = useCaptureSession({
      source,
      instanceId: instance.instanceId,
      targetNodeId: payload.targetNodeId,
      onAddFrames,
      onAllAdded: requestClose,
      ...(initial ? { initial } : {})
    });
    useEffect(() => {
      const video = videoRef.current;
      if (!video) return undefined;
      const next = videoElementSource(video);
      setSource(next);
      return () => setSource(null);
    }, []);
    useEffect(() => {
      setBusy(session.busyNow);
    }, [session.busyNow, setBusy]);
    const busyNow = session.busyNow;

    return (
      <Dialog.Content
        variant="media"
        size="lg"
        busy={busyNow}
        labelledBy={`${instance.instanceId}-title`}
        describedBy={`${instance.instanceId}-desc`}
        instanceId={instance.instanceId}
        onOverlayClick={busyNow ? undefined : requestClose}
      >
        <DialogHeader onClose={busyNow ? undefined : requestClose}>
          <DialogTitle id={`${instance.instanceId}-title`}>视频截帧</DialogTitle>
          <p className="dlg__description" id={`${instance.instanceId}-desc`}>
            从视频中选择一个或多个画面添加到画布。
          </p>
        </DialogHeader>
        <DialogBody className="dlg__body--media-workspace">
          <DialogMediaWorkspace
            className="video-frame-dialog__workspace"
            aside={<CaptureFrameList session={session} />}
          >
            <section className="video-frame-dialog__preview" aria-label="视频画面">
              <DialogStage className="video-frame-dialog__stage" label="视频画面">
                <div className="video-frame-dialog__player">
                  <video
                    ref={videoRef}
                    className="video-frame-dialog__video"
                    src={payload.videoUrl}
                    poster={payload.posterUrl}
                    preload="auto"
                    playsInline
                    onError={() => session.setError("视频加载失败，无法截帧")}
                  />
                  <button
                    type="button"
                    className="video-frame-dialog__center-play"
                    aria-label={session.videoState.playing ? "暂停视频" : "播放视频"}
                    disabled={!session.ready || busyNow}
                    onClick={() => void session.togglePlayback()}
                  >
                    {session.videoState.playing ? <PauseIcon className="dlg__icon dlg__icon--lg" /> : <PlayIcon className="dlg__icon dlg__icon--lg" />}
                  </button>
                </div>
              </DialogStage>
              <Dialog.Toolbar className="video-frame-dialog__playback" label="视频播放控制">
                <CapturePlaybackControls session={session} />
              </Dialog.Toolbar>
              <CaptureButtons session={session} />
            </section>
          </DialogMediaWorkspace>
        </DialogBody>
        {session.error ? (
          <p className="dlg__error" role="alert">
            {session.error}
          </p>
        ) : null}
        <DialogFooter>
          <CaptureFooterActions session={session} />
        </DialogFooter>
      </Dialog.Content>
    );
  };
}
