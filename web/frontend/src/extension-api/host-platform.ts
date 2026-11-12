/**
 * 运行宿主（桌面壳 / 浏览器）判定
 * （change: 2026-10-18-split-performance-readout-location）。
 *
 * 这是宿主与扩展共享的**唯一**平台判定：Tauri 桌面壳注入受令牌保护的窗口能力
 * `__WOOHAA_DESKTOP__`；浏览器没有该能力。
 *
 * 放在 leaf API 里而不是 `desktop/window-controls.ts`，是为了让扩展只依赖一个纯函数判断宿主，
 * 不把窗口控制（fetch 协议）带进扩展运行时闭包。
 */
export type DesktopBootstrap = { protocol: "woohaa-window-v1"; token: string; platform?: string; version?: string | null };

const DESKTOP_PROTOCOL = "woohaa-window-v1";

/** 读取桌面壳注入的窗口能力；浏览器或令牌缺失时返回 `undefined`。 */
export function desktopBootstrap(target: typeof globalThis): DesktopBootstrap | undefined {
  const bootstrap = (target as typeof globalThis & { __WOOHAA_DESKTOP__?: DesktopBootstrap }).__WOOHAA_DESKTOP__;
  return bootstrap?.protocol === DESKTOP_PROTOCOL && bootstrap.token ? bootstrap : undefined;
}

/** 读取 Tauri 桌面壳自报的包版本（来自 `desktop/tauri.conf.json`）；非桌面壳或未注入时返回 `null`。 */
export function desktopAppVersion(target: typeof globalThis = globalThis): string | null {
  const version = desktopBootstrap(target)?.version;
  if (typeof version !== "string") return null;
  const trimmed = version.trim();
  return trimmed !== "" ? trimmed : null;
}

/**
 * 当前是否运行在 Tauri 桌面壳。
 *
 * 用于选择宿主提供的呈现位置：桌面窗口横栏（常驻窗口装饰）与浏览器浮动顶栏/工具栏的归属不同。
 */
export function isDesktopHost(target: typeof globalThis = globalThis): boolean {
  return desktopBootstrap(target) !== undefined;
}
