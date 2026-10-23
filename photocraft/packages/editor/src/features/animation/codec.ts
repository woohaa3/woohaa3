/**
 * 宿主 codec 端口的域内注册点（U77，design D2）。
 *
 * 公共端口契约在 `@woohaa3/photocraft-protocol` 的动画域里（纯类型 + 守卫）。编辑器是纯 UI
 * 包，不能自己实现 WebCodecs/容器 mux，也不能反向依赖宿主：宿主在装配时把实现交给这里，
 * 面板在**端口缺失或协商失败**时禁用视频导入/导出并显示具体原因，而不是只取首帧冒充成功。
 *
 * 未注册端口不是错误：帧序列（图片帧导入 + 动画 GIF 交付）不依赖 codec，照常可用。
 */
import { isAnimationCodecPort, animationCodecAvailability, type AnimationCodecPort } from "@woohaa3/photocraft-protocol";

let port: AnimationCodecPort | null = null;

/** 注册/清除宿主 codec 端口；非完整实现（缺方法）视为未注册。 */
export function setAnimationCodecPort(next: AnimationCodecPort | null): void {
  port = next && isAnimationCodecPort(next) ? next : null;
}

/** 当前注册的 codec 端口（未注册为 null）。 */
export function animationCodecPort(): AnimationCodecPort | null {
  return port;
}

/** 本域按偏好顺序协商的容器：MP4 优先，其次是 WebM。 */
export const ANIMATION_CONTAINERS = ["mp4", "webm"] as const;

export type AnimationContainer = (typeof ANIMATION_CONTAINERS)[number];

export type AnimationNegotiation =
  | { state: "pending" }
  | { state: "ready"; container: AnimationContainer }
  | { state: "unavailable"; reason: string };

/**
 * 与宿主端口协商容器（异步）。
 *
 * 只问 MP4 会把「只支持 WebM 的宿主」误判成不可用，因此按 [`ANIMATION_CONTAINERS`] 顺序询问，
 * 取**第一个受支持**的容器；全都不支持时 `reason` 直接来自端口（界面照原样展示，不自己编造）。
 *
 * 真实能力探测（`VideoEncoder.isConfigSupported`）本身异步，因此这里也异步：调用方先显示
 * 「正在协商」，有结果后再决定入口可用性。同步端口照样工作——`await` 一个非 Promise 值即可。
 */
export async function negotiateAnimationContainer(
  codec: AnimationCodecPort,
  direction: "decode" | "encode"
): Promise<AnimationNegotiation> {
  let lastReason: string | null = null;
  for (const container of ANIMATION_CONTAINERS) {
    let support;
    try {
      support = await codec.supports({ direction, container });
    } catch (error) {
      lastReason = error instanceof Error ? error.message : `协商 ${container} 失败`;
      continue;
    }
    const availability = animationCodecAvailability(support);
    if (availability.enabled) {
      return { state: "ready", container: availability.container as AnimationContainer };
    }
    lastReason = availability.reason;
  }
  return { state: "unavailable", reason: lastReason ?? "宿主 codec 端口没有声明任何容器" };
}
