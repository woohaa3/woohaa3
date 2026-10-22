/**
 * 图片聚焦本地取景会话（纯逻辑）
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 4.3/4.6；
 *   change: 2026-10-16-integrate-photocraft-image-editing 删掉旧标注编辑器后只保留取景）。
 *
 * 无 DOM/React 依赖：持有编辑手势与进入/退出过渡共用的本地二维取景与源尺寸。
 *
 * 内容编辑（图层、文字、蒙版、命令与撤销、内容指纹、净变化）**全部**归 React 编辑器与内核
 * （`ProjectSession` + wasm），本会话不持有任何内容状态，因此也不参与「是否有未保存修改」判断。
 * 100% 表示 1 源像素 = 1 CSS px；适应窗口可低于手动下限以完整容纳大图。
 */
export type ImageFocusViewport = { x: number; y: number; zoom: number };

export type ImageFocusSessionInput = {
  nodeId: string;
  /** 稳定原图资产 id（无工程时为当前输出资产）。 */
  baseAssetId: string;
  baseStorageKey: string;
  sourceWidth: number;
  sourceHeight: number;
};

export class ImageFocusSession {
  readonly nodeId: string;
  readonly baseAssetId: string;
  readonly baseStorageKey: string;
  sourceWidth: number;
  sourceHeight: number;
  private viewport: ImageFocusViewport = { x: 0, y: 0, zoom: 1 };
  private fitZoom = 1;

  constructor(input: ImageFocusSessionInput) {
    this.nodeId = input.nodeId;
    this.baseAssetId = input.baseAssetId;
    this.baseStorageKey = input.baseStorageKey;
    this.sourceWidth = input.sourceWidth;
    this.sourceHeight = input.sourceHeight;
  }

  /** 适应窗口缩放：完整容纳图片（可低于手动下限）。 */
  setFitZoom(fitZoom: number): void {
    const safe = Number.isFinite(fitZoom) && fitZoom > 0 ? fitZoom : 1;
    this.fitZoom = safe;
    this.viewport = { ...this.viewport, zoom: safe };
  }

  viewportState(): ImageFocusViewport {
    return { ...this.viewport };
  }

  /** 直接写入完整本地取景（进入/退出推近动画逐帧插值用）；只影响呈现。 */
  setViewport(viewport: ImageFocusViewport): void {
    this.viewport = { ...viewport };
  }

  currentFitZoom(): number {
    return this.fitZoom;
  }

  /** 原图解码后校正源尺寸（进入时元数据缺失的情况）。 */
  adoptSourceSize(width: number, height: number): void {
    if (Number.isFinite(width) && width > 0) this.sourceWidth = width;
    if (Number.isFinite(height) && height > 0) this.sourceHeight = height;
  }
}
