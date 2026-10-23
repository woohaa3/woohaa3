/**
 * 宿主动画 codec 端口回归（U77，change: 2026-10-22-add-photocraft-animation-workflows）。
 *
 * 用注入的 `MediaKit` 替身覆盖端口这一层的契约，**不**触碰真实 WebCodecs/容器：
 * - `supports` 走真实异步探测（替身 `isConfigSupported`），不是乐观宣称可用；
 * - `decode`/`encode` 只在协商通过后被调用，失败给具体原因；
 * - `cancel` 幂等，取消后不再产出结果（晚到结果被丢弃）；
 * - 媒体库加载失败、容器不认识、缺 WebCodecs 都各有明确文案。
 *
 * 真实编解码（真实 MP4/WebM 字节）需要真实浏览器 + WebCodecs，属人工验证项。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnimationCodecPort, type MediaKit } from "../src/animation-codec-port.js";

type Support = { supported: boolean };

/** 装一套可控的 WebCodecs 探测桩；`supported` 决定 isConfigSupported 的回答。 */
function installWebCodecs(supported: (config: { codec: string }) => boolean = () => true): {
  encoderQueries: string[];
  decoderQueries: string[];
} {
  const encoderQueries: string[] = [];
  const decoderQueries: string[] = [];
  class VideoEncoder {
    static async isConfigSupported(config: { codec: string }): Promise<Support> {
      encoderQueries.push(config.codec);
      return { supported: supported(config) };
    }
  }
  class VideoDecoder {
    static async isConfigSupported(config: { codec: string }): Promise<Support> {
      decoderQueries.push(config.codec);
      return { supported: supported(config) };
    }
  }
  (globalThis as unknown as { VideoEncoder: unknown }).VideoEncoder = VideoEncoder;
  (globalThis as unknown as { VideoDecoder: unknown }).VideoDecoder = VideoDecoder;
  return { encoderQueries, decoderQueries };
}

function kit(overrides: Partial<MediaKit> = {}): MediaKit {
  return {
    decodeVideo: async (input) => ({
      ok: true,
      width: Math.min(input.maxWidth, 8),
      height: Math.min(input.maxHeight, 8),
      fps: 24,
      frames: [new Uint8Array(8 * 8 * 4)]
    }),
    encodeVideo: async () => new Uint8Array([1, 2, 3]),
    ...overrides
  };
}

const request = {
  requestId: "req-1",
  fileName: "clip.mp4",
  bytes: new Uint8Array([0, 1, 2]),
  maxWidth: 64,
  maxHeight: 64,
  fps: 24,
  maxFrames: 120
};

afterEach(() => {
  delete (globalThis as unknown as { VideoEncoder?: unknown }).VideoEncoder;
  delete (globalThis as unknown as { VideoDecoder?: unknown }).VideoDecoder;
});

