import { APP_THEME_DEFAULT_TOKENS } from "@woohaa3/contracts";
import type { FilmSetHostContext as Context } from "../../state/browser/host-ports.js";

/**
 * 当前主题的镜头预览清屏色（`#rrggbb`）。
 *
 * 与 Bevy 镜头卡片预览使用同一个 `webSubtle` token（`app/scene3d.rs` 的
 * `ShotPreviewClearColor`），所以「跟随主题」的镜头背景与预览画面一致
 * （change: 2026-10-19-extend-film-set-for-motion-graphics，D6）。
 *
 * 前端是唯一持有当前主题的一方：浏览器导出与原生录制的提交体都带这个具体色，后端不再
 * 自行猜测。主题服务不可用时回退应用默认主题的同名 token。
 */
export function recordingThemeBackdrop(ctx: Context): string {
  const get = (ctx as { get?: (name: string) => unknown }).get;
  if (typeof get !== "function") return APP_THEME_DEFAULT_TOKENS.webSubtle.toLowerCase();
  const theme = get.call(ctx, "theme") as { getSnapshot?: () => { tokens?: Record<string, string> } } | undefined;
  const token = theme?.getSnapshot?.().tokens?.webSubtle;
  const value = typeof token === "string" ? token.trim().toLowerCase() : "";
  return /^#[0-9a-f]{6}$/.test(value) ? value : APP_THEME_DEFAULT_TOKENS.webSubtle.toLowerCase();
}

/** 镜头背景是否应显示为「跟随主题」（供面板与导出共用）。 */
export function isThemedBackdrop(backdrop: string | undefined): boolean {
  return backdrop === undefined || backdrop === "theme";
}
