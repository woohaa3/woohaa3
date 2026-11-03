/**
 * 桌面壳里的「Pinterest 窗口」：资源栏点 Pinterest，弹出（或聚焦）一个独立窗口。
 *
 * 窗口是桌面壳 Rust 侧建的（见 `desktop/src/pinterest_window.rs`），这里只负责说「打开」。
 *
 * 调用方**只能说打开**，不能指定地址或尺寸：地址写死在 Rust 里。这是有意的 ——
 * 这条协议只认主窗口的 token，但「主窗口的前端被人注入脚本」不该
 * 等于「能让原生层打开任意网页」。
 *
 * 第一版是嵌在资源栏里的 300 像素宽子 webview，实测被挤成窄条、页面按窄屏断点排版没法用，
 * 所以改成独立窗口。那版需要的位置量取、显隐串行队列都随之不需要了。
 */
import { desktopBootstrap } from "../extension-api/host-platform.js";
import { nativeProtocolUrl } from "./native-protocol.js";

export type PinterestWindowState = { state: "opened" | "focused"; created: boolean };

/** 当前环境有没有这个能力：只有桌面壳注入了 bootstrap。浏览器里没有。 */
export function pinterestWindowAvailable(target: typeof globalThis = globalThis): boolean {
  return desktopBootstrap(target) !== undefined;
}

export async function openPinterestWindow(): Promise<PinterestWindowState> {
  const bootstrap = desktopBootstrap(globalThis);
  if (!bootstrap) throw new Error("Pinterest 窗口只能在桌面端打开");
  const response = await fetch(nativeProtocolUrl("pinterest"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Woohaa-Token": bootstrap.token },
    body: JSON.stringify({ action: "open" }),
    signal: AbortSignal.timeout(15_000)
  });
  const result = (await response.json()) as { ok: boolean; value?: PinterestWindowState; error?: string };
  if (!response.ok || !result.ok || !result.value) {
    throw new Error(result.error ?? "打开 Pinterest 失败，请重试");
  }
  return result.value;
}