describe("宿主动画 codec 端口", () => {
  it("真实协商：只支持容器内的编码时给出可用容器与编码，否则给出具体原因", async () => {
    installWebCodecs((config) => config.codec.startsWith("avc"));
    const port = createAnimationCodecPort(async () => kit());

    await expect(port.supports({ direction: "encode", container: "mp4" })).resolves.toEqual({
      supported: true,
      container: "mp4",
      codec: "avc"
    });
    // 只支持 H.264 的宿主不能宣称能出 VP9/WebM。
    const webm = await port.supports({ direction: "encode", container: "webm" });
    expect(webm.supported).toBe(false);
    expect(webm.supported === false && webm.reason).toContain("VP9");
  });

  it("不认识容器或缺 WebCodecs 时立刻给原因，不加载媒体库", async () => {
    const load = vi.fn(async () => kit());
    const port = createAnimationCodecPort(load);

    const unknown = await port.supports({ direction: "decode", container: "avi" });
    expect(unknown.supported).toBe(false);
    expect(unknown.supported === false && unknown.reason).toContain("mp4 / webm");

    // 未安装桩 = 没有 WebCodecs。
    const missing = await port.supports({ direction: "decode", container: "mp4" });
    expect(missing.supported).toBe(false);
    expect(missing.supported === false && missing.reason).toContain("WebCodecs");
    expect(load).not.toHaveBeenCalled();
  });

  it("解码按文件名识别容器，透传预算并把端口结果原样交回", async () => {
    installWebCodecs();
    const calls: Parameters<MediaKit["decodeVideo"]>[0][] = [];
    const port = createAnimationCodecPort(async () => kit({
      decodeVideo: async (input) => {
        calls.push(input);
        return { ok: true, width: 8, height: 4, fps: 30, frames: [new Uint8Array(8 * 4 * 4)] };
      }
    }));

    const decoded = await port.decode({ ...request, fileName: "CLIP.MOV" });
    expect(decoded.ok).toBe(true);
    expect(calls[0]?.container).toBe("mp4");
    expect(calls[0]?.maxFrames).toBe(120);
    expect(calls[0]?.maxWidth).toBe(64);
  });

  it("媒体库的拒绝原因直接上抛，不被重新编造", async () => {
    installWebCodecs();
    const port = createAnimationCodecPort(async () => kit({
      decodeVideo: async () => ({ ok: false, reason: "视频帧数超过上限：200 > 120" })
    }));
    await expect(port.decode(request)).resolves.toEqual({ ok: false, reason: "视频帧数超过上限：200 > 120" });
  });

  it("媒体库加载失败与未知容器各自给出原因", async () => {
    installWebCodecs();
    const broken = createAnimationCodecPort(async () => { throw new Error("chunk 404"); });
    const failure = await broken.decode(request);
    expect(failure.ok).toBe(false);
    expect(failure.ok === false && failure.reason).toContain("媒体库加载失败");

    const unknown = await broken.decode({ ...request, fileName: "clip.avi" });
    expect(unknown.ok).toBe(false);
    expect(unknown.ok === false && unknown.reason).toContain("无法识别视频容器");
  });

  it("取消后不再产出结果，并且取消标记随请求释放", async () => {
    installWebCodecs();
    let release: (() => void) | null = null;
    let started: (() => void) | null = null;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let first = true;
    const port = createAnimationCodecPort(async () => kit({
      decodeVideo: async () => {
        // 只有第一次调用会被挂起，用来模拟「解码进行中」。
        if (first) {
          first = false;
          started!();
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return { ok: true, width: 8, height: 8, fps: 24, frames: [new Uint8Array(8 * 8 * 4)] };
      }
    }));

    const inFlight = port.decode(request);
    // 等到媒体库真的开始解码，再取消（此时结果还没产出）。
    await entered;
    port.cancel(request.requestId);
    release!();
    const result = await inFlight;
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("已取消");

    // 同一个 requestId 再次使用时不再被旧取消标记影响。
    const again = await port.decode({ ...request, requestId: "req-2" });
    expect(again.ok).toBe(true);
  });

  it("编码按协商容器产出字节，容器缺省时按 MP4", async () => {
    installWebCodecs();
    const containers: string[] = [];
    const port = createAnimationCodecPort(async () => kit({
      encodeVideo: async (input) => { containers.push(input.container); return new Uint8Array([9]); }
    }));
    const frame = new Uint8Array(4);

    await expect(port.encode({
      requestId: "e1", width: 2, height: 2, fps: 24, frameCount: 1, frame: () => frame
    })).resolves.toEqual({ ok: true, container: "mp4", bytes: new Uint8Array([9]) });
    await expect(port.encode({
      requestId: "e2", width: 2, height: 2, fps: 24, frameCount: 1, container: "webm", frame: () => frame
    })).resolves.toMatchObject({ ok: true, container: "webm" });
    expect(containers).toEqual(["mp4", "webm"]);
  });

  it("编码拒绝不由端口支持的容器，且不调用媒体库", async () => {
    installWebCodecs();
    const load = vi.fn(async () => kit());
    const port = createAnimationCodecPort(load);
    const rejected = await port.encode({
      requestId: "e3", width: 2, height: 2, fps: 24, frameCount: 1, container: "mkv", frame: () => new Uint8Array(4)
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.ok === false && rejected.reason).toContain("mp4 / webm");
    expect(load).not.toHaveBeenCalled();
  });

  it("编码过程中被取消时返回已取消，而不是半份字节", async () => {
    installWebCodecs();
    let port: ReturnType<typeof createAnimationCodecPort>;
    port = createAnimationCodecPort(async () => kit({
      encodeVideo: async (input) => {
        port.cancel("e4");
        // 端口传入的取帧回调必须感知取消。
        if (input.cancelled()) throw new Error("已取消");
        return new Uint8Array([1]);
      }
    }));
    const canceled = await port.encode({
      requestId: "e4", width: 2, height: 2, fps: 24, frameCount: 1, frame: () => new Uint8Array(4)
    });
    expect(canceled.ok).toBe(false);
    expect(canceled.ok === false && canceled.reason).toBe("已取消");
  });

  it("取帧回调在取消后抛错，阻止继续编码", async () => {
    installWebCodecs();
    let port: ReturnType<typeof createAnimationCodecPort>;
    let captured: ((index: number) => Uint8Array) | null = null;
    port = createAnimationCodecPort(async () => kit({
      encodeVideo: async (input) => { captured = input.frame; return new Uint8Array([1]); }
    }));
    await port.encode({
      requestId: "e5", width: 2, height: 2, fps: 24, frameCount: 1, frame: () => new Uint8Array(4)
    });
    port.cancel("e5");
    expect(() => captured!(0)).toThrow("已取消");
  });
});
