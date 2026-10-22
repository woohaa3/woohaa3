/**
 * Canvas extension 启动选择（纯函数）
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 5.1 / design D8）。
 *
 * 在创建 Canvas page scope **之前**，由发布目录的纯 metadata 与一次 browser-local 偏好读取派生：
 * - `always` 入口（含 required）进入本次启动加载集合；
 * - `browser-local` optional 只在本次启动已启用时进入；
 * - `server-active` 只登记（由 reconciler 按服务端 actual active 驱动），本阶段不加载；
 * - 未选择/禁用的入口不产生任何 JS/CSS/SDK 请求。
 *
 * 选择只依赖 metadata，不下载实现、不构造 plugin。
 */
import type { ExtensionFrontendMetadata } from "@woohaa3/contracts";

export type ExtensionSelectionInput = {
  metadata: readonly ExtensionFrontendMetadata[];
  /** 用户可配置的 browser-local optional 目标状态；缺省启用。 */
  desired: Readonly<Record<string, boolean>>;
};

export type ExtensionStartupSelection = {
  /** 本次启动需要加载实现的入口（always + 已启用 browser-local optional），稳定顺序。 */
  load: readonly ExtensionFrontendMetadata[];
  /** 只登记、由服务端状态驱动的入口。 */
  registered: readonly ExtensionFrontendMetadata[];
  /** 因用户禁用而未加载的 optional ID。 */
  disabledIds: readonly string[];
  /** 每个可配置 optional ID 本次是否实际选择加载（Plugin Manager 展示用）。 */
  assembled: Readonly<Record<string, boolean>>;
  /** required 入口（加载失败即 page 启动失败）。 */
  requiredIds: readonly string[];
};

/** 稳定排序：always/required 在前，再按 extensionId。 */
function order(entries: readonly ExtensionFrontendMetadata[]): ExtensionFrontendMetadata[] {
  return [...entries].sort((a, b) => {
    const aAlways = a.activation === "always" ? 0 : 1;
    const bAlways = b.activation === "always" ? 0 : 1;
    if (aAlways !== bAlways) return aAlways - bAlways;
    return a.extensionId < b.extensionId ? -1 : a.extensionId > b.extensionId ? 1 : 0;
  });
}

/**
 * 派生本次 Canvas 启动选择。
 *
 * 注意：`disabled` 只影响 browser-local optional；required/always 一律进入加载集合，用户配置
 * 不能禁用（design D8/Plugin Manager）。
 */
export function resolveExtensionStartupSelection(input: ExtensionSelectionInput): ExtensionStartupSelection {
  const load: ExtensionFrontendMetadata[] = [];
  const registered: ExtensionFrontendMetadata[] = [];
  const disabledIds: string[] = [];
  const assembled: Record<string, boolean> = {};
  const requiredIds: string[] = [];

  for (const entry of input.metadata) {
    if (entry.activation === "server-active") {
      registered.push(entry);
      continue;
    }
    if (entry.activation === "always" || entry.required) {
      load.push(entry);
      if (entry.required) requiredIds.push(entry.extensionId);
      continue;
    }
    // browser-local optional（configScope === "browser-local"）。
    const enabled = input.desired[entry.extensionId] ?? true;
    assembled[entry.extensionId] = enabled;
    if (enabled) load.push(entry);
    else disabledIds.push(entry.extensionId);
  }

  return {
    load: order(load),
    registered: order(registered),
    disabledIds,
    assembled,
    requiredIds
  };
}

/** 可配置的 browser-local optional ID（稳定排序；Plugin Manager 与偏好 store 共用）。 */
export function configurableBrowserLocalIds(metadata: readonly ExtensionFrontendMetadata[]): string[] {
  return metadata
    .filter((entry) => entry.configScope === "browser-local" && entry.activation === "browser-local" && !entry.required)
    .map((entry) => entry.extensionId)
    .sort();
}
