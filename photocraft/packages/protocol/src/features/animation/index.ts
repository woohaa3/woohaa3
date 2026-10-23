/**
 * 时间轴与浏览器视频工作流的纯协议（U77）
 * （change: 2026-10-22-add-photocraft-animation-workflows，design D2/D3）。
 *
 * 本文件只放**纯数据与纯类型**，不含宿主依赖、不 import 编辑器或内核：
 *
 * - 内核 `timelineJson` / `deliveryPlan` 的载荷形状（唯一权威是内核 PDF，这里只做类型镜像）；
 * - 公共 codec 端口契约 `AnimationCodecPort`（supports / decode / encode / cancel）。浏览器用
 *   WebCodecs + 容器 mux/demux 实现，本机宿主用原生编解码器实现；内核**不**运行 ffmpeg 子进程。
 *
 * 预算上限不在这里重复声明：内核在 `timelineJson().budget` 里报告实际执行的上限，交付被拒绝时
 * 返回稳定 code（`frame-count-exceeded`、`frame-pixels-exceeded`、`decode-bytes-exceeded`、
 * `delivery-bytes-exceeded`、`invalid-fps`、`invalid-frame-size`）。界面读内核的值，不维护第二套。
 *
 * 能力 id（`animation.timeline` / `animation.video-layers` / `animation.frame-import` /
 * `animation.frame-delivery`）已发布，与 `tests/fixtures/contract.json` 和 Rust
 * `features/animation/mod.rs::CONTRIBUTION` 同一份清单、同一顺序。
 */

/**
 * 本域发布的能力 id。
 *
 * 与 Rust `features/animation/mod.rs::CONTRIBUTION.capabilities` 和
 * `tests/fixtures/contract.json` 的 `capabilities` 必须同序同值：任一处漏改，
 * `contract-fixture.test.ts` 与 `contract_fixture.rs` 会立即失败（能力协商漂移比缺能力更危险）。
 */
export const ANIMATION_CAPABILITIES = [
  "animation.timeline",
  "animation.video-layers",
  "animation.frame-import",
  "animation.frame-delivery"
] as const;

export const feature = {
  id: "animation",
  capabilities: [
    { stage: "P7", order: 11, id: "animation.timeline" },
    { stage: "P7", order: 12, id: "animation.video-layers" },
    { stage: "P7", order: 13, id: "animation.frame-import" },
    { stage: "P7", order: 14, id: "animation.frame-delivery" },
  ]
} as const;

/** 时间轴属性（内核 `timelineJson().timeline`，无时间轴时为 `null`）。 */
export type AnimationTimeline = {
  fps: number;
  duration: number;
  /** 当前播放位置（帧号）。 */
  current: number;
  workStart: number;
  workEnd: number;
  /** 播放位置对应的时间（秒）。 */
  time: number;
};

/** 内核实际执行的帧预算（界面据此显示上限，不复制常量）。 */
export type AnimationFrameBudget = {
  maxFrames: number;
  maxCumulativeFramePixels: number;
  maxDecodeBytes: number;
  maxDeliveryBytes: number;
  maxFps: number;
};

/** 一个视频图层的帧栈摘要。 */
export type AnimationVideoLayer = {
  layerId: number;
  name: string;
  frames: number;
  fps: number;
  showAltered: boolean;
  hasOriginal: boolean;
};

/** `timelineJson` 载荷。 */
export type AnimationTimelineInfo = {
  timeline: AnimationTimeline | null;
  budget: AnimationFrameBudget;
  videoLayers: AnimationVideoLayer[];
};

/** `deliveryPlan` 载荷：逐帧交付的形状，不含像素。 */
export type AnimationDeliveryPlan = {
  frames: number;
  width: number;
  height: number;
  fpsMillis: number;
  frameBytes: number;
  totalBytes: number;
};

/** 帧导入结果。 */
export type AnimationFrameImport = {
  layer: number;
  frames: number;
  width: number;
  height: number;
  fps: number;
  duration: number;
};

/** 导航结果：`historyAdded` 必须为 0（播放/定位不新增历史）。 */
export type AnimationNavigation = {
  result: unknown;
  historyAdded: number;
};

/** `flushVideoFrames` 结果：把显示内容写回所在帧是否发生。 */
export type AnimationFrameFlush =
  | { written: true; revision: number }
  | { written: false; reason: "draft-active" | "no-document" | "unchanged" };

