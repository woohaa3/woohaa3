import type { FeatureHandleContext } from "../contracts.js";
import { type EditorResult } from "../../editor-wasm.js";
import { decodeModeInfo, decodeModePlan, type ImageModeInfo, type ImageModePlan, type ImageModeTarget, type ModeParams } from "./mode-data.js";

/**
 * 本域 WASM 适配（change: 2026-10-22-add-photocraft-image-mode-workflows）。
 *
 * 内核返回的 JSON 在这里做**有界**解码：结构非法直接失败，不把半截计划交给界面。
 * 预览像素是 base64，解码后交给面板画在自带的 canvas 上，不走共享预览通道。
 */

/** 本域依赖的内核导出；缺任何一个都说明加载的是没带本域能力的旧内核。 */
const RUNTIME_EXPORTS = ["modeInfo", "planMode", "applyMode", "planColorTable", "applyColorTable"] as const;

/**
 * 运行时协商：旧内核没有这些导出时，直接调用会抛 `TypeError: xxx is not a function`，
 * 界面上就是一句英文开发者信息。这里在最前面判定一次，换成可读的拒绝——不写任何东西，
 * 也不假装功能可用。
 */
function requireRuntime(instance: unknown): void {
  const host = instance as Record<string, unknown> | null;
  const missing = RUNTIME_EXPORTS.filter((name) => typeof host?.[name] !== "function");
  if (missing.length === 0) return;
  throw Object.assign(
    new Error(`当前编辑器内核不支持图像模式（缺少 ${missing.join("、")}），请更新内核后再使用`),
    { code: "runtime-unsupported" }
  );
}

export function modeInfo(this: FeatureHandleContext): EditorResult<ImageModeInfo> {
  return this.call((instance) => {
    requireRuntime(instance);
    const info = decodeModeInfo(JSON.parse(instance.modeInfo()));
    if (!info) throw new Error("模式信息响应无效");
    return info;
  });
}

export function planMode(this: FeatureHandleContext, target: ImageModeTarget, params: ModeParams): EditorResult<ImageModePlan> {
  return this.call((instance) => {
    requireRuntime(instance);
    const plan = decodeModePlan(JSON.parse(instance.planMode(target, JSON.stringify(params))));
    if (!plan) throw new Error("模式计划响应无效");
    return plan;
  });
}

export function applyMode(this: FeatureHandleContext, target: ImageModeTarget, params: ModeParams): EditorResult<ImageModePlan> {
  return this.call((instance) => {
    requireRuntime(instance);
    const plan = decodeModePlan(JSON.parse(instance.applyMode(target, JSON.stringify(params))));
    if (!plan) throw new Error("模式确认响应无效");
    return plan;
  });
}

export function planColorTable(this: FeatureHandleContext, params: ModeParams): EditorResult<ImageModePlan> {
  return this.call((instance) => {
    requireRuntime(instance);
    const plan = decodeModePlan(JSON.parse(instance.planColorTable(JSON.stringify(params))));
    if (!plan) throw new Error("颜色表计划响应无效");
    return plan;
  });
}

export function applyColorTable(this: FeatureHandleContext, params: ModeParams): EditorResult<ImageModePlan> {
  return this.call((instance) => {
    requireRuntime(instance);
    const plan = decodeModePlan(JSON.parse(instance.applyColorTable(JSON.stringify(params))));
    if (!plan) throw new Error("颜色表确认响应无效");
    return plan;
  });
}

export function createHandle(context: () => FeatureHandleContext) {
  return {
    modeInfo: (...args: Parameters<OmitThisParameter<typeof modeInfo>>) => modeInfo.apply(context(), args),
    planMode: (...args: Parameters<OmitThisParameter<typeof planMode>>) => planMode.apply(context(), args),
    applyMode: (...args: Parameters<OmitThisParameter<typeof applyMode>>) => applyMode.apply(context(), args),
    planColorTable: (...args: Parameters<OmitThisParameter<typeof planColorTable>>) => planColorTable.apply(context(), args),
    applyColorTable: (...args: Parameters<OmitThisParameter<typeof applyColorTable>>) => applyColorTable.apply(context(), args),
  };
}
