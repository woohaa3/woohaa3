/**
 * 动态镜头的前端录制：逐帧 RGBA → WebCodecs H.264 → MP4。
 *
 * 渲染在页面 Bevy 运行时内完成（与静态取景同一离屏相机），编码在浏览器 WebCodecs，
 * 不依赖原生 model-renderer。浏览器缺少 VideoEncoder 或 H.264 编码能力时显式不可用，
 * 不降级为图片、也不把预览纹理当媒体。
 */
import { buildMp4Video, type Mp4Sample } from "@woohaa3/contracts";

type EncodedChunkLike = { byteLength: number; copyTo(destination: ArrayBufferView): void; type: string };
type EncoderMetadata = { decoderConfig?: { description?: ArrayBuffer | ArrayBufferView } };
type VideoEncoderLike = {
  configure(config: Record<string, unknown>): void;
  encode(frame: unknown, options?: { keyFrame?: boolean }): void;
  flush(): Promise<void>;
  close(): void;
  state: string;
  encodeQueueSize: number;
};
type VideoFrameLike = { close(): void };
type VideoFrameConstructor = new (data: Uint8Array, init: Record<string, unknown>) => VideoFrameLike;
type VideoEncoderConstructor = new (init: { output: (chunk: EncodedChunkLike, metadata: EncoderMetadata) => void; error: (error: Error) => void }) => VideoEncoderLike;

type WebCodecs = {
  VideoEncoder?: VideoEncoderConstructor;
  VideoFrame?: VideoFrameConstructor;
  isConfigSupported?: (config: Record<string, unknown>) => Promise<{ supported?: boolean }>;
};

export type WorldCameraVideoResult =
  | {
      ok: true;
      mp4: Uint8Array;
      width: number;
      height: number;
      fps: number;
      frames: number;
      durationSeconds: number;
    }
  | { ok: false; code: string; message: string };

function webCodecs(): WebCodecs {
  return globalThis as unknown as WebCodecs;
}

/** WebCodecs H.264 是否可用（同一浏览器内可重复调用）。 */
export async function worldCameraVideoEncodingAvailable(width: number, height: number, fps: number): Promise<boolean> {
  const codecs = webCodecs();
  if (!codecs.VideoEncoder || !codecs.VideoFrame) return false;
  if (!codecs.isConfigSupported) return true;
  try {
    const support = await codecs.isConfigSupported(configFor(width, height, fps));
    return support.supported === true;
  } catch {
    return false;
  }
}

function configFor(width: number, height: number, fps: number): Record<string, unknown> {
  return {
    // Baseline profile：Chrome/Edge 的软硬件编码都覆盖，容器只需 AVC。
    codec: "avc1.42001f",
    width,
    height,
    bitrate: Math.max(2_000_000, Math.round(width * height * fps * 0.12)),
    framerate: fps,
    avc: { format: "avc" },
    latencyMode: "quality"
  };
}

/**
 * 编码一串 RGBA 帧。`frames` 由调用方逐帧产出（渲染与编码交替，内存有界）。
 */
