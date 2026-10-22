/**
 * v1 标注 → PNG 位图（工程转换用）
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 3.3 / design D7）。
 *
 * 旧标注定义（`woohaa-image-edit-v1`）的每条 shape 在进入工程会话时转换为**一个像素层**：
 * 这里只负责把一条 shape 渲染成源分辨率的 PNG 字节，置入由内核的 `placeImage` 完成。
 *
 * 归一化坐标 → 源像素的换算复用旧标注的 `drawShape`，因此转换后的画面与旧编辑器所见一致。
 * 本模块需要 DOM Canvas；调用方在渲染不可用时回退旧标注分支（不静默丢弃标注）。
 */
import { drawShape, type ContentRect, type DrawableShape } from "@woohaa3/frontend/plugin-api";

/** 转换所需的最小 shape 视图（与 `ImageEditShape` 的绘制字段一致）。 */
export type RasterizableAnnotation = {
  tool: "pen" | "rect";
  color: string;
  /** 以源像素表达的线宽。 */
  widthInSourcePixels: number;
  points: readonly { x: number; y: number }[];
};

/** 一条标注对应的稳定资产 id（转换后写进工程描述符的来源集合）。 */
export function annotationAssetId(shapeId: string): string {
  return `annotation-${shapeId}`;
}

function toPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve(null);
        return;
      }
      void blob
        .arrayBuffer()
        .then((buffer) => resolve(new Uint8Array(buffer)))
        .catch(() => resolve(null));
    }, "image/png");
  });
}

/**
 * 把一条 v1 标注渲染成源分辨率 PNG。
 *
 * 失败（无 Canvas 2D、尺寸非法、无法编码）返回 `null`，调用方必须回退旧标注分支。
 */
export async function rasterizeAnnotation(
  shape: RasterizableAnnotation,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const content: ContentRect = { x: 0, y: 0, width, height };
  // 线宽以源像素表达，画布即源分辨率，因此 1:1 传入。
  drawShape(context, shape as DrawableShape, content, shape.widthInSourcePixels);
  return toPngBytes(canvas);
}
