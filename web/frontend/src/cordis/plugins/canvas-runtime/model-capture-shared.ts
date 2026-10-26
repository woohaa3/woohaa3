/**
 * 离屏捕获共享工具：单飞锁与 RGBA→PNG 编码
 * （change: 2026-10-26-move-generation-history-to-ai-center，design D6）。
 *
 * 镜头截图与模型历史缩略图都从**同一个** Bevy App 的回读通道取像素。桥接槽是
 * latest-wins 单槽，因此两类作业必须共享同一把锁，任何时刻只有一个在飞，否则后到的
 * 请求会让前一个超时。
 */

/** 捕获通道互斥锁：保证任一时刻只有一个离屏捕获在飞行。 */
let captureLock: Promise<void> = Promise.resolve();

export function acquireCaptureLock(): Promise<() => void> {
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = captureLock;
  captureLock = previous.then(() => next);
  return previous.then(() => release);
}

/** RGBA 字节 → PNG Blob（OffscreenCanvas / DOM canvas；无可用 canvas 时返回 null）。 */
export async function rgbaToPngBlob(rgba: Uint8Array, width: number, height: number): Promise<Blob | null> {
  const data = new Uint8ClampedArray(rgba.length);
  // Readback 可能带行对齐填充；只取 width*height*4。
  const expected = width * height * 4;
  data.set(rgba.subarray(0, Math.min(rgba.length, expected)));
  try {
    const offscreen = (globalThis as { OffscreenCanvas?: new (w: number, h: number) => OffscreenCanvas }).OffscreenCanvas;
    if (offscreen) {
      const canvas = new offscreen(width, height);
      const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
      if (context) {
        context.putImageData(new ImageData(data, width, height), 0, 0);
        return await canvas.convertToBlob({ type: "image/png" });
      }
    }
    if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (context) {
        context.putImageData(new ImageData(data, width, height), 0, 0);
        return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
      }
    }
  } catch {
    return null;
  }
  return null;
}