export async function encodeWorldCameraVideo(input: {
  width: number;
  height: number;
  fps: number;
  frames: AsyncIterable<Uint8Array>;
  signal?: AbortSignal;
}): Promise<WorldCameraVideoResult> {
  const { width, height, fps } = input;
  const codecs = webCodecs();
  if (!codecs.VideoEncoder || !codecs.VideoFrame) {
    return { ok: false, code: "dynamic-capture-unsupported", message: "当前浏览器不支持 WebCodecs 视频编码" };
  }
  if (!(await worldCameraVideoEncodingAvailable(width, height, fps))) {
    return { ok: false, code: "dynamic-capture-unsupported", message: "当前浏览器不支持 H.264 视频编码" };
  }

  const samples: Mp4Sample[] = [];
  let description: Uint8Array | null = null;
  const failure: { error: Error | null } = { error: null };
  const encoder = new codecs.VideoEncoder({
    output: (chunk, metadata) => {
      if (!description && metadata.decoderConfig?.description) {
        const view = metadata.decoderConfig.description;
        // Chrome 返回 ArrayBuffer，Safari/其它实现可能是 TypedArray；两种都要支持。
        description = view instanceof ArrayBuffer
          ? new Uint8Array(view).slice()
          : new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
      }
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      samples.push({ bytes, keyframe: chunk.type === "key" });
    },
    error: (error) => {
      failure.error = error;
    }
  });

  try {
    encoder.configure(configFor(width, height, fps));
    let index = 0;
    for await (const rgba of input.frames) {
      if (input.signal?.aborted) return { ok: false, code: "cancelled", message: "视频录制已取消" };
      if (failure.error) return { ok: false, code: "capture-encode-failed", message: failure.error.message };
      if (rgba.byteLength !== width * height * 4) {
        return { ok: false, code: "capture-encode-failed", message: "帧尺寸与输出规格不一致" };
      }
      const frame = new codecs.VideoFrame(rgba, {
        format: "RGBA",
        codedWidth: width,
        codedHeight: height,
        timestamp: Math.round((index * 1_000_000) / fps),
        duration: Math.round(1_000_000 / fps)
      });
      try {
        encoder.encode(frame, { keyFrame: index === 0 });
      } finally {
        frame.close();
      }
      index += 1;
      // 让编码队列与页面渲染交替，避免长动画把所有帧堆进内存。
      while (encoder.encodeQueueSize > 4 && !input.signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 4));
      }
    }
    if (input.signal?.aborted) return { ok: false, code: "cancelled", message: "视频录制已取消" };
    await encoder.flush();
    if (failure.error) return { ok: false, code: "capture-encode-failed", message: failure.error.message };
    const avcC = description ?? deriveAvcC(samples);
    if (!avcC || samples.length === 0) {
      return { ok: false, code: "capture-encode-failed", message: "编码器没有输出可封装的视频帧" };
    }
    const mp4 = buildMp4Video({ width, height, fps, avcC, samples });
    if (!mp4) return { ok: false, code: "capture-encode-failed", message: "MP4 封装失败" };
    return {
      ok: true,
      mp4,
      width,
      height,
      fps,
      frames: samples.length,
      durationSeconds: samples.length / fps
    };
  } catch (error) {
    return {
      ok: false,
      code: failure.error ? "capture-encode-failed" : "capture-render-failed",
      message: error instanceof Error ? error.message : String(error)
    };
  } finally {
    try {
      if (encoder.state !== "closed") encoder.close();
    } catch {
      // 关闭失败不应覆盖真实结果。
    }
  }
}


/**
 * 部分浏览器的 WebCodecs 不返回 `decoderConfig.description`；此时从首个关键帧的
 * AVCC 长度前缀 NAL 中提取 SPS/PPS 组成 avcC，避免整段录制因缺少配置而作废。
 */
function deriveAvcC(samples: readonly Mp4Sample[]): Uint8Array | null {
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  for (const sample of samples) {
    if (!sample.keyframe) continue;
    const bytes = sample.bytes;
    let offset = 0;
    while (offset + 4 <= bytes.length) {
      const length = ((bytes[offset]! << 24) >>> 0) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!;
      offset += 4;
      if (length <= 0 || offset + length > bytes.length) break;
      const nal = bytes.subarray(offset, offset + length);
      offset += length;
      const type = nal[0]! & 0x1f;
      if (type === 7 && !sps) sps = nal.slice();
      else if (type === 8 && !pps) pps = nal.slice();
    }
    if (sps && pps) break;
  }
  if (!sps || !pps || sps.length < 4) return null;
  const out = new Uint8Array(11 + sps.length + pps.length);
  out.set([1, sps[1]!, sps[2]!, sps[3]!, 0xff, 0xe1], 0);
  out[6] = (sps.length >> 8) & 0xff;
  out[7] = sps.length & 0xff;
  out.set(sps, 8);
  out[8 + sps.length] = 1;
  out[9 + sps.length] = (pps.length >> 8) & 0xff;
  out[10 + sps.length] = pps.length & 0xff;
  out.set(pps, 11 + sps.length);
  return out;
}
