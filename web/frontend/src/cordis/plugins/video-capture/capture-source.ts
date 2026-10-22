/**
 * 视频截帧的共享解码源抽象
 * （change: 2026-10-10-add-video-node-focus-workspace，任务 3.1）。
 *
 * 截帧主体（播放/seek/静音/首当前尾帧捕获）不直接持有 `<video>`，而是消费一个
 * `FrameCaptureSource`：
 * - 输入视频截帧 Dialog 用 `videoElementSource` 包装其可见 `<video>`；
 * - 视频聚焦工作区用其独有的 detachment 解码元素实现同一接口。
 *
 * 这样聚焦与 Dialog 复用**同一**播放/捕获主体，且聚焦只存在一个活动解码源（design D2/D3）。
 * 源只承载会话内可丢弃状态（currentTime/muted/尺寸），不写规范状态。
 */
export type CaptureState = {
  duration: number;
  currentTime: number;
  playing: boolean;
  muted: boolean;
  ready: boolean;
  width: number;
  height: number;
};

export type FrameCaptureSource = {
  /** 当前可读状态快照。 */
  state(): CaptureState;
  /** 状态变化订阅（loaded/seek/play/pause/duration）；返回退订函数。 */
  subscribe(listener: () => void): () => void;
  play(): Promise<void>;
  pause(): void;
  seek(time: number): Promise<void>;
  setMuted(muted: boolean): void;
  /** 读取当前画面为 PNG Blob（源视频尺寸）；可能抛出 SecurityError 等。 */
  capture(): Promise<Blob>;
};

export function emptyCaptureState(): CaptureState {
  return { duration: 0, currentTime: 0, playing: false, muted: false, ready: false, width: 0, height: 0 };
}
