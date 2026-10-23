/**
 * 动画 codec 端口的真实媒体实现（U77，design D2）。
 *
 * 只负责「容器 + WebCodecs」这一层：解复用、逐帧转 RGBA8、复用、编码。编排（协商、取消、
 * 预算预检、错误文案归一）在 `animation-codec-port.ts`，两者分开是为了让端口可以在测试里注入替身，
 * 也让这里只剩「调用媒体库」这一件事。
 *
 * 为什么用 `mediabunny` 而不是自己写 mux/demux 或调 ffmpeg：
 * - 仓库已有该依赖（片场 MP4 导出就走它），不引入第二套容器实现，也不在浏览器里跑 ffmpeg.wasm；
 * - 它内部已经处理了浏览器差异（keyframe 判定、faststart、WebM/MKV 变体）；
 * - 本文件不复制上游 vendored 的 ffmpeg 逻辑，只调用公共 API。
 *
 * 成本控制：
 * - 模块本身由 `defaultMediaKit()` 动态 import，没打开视频工作流的用户不下载；
 * - 解码用 `CanvasSink` 的环形画布池，内存不随帧数线性增长（帧数据本身仍按内核预算受限）；
 * - 帧数在上限处**提前停止**并报告，不把整段解完再交给内核拒绝。
 */
import type { MediaKit } from "./animation-codec-port.js";

/** 端口容器名 → 首选编码器（与 `animation-codec-port.ts` 的 ENCODERS 一致）。 */
const ENCODE_CODEC = { mp4: "avc", webm: "vp9" } as const;

/** 按 contain 缩放到目标上限，**从不放大**（放大只会多耗内存且糊掉细节）。 */
function fitSize(sourceWidth: number, sourceHeight: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale))
  };
}

/** 取一帧画布的可读像素；缺 2D 上下文时抛错（端口层归一成失败原因）。 */
function readPixels(canvas: HTMLCanvasElement | OffscreenCanvas, width: number, height: number): Uint8Array {
  const context = canvas.getContext("2d", { willReadFrequently: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!context) throw new Error("无法读取解码帧像素（缺少 2D 画布上下文）");
  const data = context.getImageData(0, 0, width, height).data;
  // 复制成独立字节：画布池会复用同一张画布，直接持有 `data` 会被下一帧覆盖。
  return new Uint8Array(data.buffer.slice(0));
}

/** 创建离屏编码画布（优先 `document.createElement`，Worker 里退回 OffscreenCanvas）。 */
function createEncodeCanvas(width: number, height: number): {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
} {
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("无法创建视频编码画面，请重试");
    return { canvas, context };
  }
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("无法创建视频编码画面，请重试");
    return { canvas, context };
  }
  throw new Error("当前环境没有可用于视频编码的画布");
}

/**
 * 创建真实媒体实现。
 *
 * 所有失败都以异常抛出，由端口层转成 `{ok:false, reason}`；这样端口是唯一决定「怎么表述失败」
 * 的地方，界面文案不会两处漂移。
 */
