import type { FeatureHandleContext } from "../contracts.js";
import { type EditorResult } from "../../editor-wasm.js";

export function applyTypography(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.applyTypography(JSON.stringify(params))));
  }

export function checkFont(this: FeatureHandleContext, font: string): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.checkFont(font)));
  }

export function beginText(this: FeatureHandleContext, params: unknown): EditorResult<unknown> { return this.call((i)=>JSON.parse(i.beginText(JSON.stringify(params)))); }

export function previewText(this: FeatureHandleContext, params: unknown): EditorResult<unknown> { return this.call((i)=>JSON.parse(i.previewText(JSON.stringify(params)))); }

export function commitText(this: FeatureHandleContext, ): EditorResult<unknown> { return this.call((i)=>JSON.parse(i.commitText())); }

export function cancelText(this: FeatureHandleContext, ): EditorResult<void> { return this.call((i)=>i.cancelText()); }

/**
 * 文字域写命令（U67/U68/U69）：白名单与参数校验都在内核内完成。
 *
 * `typeCommand`/`typeQuery` 在 `FeatureEditorInstance` 里是可选的：能力握手看不到这两个入口的
 * 存在性，旧内核可能缺它们。缺省时回报明确原因（不抛 `TypeError`、不假装成功），新内核照常转发。
 */
export function typeCommand(this: FeatureHandleContext, id: string, params: unknown): EditorResult<unknown> {
  return this.call((i) => {
    if (typeof i.typeCommand !== "function") throw new Error("当前内核未提供文字域命令入口（typeCommand）");
    return JSON.parse(i.typeCommand(id, JSON.stringify(params ?? null)));
  });
}

/** 文字域只读查询：不改文档、不进历史。 */
export function typeQuery(this: FeatureHandleContext, id: string, params: unknown): EditorResult<unknown> {
  return this.call((i) => {
    if (typeof i.typeQuery !== "function") throw new Error("当前内核未提供文字域查询入口（typeQuery）");
    return JSON.parse(i.typeQuery(id, JSON.stringify(params ?? null)));
  });
}

export function createHandle(context: () => FeatureHandleContext) {
  return {
    applyTypography: (...args: Parameters<OmitThisParameter<typeof applyTypography>>) => applyTypography.apply(context(), args),
    checkFont: (...args: Parameters<OmitThisParameter<typeof checkFont>>) => checkFont.apply(context(), args),
    beginText: (...args: Parameters<OmitThisParameter<typeof beginText>>) => beginText.apply(context(), args),
    previewText: (...args: Parameters<OmitThisParameter<typeof previewText>>) => previewText.apply(context(), args),
    commitText: (...args: Parameters<OmitThisParameter<typeof commitText>>) => commitText.apply(context(), args),
    cancelText: (...args: Parameters<OmitThisParameter<typeof cancelText>>) => cancelText.apply(context(), args),
    typeCommand: (...args: Parameters<OmitThisParameter<typeof typeCommand>>) => typeCommand.apply(context(), args),
    typeQuery: (...args: Parameters<OmitThisParameter<typeof typeQuery>>) => typeQuery.apply(context(), args),
  };
}
