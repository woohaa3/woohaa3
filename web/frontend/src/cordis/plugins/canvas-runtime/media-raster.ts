import { measureVideoPhase } from "../../performance/interaction-phase-profiler.js";
/**
 * 可绘制媒体（图片/视频帧）→ RGBA 光栅化工具
 * （change: enable-video-node-live-preview，design D1/D4）。
 *
 * 图片与视频帧共用同一「按自身宽高比缩放到最长边上限、再取 RGBA」的路径：纹理尺寸等于
 * 源内容尺寸（等比缩放），不填充、不裁剪，Bevy 侧 contain 后必然顶住内容框某一轴。
 *
 * canvas 工厂可注入，便于在无 DOM 的单元测试里验证尺寸、比例与迟到防护。
 */
import { TEXTURE_MAX_DIMENSION } from "./texture-sync.js";

/** 与 Rust protocol::MAX_TEXTURE_EDGE 保持一致；原图编辑/导出不受 GPU 预览上限影响。 */
export const BEVY_TEXTURE_MAX_DIMENSION = 2048;

export type DrawableSource = { width: number; height: number };

/** RGBA 像素缓冲；保留 buffer/byteOffset 以便零拷贝转发，不做整帧复制。 */
export type RasterPixels = ArrayLike<number> & {
  readonly buffer: ArrayBufferLike;
  readonly byteOffset: number;
  readonly byteLength: number;
};

export type RasterContext = {
  drawImage: (source: unknown, dx: number, dy: number, dw: number, dh: number) => void;
  getImageData: (x: number, y: number, w: number, h: number) => { data: RasterPixels };
};

/** 读像素画布上下文选项；见 [`RASTER_READBACK_OPTIONS`]。 */
export type RasterContextOptions = { willReadFrequently?: boolean };

export type RasterCanvas = {
  width: number;
  height: number;
  getContext: (type: "2d", options?: RasterContextOptions) => RasterContext | null;
};

/**
 * 光栅画布从不上屏，只做 `drawImage` + `getImageData`：声明 `willReadFrequently` 让浏览器
 * 使用内存后备缓冲，`getImageData` 不再触发每帧 GPU→CPU 回读与流水线同步
 * （实测该回读占画布视频帧上传耗时的约 80%，见 change notes/video-path-optimization）。
 */
export const RASTER_READBACK_OPTIONS: RasterContextOptions = { willReadFrequently: true };

export type RasterCanvasFactory = () => RasterCanvas;

export type RasterizedMedia = { pixels: Uint8Array; width: number; height: number };

/** 按最长边上限等比缩放，保持源比例。 */
export function scaleToMaxDimension(
  sourceWidth: number,
  sourceHeight: number,
  maxDimension: number
): { width: number; height: number } {
  const safeWidth = Math.max(1, Math.round(sourceWidth));
  const safeHeight = Math.max(1, Math.round(sourceHeight));
  const scale = Math.min(1, maxDimension / Math.max(safeWidth, safeHeight));
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale))
  };
}

/**
 * 把可绘制媒体缩放到最长边 `maxDimension` 内并取 RGBA。
 *
 * `drawable` 是真正交给 `drawImage` 的对象（`HTMLImageElement` / `HTMLVideoElement` /
 * `ImageBitmap`）；其尺寸从 `size` 显式给出，避免依赖不同元素上不一致的尺寸属性名。
 * 源尺寸非法（0/NaN）或拿不到 2D context 时返回 null。
 */
export function rasterizeDrawable(
  drawable: unknown,
  size: DrawableSource,
  createCanvas: RasterCanvasFactory,
  maxDimension: number = TEXTURE_MAX_DIMENSION,
  diagnosticVideoNodeId?: string
): RasterizedMedia | null {
  const sourceWidth = Number(size.width);
  const sourceHeight = Number(size.height);
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    return null;
  }
  const { width, height } = scaleToMaxDimension(sourceWidth, sourceHeight, Math.min(maxDimension, BEVY_TEXTURE_MAX_DIMENSION));
  const canvas = createCanvas();
  // 相同尺寸的视频帧复用画布，避免每帧重置绘图缓冲区。
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext("2d", RASTER_READBACK_OPTIONS);
  if (!context) return null;
  const draw = () => context.drawImage(drawable, 0, 0, width, height);
  const read = () => context.getImageData(0, 0, width, height);
  if (diagnosticVideoNodeId) measureVideoPhase("draw-image", diagnosticVideoNodeId, draw);
  else draw();
  const imageData = diagnosticVideoNodeId ? measureVideoPhase("read-pixels", diagnosticVideoNodeId, read) : read();
  // 与 ImageData 共享同一块缓冲（1024² = 4 MB，聚焦 2048² = 16 MB），不再整帧复制。
  const pixels = new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength);
  return { pixels, width, height };
}

/** 默认 canvas 工厂：使用 DOM `<canvas>`。 */
export function defaultRasterCanvasFactory(): RasterCanvas {
  const canvas = document.createElement("canvas");
  return canvas as unknown as RasterCanvas;
}
