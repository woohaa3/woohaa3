/**
 * 帧序列交付（U77，design D2/D4）：把时间轴的每一帧编成 PNG，逐帧交给浏览器下载。
 *
 * 为什么在浏览器侧编码：内核交付的是 RGBA8 快照（[`renderFrame`]），PNG 容器由浏览器
 * `canvas.convertToBlob`/`toBlob` 负责。这样帧序列不需要宿主 codec 端口，是「无 codec 也能
 * 交付」的那条路径；MP4/WebM 仍走 `AnimationCodecPort`。
 *
 * 约束：
 * - 逐帧渲染、逐帧编码，**不**把整段时间轴一次性读进内存；
 * - 任意一帧渲染/编码失败则整次交付失败并给出帧号，不下载半份序列；
 * - `cancelled()` 在每帧边界检查，取消后不再产出（已下载的前缀保留，界面据此如实报告）。
 */

export type FramePixels = { ok: true; value: Uint8Array } | { ok: false; message: string };

export type PngEncoder = (rgba: Uint8Array, width: number, height: number) => Promise<Uint8Array | null>;

export type FrameSequenceResult =
  | { ok: true; frames: { name: string; bytes: Uint8Array }[] }
  | { ok: false; message: string; delivered: number };

export type FrameSequenceRequest = {
  frames: number;
  width: number;
  height: number;
  /** 逐帧取 RGBA8（调用方通常接内核 `renderFrame`）。 */
  render: (frame: number) => FramePixels;
  /** 文件名前缀；实际文件名是 `<prefix>-0001.png`。 */
  name?: string;
  cancelled?: () => boolean;
  /** 编码器可注入，便于测试；缺省用 canvas。 */
  encode?: PngEncoder;
};

/** 浏览器 canvas 编码：优先 OffscreenCanvas，退回 `<canvas>`。 */
export const canvasPngEncoder: PngEncoder = async (rgba, width, height) => {
  const pixels = new Uint8ClampedArray(rgba.length);
  pixels.set(rgba);
  const image = typeof ImageData === "function" ? new ImageData(pixels, width, height) : null;
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    if (image) context.putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context || !image) return null;
  context.putImageData(image, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
};

/** 逐帧渲染并编码成 PNG 序列（不触发下载；下载由界面负责）。 */
export async function encodeFrameSequence(request: FrameSequenceRequest): Promise<FrameSequenceResult> {
  if (!Number.isSafeInteger(request.frames) || request.frames <= 0) {
    return { ok: false, message: "没有可交付的帧", delivered: 0 };
  }
  if (!Number.isSafeInteger(request.width) || !Number.isSafeInteger(request.height) || request.width <= 0 || request.height <= 0) {
    return { ok: false, message: "交付尺寸无效", delivered: 0 };
  }
  const expected = request.width * request.height * 4;
  const digits = String(request.frames).length > 4 ? String(request.frames).length : 4;
  const prefix = (request.name ?? "frame").replace(/[\\/:*?"<>|]+/g, "-");
  const encode = request.encode ?? canvasPngEncoder;
  const frames: { name: string; bytes: Uint8Array }[] = [];
  for (let frame = 0; frame < request.frames; frame += 1) {
    if (request.cancelled?.()) {
      return { ok: false, message: `已取消：已交付 ${frames.length} / ${request.frames} 帧`, delivered: frames.length };
    }
    const rendered = request.render(frame);
    if (!rendered.ok) return { ok: false, message: `第 ${frame + 1} 帧渲染失败：${rendered.message}`, delivered: frames.length };
    if (rendered.value.length !== expected) {
      return { ok: false, message: `第 ${frame + 1} 帧字节长度与交付尺寸不符：${rendered.value.length} != ${expected}`, delivered: frames.length };
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await encode(rendered.value, request.width, request.height);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "未知错误";
      return { ok: false, message: `第 ${frame + 1} 帧 PNG 编码失败：${reason}`, delivered: frames.length };
    }
    if (!bytes || bytes.length === 0) {
      return { ok: false, message: `第 ${frame + 1} 帧 PNG 编码失败：编码器没有输出`, delivered: frames.length };
    }
    frames.push({ name: `${prefix}-${String(frame + 1).padStart(digits, "0")}.png`, bytes });
  }
  return { ok: true, frames };
}
