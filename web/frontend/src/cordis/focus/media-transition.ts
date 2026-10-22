/**
 * 公共二维媒体取景/插值纯函数
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D2/D4/D7）。
 *
 * 从 canvas-shell/focus-transition.ts 抽出的**纯数学**：节点内容矩形、概览取景换算与对数 zoom
 * 插值。这里 MUST NOT 自带独立时钟/rAF——取景过渡的时间线由 Canvas Runtime scope 的
 * FocusTransitionCoordinator 唯一拥有，feature 只按进度应用纯函数结果。
 */
import type { FocusSurfaceRect } from "./types.js";

export type SurfaceRect = FocusSurfaceRect;

export type FocusViewport = { x: number; y: number; zoom: number };

/** 节点内容区在画布世界坐标下的屏幕矩形（源尺寸按比例内嵌卡片）。 */
export function nodeImageRect(node: { x: number; y: number; width: number; height: number }, width: number, height: number): SurfaceRect {
  const boxWidth = Math.max(1, node.width - 32);
  const boxHeight = Math.max(24, node.height - 68);
  const scale = Math.min(boxWidth / width, boxHeight / height);
  return {
    x: node.x + 16 + (boxWidth - width * scale) / 2,
    y: node.y + 52 + (boxHeight - height * scale) / 2,
    width: width * scale, height: height * scale
  };
}

/**
 * 概览取景：聚焦开始/结束帧。
 *
 * 让聚焦内容（源尺寸 + 本地取景）在进入前的画布概览视口下与节点卡片内容矩形像素对齐，
 * 因此动画首帧不外扩、末帧回到卡片原位。
 */
export function overviewImageView(world: SurfaceRect, sourceWidth: number, content: SurfaceRect, overview: FocusViewport): FocusViewport {
  return {
    zoom: world.width / sourceWidth * overview.zoom,
    x: (world.x + world.width / 2) * overview.zoom + overview.x - content.x - content.width / 2,
    y: (world.y + world.height / 2) * overview.zoom + overview.y - content.y - content.height / 2
  };
}

/**
 * 共享缓动曲线（smoothstep）。
 */
export function smoothstep(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return p * p * (3 - 2 * p);
}

/**
 * 按进度在 from/to 间插值二维取景：x/y 线性、zoom 对数（跨数量级缩放视觉速率恒定）。
 * 纯函数；不读时间、不持有状态。
 */
export function interpolateViewport(from: FocusViewport, to: FocusViewport, progress: number): FocusViewport {
  const t = smoothstep(progress);
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    zoom: Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * t)
  };
}

/** 一次取景过渡请求（由 feature adapter 按公共进度应用；不读时间）。 */
export type ViewportTransitionRequest = {
  /** 过渡身份（scope/node/kind/generation），供 coordinator 取消/反向与代际守门。 */
  key: string;
  from: FocusViewport;
  to: FocusViewport;
  /** 时长（毫秒）；≤0 表示 reduced motion / 测试同步落位。 */
  duration: number;
  /** 按公共进度应用；`progress` 为 0..1 的原始进度（未缓动）。 */
  apply: (view: FocusViewport, progress: number) => void;
};

/**
 * 唯一取景过渡时间源端口。
 *
 * 生产由 Canvas Runtime scope 的 `FocusTransitionCoordinator` 实现（单一时间源、generation、
 * 取消/反向、reduced motion）；feature 只持有该端口，MUST NOT 自带独立 rAF。测试/无 runtime
 * 时使用 `createLocalTransitionRunner()` 作为最小等价实现。
 */
export type FocusTransitionPort = {
  /** 运行一次过渡；返回是否正常完成（取消/被替换返回 false）。 */
  run(request: ViewportTransitionRequest): Promise<boolean>;
  /** 取消当前过渡（可选按 key 前缀）；被取消的 previous promise 以 false 结算。 */
  cancel(key?: string): void;
  isActive(): boolean;
};

/**
 * 最小时间源实现：单一 rAF 循环 + 取消。
 *
 * 仅用于测试或 runtime 未挂载时的等价回退；生产由 Runtime coordinator 持有，避免每个
 * feature 各起 rAF。
 */
export function createLocalTransitionRunner(now: () => number = () => (typeof performance !== "undefined" ? performance.now() : Date.now())): FocusTransitionPort {
  let cancelCurrent: (() => void) | null = null;
  const port: FocusTransitionPort = {
    run(request) {
      cancelCurrent?.();
      if (request.duration <= 0 || typeof requestAnimationFrame !== "function") {
        request.apply(request.to, 1);
        return Promise.resolve(true);
      }
      let frame = 0;
      return new Promise<boolean>((resolve) => {
        const start = now();
        const cancel = () => {
          if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
          cancelCurrent = null;
          resolve(false);
        };
        cancelCurrent = cancel;
        const step = (time: number) => {
          const progress = Math.min(1, Math.max(0, (time - start) / request.duration));
          request.apply(interpolateViewport(request.from, request.to, progress), progress);
          if (progress === 1) { cancelCurrent = null; resolve(true); }
          else frame = requestAnimationFrame(step);
        };
        frame = requestAnimationFrame(step);
      });
    },
    cancel(key) {
      if (key !== undefined) return;
      cancelCurrent?.();
      cancelCurrent = null;
    },
    isActive() {
      return cancelCurrent !== null;
    }
  };
  return port;
}
