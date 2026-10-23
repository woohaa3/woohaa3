import type { FeatureHandleContext } from "../contracts.js";
import { type EditorResult } from "../../editor-wasm.js";

export function vectorCommand(this: FeatureHandleContext, id: string, params: unknown): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.vectorCommand(id, JSON.stringify(params))));
  }

export function vectorSnapshot(this: FeatureHandleContext, ): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.vectorSnapshotJson()));
  }

/** 形状预设库：工具状态，与文档快照分开读取。 */
export function vectorPresets(this: FeatureHandleContext, ): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.vectorPresetsJson()));
  }

/**
 * 画布拖绘 → `shape.create` 参数。纯计算（不写文档、不推进历史），
 * 叠加层预览与松手提交共用同一份结果。
 */
export function vectorDrawParams(this: FeatureHandleContext, input: unknown): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.vectorDrawParamsJson(JSON.stringify(input))));
  }

export function createHandle(context: () => FeatureHandleContext) {
  return {
    vectorCommand: (...args: Parameters<OmitThisParameter<typeof vectorCommand>>) => vectorCommand.apply(context(), args),
    vectorSnapshot: (...args: Parameters<OmitThisParameter<typeof vectorSnapshot>>) => vectorSnapshot.apply(context(), args),
    vectorPresets: (...args: Parameters<OmitThisParameter<typeof vectorPresets>>) => vectorPresets.apply(context(), args),
    vectorDrawParams: (...args: Parameters<OmitThisParameter<typeof vectorDrawParams>>) => vectorDrawParams.apply(context(), args),
  };
}
