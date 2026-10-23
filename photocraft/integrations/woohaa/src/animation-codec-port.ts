/**
 * Woohaa 宿主侧的动画 codec 端口（U77，design D2）。
 *
 * 编辑器核心只依赖公共 `AnimationCodecPort` 契约；本文件是**宿主侧实现**：用浏览器原生
 * WebCodecs 编解码，用 `mediabunny` 负责容器封装/解复。这样：
 *
 * - 内核不运行上游 ffmpeg 子进程，也不 import 任何宿主私有模块；
 * - 能力协商是**真实**的：`supports()` 问 `VideoEncoder/VideoDecoder.isConfigSupported`，
 *   不再假定所有浏览器都能出 H.264；不支持的容器给出具体原因，界面据此禁用而不是静默只取首帧；
 * - 服务端/本机宿主将来可以注册另一个实现，契约不变。
 *
 * 约束（与协议注释一致）：
 * - 端口不接收路径、不写文件；输入是字节，输出是字节；
 * - `cancel(requestId)` 幂等，取消后 `decode`/`encode` 不再产出结果（迟到结果被丢弃）；
 * - 解码按 `maxFrames` 在**读取轨道元数据后**就拒绝，不先解出上千帧；
 * - 解码只在内存里逐帧转成 RGBA8，缩放用 contain 保持宽高比、不放大。
 *
 * 注意：浏览器缺少 WebCodecs 时 `supports` 返回 `supported:false` 与原因，`decode`/`encode`
 * 不会被调用；Node/jsdom 里注册这个端口也不会崩，只是永远「不支持」。
 */
import type {
  AnimationCodecPort,
  AnimationCodecSupport,
  AnimationDecodeRequest,
  AnimationEncodeRequest
} from "@woohaa3/photocraft-protocol";

/** 端口认识的容器，顺序即偏好（与编辑器 `ANIMATION_CONTAINERS` 一致）。 */
const CONTAINERS = ["mp4", "webm"] as const;
type Container = (typeof CONTAINERS)[number];

/** 每个容器的首选编码器与文件名/MIME。 */
const ENCODERS: Record<Container, { codec: "avc" | "vp9"; mimeType: string }> = {
  mp4: { codec: "avc", mimeType: "video/mp4" },
  webm: { codec: "vp9", mimeType: "video/webm" }
};

/**
 * 探测用的 WebCodecs 编码串。
 *
 * 编码侧只有一种：本端口就按它编码（H.264 Baseline / VP9 Profile 0），探它即可。
 * 解码侧列**同一容器的常见编码**：容器本身不决定编码，只探一种会把「能解的 mp4」误判成不可用。
 * 逐文件的具体编码仍在 `decode` 里由媒体库的 `canDecode` 判定。
 */
const PROBE_CODECS: Record<Container, { encode: string; decode: readonly string[] }> = {
  mp4: { encode: "avc1.42001f", decode: ["avc1.42001f", "hvc1.1.6.L93.B0", "av01.0.04M.08"] },
  webm: { encode: "vp09.00.10.08", decode: ["vp09.00.10.08", "vp8", "av01.0.04M.08"] }
};

/** 探测尺寸：1080p 是消费级硬件编码器的通用下限，不拿巨大画幅把可用性探成不可用。 */
const PROBE_SIZE = { width: 1920, height: 1080 } as const;

/** 用户看得懂的编码名（原因文案里同时给编码串，便于排障）。 */
const CODEC_LABEL: Record<Container, string> = { mp4: "H.264", webm: "VP9" };

/** 找不到编解码器时的固定文案（界面直接展示，不自己编造）。 */
const NO_WEBCODECS = "当前浏览器没有 WebCodecs 视频编解码能力";

function isWebCodecs(): boolean {
  return typeof globalThis !== "undefined" &&
    typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder === "function" &&
    typeof (globalThis as { VideoEncoder?: unknown }).VideoEncoder === "function";
}

type VideoEncoderLike = {
  isConfigSupported?: (config: Record<string, unknown>) => Promise<{ supported?: boolean }>;
};

type VideoDecoderLike = {
  isConfigSupported?: (config: Record<string, unknown>) => Promise<{ supported?: boolean }>;
};

/**
 * 真实能力探测（异步）。
 *
 * 只问 WebCodecs，**不**加载媒体库：面板一出现就协商，若为此动态 import 容器库，等于给每个
 * 打开编辑器的用户加一份视频依赖下载。容器封装能力由 `encode`/`decode` 在真正执行时报告。
 *
 * `isConfigSupported` 缺失（极老的实现）时按「有能力尝试」返回可用：此时既不能证明可用，也不该
 * 凭空禁用，实际失败仍会在执行路径上给出具体原因。
 */
async function probe(container: Container, direction: "decode" | "encode"): Promise<AnimationCodecSupport> {
  const scope = globalThis as unknown as { VideoEncoder?: VideoEncoderLike; VideoDecoder?: VideoDecoderLike };
  const method = direction === "encode"
    ? scope.VideoEncoder?.isConfigSupported?.bind(scope.VideoEncoder)
    : scope.VideoDecoder?.isConfigSupported?.bind(scope.VideoDecoder);
  const codec = ENCODERS[container].codec;
  if (typeof method !== "function") return { supported: true, container, codec };
  const candidates = direction === "encode" ? [PROBE_CODECS[container].encode] : PROBE_CODECS[container].decode;
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      // 解码探测只关心「这种编码能否解」，画幅用探测尺寸；编码探测则与真实输出同一条路径。
      const supported = await method({ codec: candidate, ...PROBE_SIZE, ...(direction === "encode" ? { bitrate: 8_000_000, framerate: 30 } : {}) });
      if (supported?.supported === true) return { supported: true, container, codec };
    } catch (error) {
      lastError = error;
    }
  }
  const detail = lastError === null ? "" : `（${messageOf(lastError)}）`;
  return {
    supported: false,
    reason: direction === "encode"
      ? `当前浏览器不能编码 ${container.toUpperCase()} 所需的 ${CODEC_LABEL[container]}（${PROBE_CODECS[container].encode}）${detail}`
      : `当前浏览器不能解码 ${container.toUpperCase()} 里的常见视频编码${detail}`
  };
}

