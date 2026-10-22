import type { AnimationPlaybackController } from "../shared/playback-controller.js";

export type FilmSetPlaybackSnapshot = {
  nodeId: string | null; clipId: string | null; preview: boolean;
  time: number; duration: number; playing: boolean; error: string | null;
  sourceIdentity: string | null; generation: number;
  mode: "edit" | "overview-observer" | "focus-preview" | "shot-node-preview"; diagnostics: readonly string[];
};
/** Typed local playback service; selection and clock never submit document commands. */
export class FilmSetPlaybackService {
  private state: FilmSetPlaybackSnapshot = { nodeId: null, clipId: null, preview: false, time: 0, duration: 0, playing: false, error: null, sourceIdentity: null, generation: 0, mode: "edit", diagnostics: [] };
  private listeners = new Set<() => void>();
  private controller: AnimationPlaybackController | null = null;
  private reconcile: (() => void) | null = null;
  /** 镜头参考录制会话：把播放投影锁到该镜头的预览卡片（忽略 hover/聚焦），直到 `endCaptureSession`。 */
  private captureSession: { filmSetNodeId: string; clipId: string; previewNodeId: string } | null = null;
  getSnapshot = (): FilmSetPlaybackSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  connect(controller: AnimationPlaybackController, reconcile: () => void): () => void {
    this.controller = controller; this.reconcile = reconcile;
    return () => { if (this.controller === controller) { this.controller = null; this.reconcile = null; this.update({ nodeId: null, preview: false, playing: false }); } };
  }
  select(nodeId: string, clipId: string | null): void {
    const changed = nodeId !== this.state.nodeId || clipId !== this.state.clipId;
    this.update({ nodeId, clipId, ...(changed ? { time: 0, playing: false, error: null } : {}) });
    this.reconcile?.();
  }
  preview(): void { this.update({ preview: true, time: 0, playing: false, error: null }); this.reconcile?.(); }
  edit(): void { this.update({ preview: false, playing: false, mode: "edit" }); this.reconcile?.(); }
  play(): void { this.controller?.play(); }
  pause(): void { this.controller?.pause(); }
  seek(time: number): void { this.controller?.seek(time); }
  stop(): void { this.controller?.stop(); }
  /**
   * 开始镜头参考录制会话：把播放投影锁到该镜头的预览卡片（`shot-node-preview`，输出目标卡片）。
   *
   * 录制方按 T `seek`，renderer 因此能在片场**非聚焦**时按 T 离屏出该镜头的画面；
   * `reconcile` 在会话期间忽略 hover/聚焦决定。结束必须调用 `endCaptureSession`。
   */
  beginCaptureSession(input: { filmSetNodeId: string; clipId: string; previewNodeId: string }): void {
    this.captureSession = { ...input };
    this.reconcile?.();
  }
  /** 结束录制会话并交还播放投影（缺省回到 hover/聚焦决定）。 */
  endCaptureSession(): void {
    if (!this.captureSession) return;
    this.captureSession = null;
    this.reconcile?.();
  }
  /** 当前录制会话请求；无会话返回 null。 */
  captureSessionRequest(): { filmSetNodeId: string; clipId: string; previewNodeId: string } | null {
    return this.captureSession;
  }
  update(patch: Partial<FilmSetPlaybackSnapshot>): void {
    if (Object.entries(patch).every(([key, value]) => this.state[key as keyof FilmSetPlaybackSnapshot] === value)) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

