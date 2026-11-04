/**
 * 瞬时 hover 节点存储
 * （change: 2026-10-06-fix-model-media-references-and-animation-preview 的交互补充；
 *   动画节点 hover 播放）。
 *
 * 运行时（`interaction-hover.ts`）在指针 hover 结算时写入当前指针下的节点 id；插件层
 * （如 animation-playback）订阅它来决定活动动画节点。与 selection-store 同为页面级单例，
 * 只承载**可丢弃瞬时呈现态**：不写 Y.Doc、不推进 revision、刷新后从空开始。
 *
 * 手势进行中、modal 阻断或输入清除时写入 null，从而停止 hover 播放并复位姿态。
 */

export type HoverSnapshot = {
  /** 指针当前 hover 的节点 id；无则 null。 */
  nodeId: string | null;
};

const EMPTY: HoverSnapshot = Object.freeze({ nodeId: null });

export type HoverListener = () => void;

export class HoverNodeStore {
  private playbackGate: (() => boolean) | null = null;
  /** Deadline reads consult the live input owner, including modal changes between frames. */
  bindPlaybackGate(gate: () => boolean): () => void {
    this.playbackGate = gate;
    return () => { if (this.playbackGate === gate) this.playbackGate = null; };
  }
  private playbackOwners = 0;
  hasPlaybackOwner = () => this.playbackOwners > 0;
  /** Capture uses the same eligibility publisher as pointer/viewport input. */
  acquirePlaybackOwner(): () => void {
    this.playbackOwners++;
    this.invalidatePlayback();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.playbackOwners--;
      this.invalidatePlayback();
    };
  }
  /** 失效当前播放资格；capture 等更高优先级 owner 释放后由下一次输入重新判定。 */
  invalidatePlayback(): void {
    for (const listener of this.listeners) listener();
  }
  private snapshot: HoverSnapshot = EMPTY;
  private readonly listeners = new Set<HoverListener>();

  getSnapshot = (): HoverSnapshot => this.snapshot;

  subscribe = (listener: HoverListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 归一化的当前 hover 节点 id。 */
  getNodeId(): string | null {
    return this.snapshot.nodeId;
  }

  /** 设置 hover 节点（相同引用不复通知）。 */
  setNodeId(nodeId: string | null): void {
    if (nodeId === this.snapshot.nodeId) return;
    this.snapshot = nodeId === null ? EMPTY : { nodeId };
    for (const listener of this.listeners) listener();
  }

  /**
   * 复位（页面/画布切换、测试清理）：hover 与播放投影一起回到空态，只通知一次。
   *
   * 这里直接落 `EMPTY` 再交给 `invalidatePlayback()` 统一通知，避免同一操作通知两轮
   * （旧写法先 invalidatePlayback 再 setNodeId，订阅者会多收一次）。
   */
  reset(): void {
    this.snapshot = EMPTY;
    this.invalidatePlayback();
  }
}

/** 页面级单例。 */
export const hoverNodeStore = new HoverNodeStore();