/**
 * 创建一个真实宿主端口。
 *
 * `load()` 让媒体库按需加载（打包体积与首屏都不为视频付出成本）；测试可注入替代实现，
 * 因此本文件不直接 `import "mediabunny"`——真正依赖它的只有 `animation-media-kit.ts`。
 */
export function createAnimationCodecPort(
  load: () => Promise<MediaKit> = defaultMediaKit
): AnimationCodecPort {
  /** 每个请求序号一个取消标记；`cancel` 只置位，不等待。 */
  const cancelled = new Map<string, boolean>();

  const markCancelled = (requestId: string) => { cancelled.set(requestId, true); };
  const isCancelled = (requestId: string) => cancelled.get(requestId) === true;
  const release = (requestId: string) => { cancelled.delete(requestId); };

  const supports = async (input: { container?: string; codec?: string; direction: "decode" | "encode" }): Promise<AnimationCodecSupport> => {
    const container = input.container as Container | undefined;
    if (!container || !CONTAINERS.includes(container)) {
      return { supported: false, reason: `只支持容器 ${CONTAINERS.join(" / ")}：${input.container ?? "未指定"}` };
    }
    if (!isWebCodecs()) return { supported: false, reason: NO_WEBCODECS };
    // 真实探测：`VideoEncoder/VideoDecoder.isConfigSupported` 是异步的，所以 `supports` 也异步。
    // 界面据此在结果回来前保持「正在协商」，不乐观打开入口。
    return probe(container, input.direction);
  };

  const decode = async (request: AnimationDecodeRequest) => {
    const container = containerOf(request.fileName);
    if (!container) return { ok: false as const, reason: `无法识别视频容器：${request.fileName}` };
    if (!isWebCodecs()) return { ok: false as const, reason: NO_WEBCODECS };
    let kit: MediaKit;
    try {
      kit = await load();
    } catch (error) {
      return { ok: false as const, reason: `媒体库加载失败：${messageOf(error)}` };
    }
    if (isCancelled(request.requestId)) return { ok: false as const, reason: "已取消" };
    try {
      const decoded = await kit.decodeVideo({
        bytes: request.bytes,
        container,
        maxWidth: request.maxWidth,
        maxHeight: request.maxHeight,
        maxFrames: request.maxFrames,
        cancelled: () => isCancelled(request.requestId)
      });
      // 双重保险：媒体库可能已经解完才看到取消标记。取消后一律不交出结果，界面因此不会把
      // 「已取消」的帧写进文档（design D4 的晚到结果规则）。
      if (isCancelled(request.requestId)) return { ok: false as const, reason: "已取消" };
      return decoded;
    } catch (error) {
      return { ok: false as const, reason: messageOf(error) };
    } finally {
      release(request.requestId);
    }
  };

  const encode = async (request: AnimationEncodeRequest) => {
    const container = (request.container as Container | undefined) ?? "mp4";
    if (!CONTAINERS.includes(container)) {
      return { ok: false as const, reason: `只支持容器 ${CONTAINERS.join(" / ")}` };
    }
    if (!isWebCodecs()) return { ok: false as const, reason: NO_WEBCODECS };
    let kit: MediaKit;
    try {
      kit = await load();
    } catch (error) {
      return { ok: false as const, reason: `媒体库加载失败：${messageOf(error)}` };
    }
    if (isCancelled(request.requestId)) return { ok: false as const, reason: "已取消" };
    try {
      const bytes = await kit.encodeVideo({
        container,
        width: request.width,
        height: request.height,
        fps: request.fps,
        frameCount: request.frameCount,
        frame: (index) => {
          if (isCancelled(request.requestId)) throw new Error("已取消");
          return request.frame(index);
        },
        cancelled: () => isCancelled(request.requestId)
      });
      return { ok: true as const, container, bytes };
    } catch (error) {
      return { ok: false as const, reason: messageOf(error) };
    } finally {
      release(request.requestId);
    }
  };

  return {
    supports,
    decode,
    encode,
    cancel: (requestId: string): void => { markCancelled(requestId); }
  };
}

function containerOf(fileName: string): Container | null {
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  if (extension === "mp4" || extension === "m4v" || extension === "mov") return "mp4";
  if (extension === "webm") return "webm";
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 媒体库的最小面（真实实现见 `defaultMediaKit`；测试注入替身）。 */
export type MediaKit = {
  decodeVideo(input: {
    bytes: Uint8Array;
    container: Container;
    maxWidth: number;
    maxHeight: number;
    maxFrames: number;
    cancelled: () => boolean;
  }): Promise<{ ok: true; width: number; height: number; fps: number; frames: Uint8Array[] } | { ok: false; reason: string }>;
  encodeVideo(input: {
    container: Container;
    width: number;
    height: number;
    fps: number;
    frameCount: number;
    frame: (index: number) => Uint8Array;
    cancelled: () => boolean;
  }): Promise<Uint8Array>;
};

/**
 * 默认实现：`mediabunny` + WebCodecs。
 *
 * 只在真正被调用时动态 import，因此没有视频需求的用户不为它付首屏成本。
 */
async function defaultMediaKit(): Promise<MediaKit> {
  const kit = await import("./animation-media-kit.js");
  return kit.createAnimationMediaKit();
}
