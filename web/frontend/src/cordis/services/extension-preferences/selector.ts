/**
 * Canvas composition root 启动选择器
 * （change: add-frontend-plugin-manager，任务 3.1/3.2 / design D2）。
 *
 * 在创建 Canvas page scope **之前**读取一次有效 optional 选择，并产生本次启动语义：
 * - required（含被改为 required 的 paste-import/model-editor/plugin-manager）一律装配；
 * - 显式标记 configurable 的 optional Plugin 仅在目标启用时装配；
 * - 未装配的 optional Plugin 记录为 `assembled: false` 与 `disabled`（区别于启动失败/缺失依赖）。
 *
 * 返回 immutable startup snapshot，供 Plugin Manager 表示“当前运行”状态。
 */
import type { CanvasExtensionMetadata } from "../../plugins/extension-manager/contract.js";
import type { FrontendExtensionPreferences } from "./codec.js";

export type ExtensionStartupSnapshot = {
  /** 每个 configurable optional ID 本次是否实际装配。 */
  assembled: Readonly<Record<string, boolean>>;
  /** 因用户禁用而未装配的 optional ID（诊断用）。 */
  disabledIds: readonly string[];
  /** 本次启动读取到的目标状态。 */
  desired: FrontendExtensionPreferences;
};

/** 解析本次实际装配的 configurable optional 集合（不实例化 Plugin）。 */
export function resolveStartupSelection(
  catalog: readonly CanvasExtensionMetadata[],
  desired: FrontendExtensionPreferences
): ExtensionStartupSnapshot {
  const assembled: Record<string, boolean> = {};
  const disabledIds: string[] = [];
  for (const entry of catalog) {
    if (!entry.configurable) continue;
    const enabled = desired[entry.id] ?? entry.defaultEnabled ?? true;
    assembled[entry.id] = enabled;
    if (!enabled) disabledIds.push(entry.id);
  }
  return { assembled, disabledIds, desired };
}

/** 本次启动是否装配某定义（required 与不可配置定义恒为 true）。 */
export function isAssembledAtStartup(
  definition: { id: string; required: boolean; configurable?: boolean; defaultEnabled?: boolean },
  assembled: Readonly<Record<string, boolean>>
): boolean {
  if (definition.required) return true;
  if (definition.configurable !== true) return true;
  return assembled[definition.id] ?? definition.defaultEnabled ?? true;
}
