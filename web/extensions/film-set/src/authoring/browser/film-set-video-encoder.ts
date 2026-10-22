import type { FilmSetVideoEncoder, FilmSetVideoTarget } from "./film-set-video-export.js";
import { exportBitrateOf, exportProfileOf, videoSize } from "./film-set-video-export.js";
import { DEFAULT_MAX_UPLOAD_BYTES, filmSetExportFrameRate, filmSetExportProfileLabel } from "@woohaa3/contracts";

export async function createFilmSetVideoEncoder(target: FilmSetVideoTarget): Promise<FilmSetVideoEncoder> {
  const { Output, BufferTarget, Mp4OutputFormat, CanvasSource, canEncodeVideo } = await import("mediabunny");
  const profile = exportProfileOf(target);
  const fps = filmSetExportFrameRate(profile);
  const bitrate = exportBitrateOf(target);
  const size = videoSize(target.aspect, profile);
  // 按所选档位的尺寸与帧率探测：不支持时报具体错误，不静默降到 720p30。
  if (!await canEncodeVideo("avc", { ...size, frameRate: fps, bitrate }))
    throw new Error(`当前浏览器不支持 ${filmSetExportProfileLabel(profile)}（${size.width}×${size.height}@${fps}fps）所需的 H.264 编码，请降低导出规格或使用新版 Chrome / Edge 后重试`);
  const canvas = document.createElement("canvas");
  canvas.width = size.width; canvas.height = size.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("无法创建视频编码画面，请重试");
  const captureCanvas = document.createElement("canvas");
  const captureContext = captureCanvas.getContext("2d");
  if (!captureContext) throw new Error("无法创建镜头捕捉画面，请重试");
  context.imageSmoothingQuality = "high";
  const buffer = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: buffer });
  let encodedBytes = 0;
  const source = new CanvasSource(canvas, { codec: "avc", bitrate, keyFrameInterval: 2,
    onEncodedPacket(packet) {
      encodedBytes += packet.byteLength;
    }
  });
  // Preserve a fractional final frame duration instead of snapping the movie end to the profile fps.
  output.addVideoTrack(source);
  try { await output.start(); } catch (cause) { await output.cancel(); throw cause; }
  return {
    async add(frame, timestamp, duration) {
      if (frame.width <= 0 || frame.height <= 0 || frame.rgba.length !== frame.width * frame.height * 4)
        throw new Error("镜头捕捉未返回完整画面，请重试");
      // WebGL capture falls back to the preview's physical pixels. Normalize that frame
      // to the movie resolution; CSS / device-pixel rounding may vary by a pixel.
      if (Math.abs((frame.width / frame.height) / (size.width / size.height) - 1) > 0.02)
        throw new Error("镜头捕捉画幅发生变化，视频生成已停止，请重新生成");
      captureCanvas.width = frame.width; captureCanvas.height = frame.height;
      captureContext.putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), frame.width, frame.height), 0, 0);
      context.drawImage(captureCanvas, 0, 0, size.width, size.height);
      await source.add(timestamp, duration);
      if (encodedBytes > DEFAULT_MAX_UPLOAD_BYTES - 1024 * 1024) throw new Error("视频超过 256 MB 保存上限，请缩短片段后重试");
    },
    async finish() {
      await output.finalize();
      if (!buffer.buffer) throw new Error("视频封装失败，请重试");
      if (buffer.buffer.byteLength > DEFAULT_MAX_UPLOAD_BYTES) throw new Error("视频超过 256 MB 保存上限，请缩短片段后重试");
      return new Blob([buffer.buffer], { type: "video/mp4" });
    },
    async cancel() { if (output.state !== "finalized" && output.state !== "canceled") await output.cancel(); }
  };
}
