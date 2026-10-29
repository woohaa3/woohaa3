/**
 * 画布页帧窗口的装配点
 * （change: 2026-10-25-enhance-telemetry-performance-collection，design D4/D7）。
 *
 * 为什么在这里而不在 `services/telemetry-performance.ts`：那个模块必须保持零画布依赖（它被
 * 画布页静态引入、只做窗口聚合），而计数来源 `scene-diagnostics` 属于 canvas-runtime。方向是
 * 插件 → 服务，不能反过来让服务 import 插件。
 *
 * 窗口挂在 `attach`（DOM canvas 挂上、控制器开始跑帧）而不是 `load` 之后：没有挂载就没有
 * 帧，先开窗会让第一条 `perf.frame` 的分母包含"等 React 提交"的时间，fps 因此偏低。
 */
import { createPerfFrameWindow, type PerfFrameCounters, type PerfFrameWindow } from "../../services/telemetry-performance.js";
import { sceneDiagnostics } from "./scene-diagnostics.js";

/** 运行时渲染计数（累计）；只有 dev 构建的 `getFrameCounters` 提供，读不到就不写 drawCalls。 */
type RenderCounters = { readonly renders?: number; readonly drawCalls3d?: number };

/** 计数快照：字段名与 `scene-diagnostics` 一致，避免两套口径各自解释同一个数字。 */
function readFrameCounters(): PerfFrameCounters {
  return {
    sceneBuilds: sceneDiagnostics.sceneBuilds,
    sceneSubmits: sceneDiagnostics.sceneSubmits,
    sceneDedupes: sceneDiagnostics.sceneDedupes,
    viewportSubmits: sceneDiagnostics.viewportSubmits,
    positionSubmits: sceneDiagnostics.positionSubmits,
    sceneStringify: sceneDiagnostics.sceneStringify,
    stringifyMs: sceneDiagnostics.stringifyMs,
    wasmAcceptMs: sceneDiagnostics.wasmAcceptMs,
    frameExecutions: sceneDiagnostics.frameExecutions,
    frameExecutionMs: sceneDiagnostics.frameExecutionMs
  };
}

/**
 * 创建画布页的帧窗口，并把页面可见性接到"丢半窗"。
 *
 * 返回的 `dispose` 关闭窗口、计时器与监听；不写最后一段半窗（页面离开时的半窗与切后台
 * 同义，spec: 隐藏时丢弃半窗）。
 */
export function installPerfFrameWindow(
  readRenderCounters?: () => RenderCounters | null | undefined
): PerfFrameWindow {
  const doc = globalThis.document as (Document & {
    addEventListener?: (type: string, handler: () => void) => void;
    removeEventListener?: (type: string, handler: () => void) => void;
  }) | undefined;
  const isHidden = (): boolean => doc?.hidden === true || doc?.visibilityState === "hidden";
  // draw call 只有渲染器计数能给：窗口关闭时用同一窗口的渲染帧数求每帧均值，
  // 这样"缩到总览后还在 999+"能被遥测直接回答（2026-10-28）。
  const read = (): PerfFrameCounters => {
    const counters = readFrameCounters();
    let render: RenderCounters | null | undefined;
    try {
      render = readRenderCounters?.();
    } catch {
      render = undefined;
    }
    return typeof render?.renders === "number" && typeof render?.drawCalls3d === "number"
      ? { ...counters, renderFrames: render.renders, drawCalls: render.drawCalls3d }
      : counters;
  };
  const window = createPerfFrameWindow({ read, isHidden });
  const onVisibilityChange = (): void => window.visibilityChanged(isHidden());
  try {
    doc?.addEventListener?.("visibilitychange", onVisibilityChange);
  } catch {
    // 没有 document（原生/测试环境）时窗口照常按定时器聚合。
  }
  return {
    close: window.close,
    visibilityChanged: window.visibilityChanged,
    dispose() {
      try {
        doc?.removeEventListener?.("visibilitychange", onVisibilityChange);
      } catch {
        // 解绑失败没有业务含义。
      }
      window.dispose();
    }
  };
}