/**
 * codec 协商结果。
 *
 * `supported: false` 时**必须**带原因，界面据此禁用入口并显示原因，不能静默退回「只取首帧」。
 */
export type AnimationCodecSupport =
  | { supported: true; container: string; codec: string }
  | { supported: false; reason: string };

/** 一次解码请求：字节 + 期望帧率上限 + 取消令牌。 */
export type AnimationDecodeRequest = {
  /** 调用方生成的请求序号；与 `cancel` 一致，避免晚到结果写回。 */
  requestId: string;
  fileName: string;
  bytes: Uint8Array;
  /** 目标尺寸（不放大，只按比例缩放）；内核按此逐帧校验字节长度。 */
  maxWidth: number;
  maxHeight: number;
  /** 期望帧率；解码器按容器信息给出实际值。 */
  fps: number;
  /**
   * 帧数上限（内核 `timelineJson().budget.maxFrames`）。
   *
   * 端口据此在解码时**拒绝**超长片段，而不是先解出上千帧再被内核拒绝；上限本身不在端口里
   * 重复声明，避免与 `rust/project-limits.json` 漂移。
   */
  maxFrames: number;
};

/** 一次编码请求：已渲染的 RGBA8 帧（首尾相接）+ 尺寸 + 帧率。 */
export type AnimationEncodeRequest = {
  requestId: string;
  width: number;
  height: number;
  fps: number;
  /** 逐帧回调取像素：避免一次把整段时间轴读进内存。 */
  frame(frame: number): Uint8Array;
  frameCount: number;
  /**
   * 协商时选定的容器（`supports({direction:"encode"})` 通过的那一个）。
   *
   * 端口可以缺省理解，但必须按它声明的容器产出；结果里的 `container` 才是最终文件名依据。
   */
  container?: string;
};

/**
 * 公共 codec 端口（design D2）。
 *
 * 所有方法都可以失败：`supports` 先协商，`decode`/`encode` 只在协商通过后被调用；`cancel` 必须
 * 幂等，取消后 `decode`/`encode` 不再产出结果。端口不接收路径、不写文件。
 *
 * `supports` 允许返回 Promise：真实能力探测（`VideoEncoder.isConfigSupported` 等）本来异步，
 * 同步契约只能靠「乐观宣称支持」，那会在不支持该编解码器的浏览器上让入口可点、随后失败。
 * 因此端口可以异步回答，界面在协商完成前保持禁用并说明正在协商。
 */
export type AnimationCodecPort = {
  supports(input: { container?: string; codec?: string; direction: "decode" | "encode" }): AnimationCodecSupport | Promise<AnimationCodecSupport>;
  decode(request: AnimationDecodeRequest): Promise<
    { ok: true; width: number; height: number; fps: number; frames: Uint8Array[] } | { ok: false; reason: string }
  >;
  encode(request: AnimationEncodeRequest): Promise<
    { ok: true; container: string; bytes: Uint8Array } | { ok: false; reason: string }
  >;
  cancel(requestId: string): void;
};

/** 端口类型守卫：宿主替身与部分实现都不得被当成完整端口。 */
export function isAnimationCodecPort(value: unknown): value is AnimationCodecPort {
  if (typeof value !== "object" || value === null) return false;
  const port = value as Record<string, unknown>;
  return (
    typeof port.supports === "function" &&
    typeof port.decode === "function" &&
    typeof port.encode === "function" &&
    typeof port.cancel === "function"
  );
}

/** 协商结果转成界面可直接展示的可用性（缺端口时给出具体原因）。 */
export function animationCodecAvailability(
  support: AnimationCodecSupport | null,
): { enabled: true; container: string; codec: string } | { enabled: false; reason: string } {
  if (!support) return { enabled: false, reason: "当前宿主没有视频编解码端口（WebCodecs/容器封装不可用）" };
  return support.supported
    ? { enabled: true, container: support.container, codec: support.codec }
    : { enabled: false, reason: support.reason };
}

/** 一帧 RGBA8 的字节长度（帧导入前校验扁平字节用）。 */
export function animationFrameBytes(width: number, height: number, frames = 1): number | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !Number.isSafeInteger(frames)) return null;
  if (width <= 0 || height <= 0 || frames <= 0) return null;
  const bytes = width * height * 4 * frames;
  return Number.isSafeInteger(bytes) ? bytes : null;
}