export function createAnimationMediaKit(): MediaKit {
  return {
    async decodeVideo(input) {
      const mediabunny = await import("mediabunny");
      // mov 归到 mp4 端口，但 `Mp4InputFormat` 不认 `qt  ` brand，所以要一并给出 QTFF。
      const formats = input.container === "mp4" ? [mediabunny.MP4, mediabunny.QTFF] : [mediabunny.WEBM];
      const media = new mediabunny.Input({ formats, source: new mediabunny.BufferSource(input.bytes) });
      try {
        if (!(await media.canRead())) {
          return { ok: false, reason: `无法解析 ${input.container.toUpperCase()} 容器（文件可能损坏或不是视频）` };
        }
        const track = await media.getPrimaryVideoTrack();
        if (!track) return { ok: false, reason: "视频里没有视频轨道" };
        if (!(await track.canDecode())) {
          const codec = await track.getCodec();
          return { ok: false, reason: `当前浏览器无法解码该视频的编码格式（${codec ?? "未知"}）` };
        }
        // 先按元数据拒绝超长片段：`computePacketStats` 只读包索引，不解码像素。
        const stats = await track.computePacketStats(input.maxFrames + 1);
        if (stats.packetCount > input.maxFrames) {
          return { ok: false, reason: `视频帧数超过上限：${stats.packetCount} > ${input.maxFrames}` };
        }
        const frameCount = stats.packetCount;
        if (frameCount <= 0) return { ok: false, reason: "视频里没有可导入的帧" };

        const sourceWidth = await track.getDisplayWidth();
        const sourceHeight = await track.getDisplayHeight();
        if (!(sourceWidth > 0 && sourceHeight > 0)) return { ok: false, reason: "视频轨道的画面尺寸无效" };
        const size = fitSize(sourceWidth, sourceHeight, input.maxWidth, input.maxHeight);
        const metrics = await track.computeFrameRateMetrics();
        const fpsHint = [metrics.bestGuessFrameRate, stats.averagePacketRate]
          .find((rate) => Number.isFinite(rate) && rate > 0) ?? 0;

        const sink = new mediabunny.CanvasSink(track, {
          width: size.width,
          height: size.height,
          // contain + 透明：不同画幅的视频导入后不被黑边污染，也不拉伸变形。
          fit: "contain",
          alpha: true,
          poolSize: 2
        });
        const frames: Uint8Array[] = [];
        for await (const wrapped of sink.canvases()) {
          if (input.cancelled()) return { ok: false, reason: "已取消" };
          if (frames.length >= input.maxFrames) break;
          frames.push(readPixels(wrapped.canvas, size.width, size.height));
          if (frames.length >= frameCount) break;
        }
        if (frames.length === 0) return { ok: false, reason: "视频里没有可导入的帧" };
        return { ok: true, width: size.width, height: size.height, fps: fpsHint || 24, frames };
      } finally {
        if (!media.disposed) media.dispose();
      }
    },

    async encodeVideo(input) {
      const mediabunny = await import("mediabunny");
      const codec = ENCODE_CODEC[input.container];
      const frameRate = input.fps > 0 ? input.fps : 24;
      const quality = mediabunny.QUALITY_HIGH;
      if (!(await mediabunny.canEncodeVideo(codec, { width: input.width, height: input.height, frameRate, quality }))) {
        throw new Error(
          input.container === "mp4"
            ? "当前浏览器不支持 MP4 所需的 H.264 编码，请改用 WebM 或换新版 Chrome/Edge"
            : "当前浏览器不支持 WebM 所需的 VP9 编码"
        );
      }
      const { canvas, context } = createEncodeCanvas(input.width, input.height);
      const target = new mediabunny.BufferTarget();
      const output = new mediabunny.Output({
        format: input.container === "mp4"
          ? new mediabunny.Mp4OutputFormat({ fastStart: "in-memory" })
          : new mediabunny.WebMOutputFormat(),
        target
      });
      const source = new mediabunny.CanvasSource(canvas, {
        codec,
        quality,
        keyFrameInterval: 2
      });
      output.addVideoTrack(source);
      try {
        await output.start();
      } catch (cause) {
        await output.cancel();
        throw cause;
      }
      const duration = 1 / frameRate;
      try {
        for (let index = 0; index < input.frameCount; index += 1) {
          if (input.cancelled()) throw new Error("已取消");
          const rgba = input.frame(index);
          const expected = input.width * input.height * 4;
          if (rgba.length !== expected) {
            throw new Error(`第 ${index + 1} 帧字节长度与画布尺寸不符：${rgba.length} != ${expected}`);
          }
          // `createImageData` 给出本地 rgba8 缓冲；`set` 复制像素，避免依赖 `rgba` 的底层 buffer 类型。
          const pixels = context.createImageData(input.width, input.height);
          pixels.data.set(rgba);
          context.putImageData(pixels, 0, 0);
          // 时间戳按帧号推进；末帧也用整帧时长，避免播放器把最后一帧显示得比别的短。
          await source.add(index * duration, duration);
        }
        if (input.cancelled()) throw new Error("已取消");
        await output.finalize();
      } catch (error) {
        if (output.state !== "finalized" && output.state !== "canceled") await output.cancel();
        throw error;
      }
      if (!target.buffer) throw new Error("视频封装失败，请重试");
      return new Uint8Array(target.buffer.slice(0));
    }
  };
}
