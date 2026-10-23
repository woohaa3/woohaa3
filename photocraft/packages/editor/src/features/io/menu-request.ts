/**
 * 菜单 → 面板的意图通道（change: 2026-10-22-add-photocraft-raster-interchange，U06）。
 *
 * 「文件 ▸ 导出为…」「文件 ▸ Save for Web…」和「图像 ▸ 格式与导出…」打开的是同一块面板，
 * 但前两者要落在**不同的模式**上：只把面板打开、让用户自己再切一次模式，等于菜单项说了不算。
 *
 * 为什么用本域的外部存储而不是 props：菜单由共享 chrome 渲染，面板由域 manifest 渲染，
 * 两者之间没有参数通道；把意图塞进共享 App 状态会让共享层理解本域的页签/模式语义。
 * 这里保持本域自洽 —— 共享层只需要说「请求打开本域面板」，落点由本域解释。
 *
 * 一次性语义：面板用 `nonce` 判断是否已应用过同一请求，避免重新渲染把用户后续的切换覆盖掉。
 */
import { normalizeExportSettings, type ExportSettings } from "@woohaa3/photocraft-protocol";
export type InterchangeTab = "export" | "layers" | "matrix";
export type InterchangeMode = "export" | "web";

export type InterchangeRequest = {
  tab: InterchangeTab;
  mode?: InterchangeMode;
  settings?: ExportSettings;
  /** 递增序号：同一请求只应用一次。 */
  nonce: number;
};

let current: InterchangeRequest | null = null;
const listeners = new Set<() => void>();

/** 记录一次「打开本域面板并落在某页签/模式」的意图。 */
export function requestInterchange(request: { tab?: InterchangeTab; mode?: InterchangeMode; settings?: ExportSettings } = {}): void {
  current = {
    tab: request.tab ?? "export",
    ...(request.mode ? { mode: request.mode } : {}),
    ...(request.settings ? { settings: { ...request.settings } } : {}),
    nonce: (current?.nonce ?? 0) + 1
  };
  for (const listener of listeners) listener();
}

/** 文件域传来不透明预设，由 io 校验后才回灌面板。 */
export function requestExportPreset(settings: unknown): { ok: true } | { ok: false; reason: string } {
  const decoded = normalizeExportSettings(settings);
  if (!decoded.ok) return { ok: false, reason: decoded.message };
  requestInterchange({ tab: "export", mode: decoded.value.mode, settings: decoded.value });
  return { ok: true };
}

export function subscribeInterchange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function currentInterchangeRequest(): InterchangeRequest | null {
  return current;
}

/** 测试用：清空待应用意图。 */
export function resetInterchangeRequest(): void {
  current = null;
  for (const listener of listeners) listener();
}
