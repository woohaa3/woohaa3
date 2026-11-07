/**
 * 全景查看浮层的打开状态。
 *
 * 只是本地视图状态：不写 nodeData / Y.Doc，关闭即丢弃。
 */
export type PanoramaViewState = {
  /** 正在查看的图片节点；null 表示关闭。 */
  nodeId: string | null;
  /** 受控同源媒体地址。 */
  url: string;
  /** 浮层顶部标题 / 下载与截图的文件名。 */
  title: string;
};

const CLOSED: PanoramaViewState = { nodeId: null, url: "", title: "" };

export class PanoramaStore {
  private state: PanoramaViewState = CLOSED;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): PanoramaViewState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  open(nodeId: string, url: string, title = ""): void {
    this.apply({ nodeId, url, title });
  }

  close(): void {
    if (this.state === CLOSED) return;
    this.apply(CLOSED);
  }

  private apply(next: PanoramaViewState): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}

export const panoramaStore = new PanoramaStore();

/** 等距柱状全景的宽高比是 2:1；允许 5% 偏差（取整、裁边造成的误差）。 */
export const PANORAMA_ASPECT = 2;
export const PANORAMA_ASPECT_TOLERANCE = 0.05;

export function isEquirectangular(width: number, height: number): boolean {
  if (!(width > 0) || !(height > 0)) return false;
  return Math.abs(width / height / PANORAMA_ASPECT - 1) <= PANORAMA_ASPECT_TOLERANCE;
}
