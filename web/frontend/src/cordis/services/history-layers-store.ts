/**
 * 节点版本「图层」的宿主侧存储：把原来由 Bevy 画在卡片底部的历史圆点，
 * 改为卡片右侧外面的一列缩略图（类似 PS 图层面板）。
 *
 * 数据仍来自同一份运行状态投影（`run-state-projection.ts` 写的 `historyStrip`）：scene-builder 在投影
 * 之后把图片/视频节点的圆点**搬到这里**并从 scene 里删掉，Bevy 就不再画；DOM 浮层订阅本 store 渲染。
 * 点击仍走 `ui.node-history.switch-requested`，版本切换的策略（只预览 / 受控 apply）不变。
 *
 * 只承载浏览器本地派生状态，不进入 ServerCanvas / Y.Doc。
 */
import type { BevyHistoryStripDot } from "@woohaa3/contracts";

/** 一层 = 一个圆点的数据（去掉只服务于 Bevy 指针反馈的 hovered / pressed）。 */
export type HistoryLayer = Omit<BevyHistoryStripDot, "hovered" | "pressed">;

export type NodeHistoryLayers = {
  /** 节点类型（`image` / `video`）：决定缩略图取原图还是视频海报。 */
  nodeType: string;
  /** 按 createdAt 升序（最早在前）；界面按 PS 习惯把最新的放在最上面。 */
  layers: readonly HistoryLayer[];
  /** 被折叠的较早记录数。 */
  truncated: number;
};

type Snapshot = ReadonlyMap<string, NodeHistoryLayers>;

const EMPTY: Snapshot = new Map();

function signatureOf(map: Snapshot): string {
  const parts: string[] = [];
  for (const [nodeId, value] of map) parts.push(`${nodeId}:${value.truncated}:${JSON.stringify(value.layers)}`);
  return parts.join("|");
}

class HistoryLayersStore {
  private snapshot: Snapshot = EMPTY;
  private signature = "";
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** `useSyncExternalStore` 要求同一状态返回同一引用。 */
  getSnapshot = (): Snapshot => this.snapshot;

  /** 整体替换；内容没变（按签名比较）不换引用、不通知，scene 每帧重建也不会引发重渲染。 */
  replace(next: Snapshot): void {
    const signature = signatureOf(next);
    if (signature === this.signature) return;
    this.signature = signature;
    this.snapshot = next.size === 0 ? EMPTY : next;
    for (const listener of this.listeners) listener();
  }

  reset(): void {
    this.replace(EMPTY);
  }
}

export const historyLayersStore = new HistoryLayersStore();
