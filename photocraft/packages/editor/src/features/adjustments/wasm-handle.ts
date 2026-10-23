import type { FeatureHandleContext } from "../contracts.js";
import { type EditorResult } from "../../editor-wasm.js";

export function histogram(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.histogram(JSON.stringify(params))));
  }

export function beginAdjustment(this: FeatureHandleContext, layer: number): EditorResult<unknown> { return this.call((i)=>JSON.parse(i.beginAdjustment(layer))); }

/** 直接像素调整与调整层共用同一草稿槽，只有起始命令不同。 */
export function beginDirectAdjustment(this: FeatureHandleContext, kind: string, params: unknown, layer?: number): EditorResult<unknown> {
  return this.call((i)=>JSON.parse(i.beginDirectAdjustment(kind, JSON.stringify(params), layer)));
}

/** 本域可开始的目标（唯一命令门的真实结果）；界面据此渲染入口，不自行判断。 */
export function directAdjustmentTargets(this: FeatureHandleContext): EditorResult<unknown> {
  return this.call((i)=>JSON.parse(i.directAdjustmentTargetsJson()));
}

export function previewAdjustment(this: FeatureHandleContext, params: unknown): EditorResult<unknown> { return this.call((i)=>JSON.parse(i.previewAdjustment(JSON.stringify(params)))); }

export function commitAdjustment(this: FeatureHandleContext, ): EditorResult<unknown> { return this.call((i)=>JSON.parse(i.commitAdjustment())); }

export function cancelAdjustment(this: FeatureHandleContext, ): EditorResult<void> { return this.call((i)=>i.cancelAdjustment()); }

export function curveGeometry(this: FeatureHandleContext, points: readonly [number,number][]): EditorResult<number[]> {
    return this.call((i)=>{
      const samples:unknown=JSON.parse(i.curveGeometry(JSON.stringify(points)));
      if (!Array.isArray(samples) || samples.length!==256 || !samples.every(v=>typeof v==="number" && Number.isFinite(v) && v>=0 && v<=255)) throw new Error("曲线几何无效");
      return samples as number[];
    });
  }

export function createHandle(context: () => FeatureHandleContext) {
  return {
    histogram: (...args: Parameters<OmitThisParameter<typeof histogram>>) => histogram.apply(context(), args),
    beginAdjustment: (...args: Parameters<OmitThisParameter<typeof beginAdjustment>>) => beginAdjustment.apply(context(), args),
    beginDirectAdjustment: (...args: Parameters<OmitThisParameter<typeof beginDirectAdjustment>>) => beginDirectAdjustment.apply(context(), args),
    directAdjustmentTargets: (...args: Parameters<OmitThisParameter<typeof directAdjustmentTargets>>) => directAdjustmentTargets.apply(context(), args),
    previewAdjustment: (...args: Parameters<OmitThisParameter<typeof previewAdjustment>>) => previewAdjustment.apply(context(), args),
    commitAdjustment: (...args: Parameters<OmitThisParameter<typeof commitAdjustment>>) => commitAdjustment.apply(context(), args),
    cancelAdjustment: (...args: Parameters<OmitThisParameter<typeof cancelAdjustment>>) => cancelAdjustment.apply(context(), args),
    curveGeometry: (...args: Parameters<OmitThisParameter<typeof curveGeometry>>) => curveGeometry.apply(context(), args),
  };
}
