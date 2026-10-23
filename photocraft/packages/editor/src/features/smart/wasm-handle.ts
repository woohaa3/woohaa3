import type { FeatureHandleContext } from "../contracts.js";
import { type EditorResult } from "../../editor-wasm.js";

/** 内核导出的源字节；`name` 来自嵌入工程自身，不含路径语义。 */
export type SmartSourceExport = { name: string; bytes: Uint8Array };

export function beginSmartChild(this: FeatureHandleContext, layer: number): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.beginSmartChild(layer)));
  }

export function updateSmartParent(this: FeatureHandleContext, attemptId: string, child: Uint8Array): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.updateSmartParent(attemptId, child)));
  }

export function reloadSmartChild(this: FeatureHandleContext, ): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.reloadSmartChild()));
  }

export function exportSmartChild(this: FeatureHandleContext, ): EditorResult<Uint8Array> {
    return this.call((i) => i.exportSmartChild());
  }

export function detachSmartChild(this: FeatureHandleContext, ): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.detachSmartChild()));
  }

export function closeSmartChild(this: FeatureHandleContext, ): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.closeSmartChild()));
  }

export function smartChildState(this: FeatureHandleContext, ): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.smartChildStateJson()));
  }

export function convertToSmartObject(this: FeatureHandleContext, layers: readonly number[]): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.convertToSmartObject(JSON.stringify(layers))));
  }

export function duplicateSmartObject(this: FeatureHandleContext, layers: readonly number[], independent: boolean): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.duplicateSmartObject(JSON.stringify(layers), independent)));
  }

export function replaceSmartContents(this: FeatureHandleContext, layer: number, bytes: Uint8Array): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.replaceSmartContents(layer, bytes)));
  }

export function rasterizeSmartObject(this: FeatureHandleContext, layer: number): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.rasterizeSmartObject(layer)));
  }

export function smartLayerState(this: FeatureHandleContext, layer: number): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.smartLayerStateJson(layer)));
  }

/**
 * 导出选中层的嵌入源。不要求已打开子文档，也不产生历史。
 *
 * wasm-bindgen 的导出对象是原型 getter 上的资源，必须显式读出再 `free`。
 */
export function exportSmartSource(this: FeatureHandleContext, layer: number): EditorResult<SmartSourceExport> {
    return this.call((i) => {
      const exported = i.exportSmartSource(layer);
      try {
        const name = exported.name;
        const bytes = exported.bytes;
        if (typeof name !== "string" || !(bytes instanceof Uint8Array) || bytes.length === 0) {
          throw new Error("智能对象源导出为空");
        }
        return { name, bytes };
      } finally {
        exported.free?.();
      }
    });
  }

/** 转回图层：解包嵌入源为可编辑层/组，只改当前实例。 */
export function convertSmartToLayers(this: FeatureHandleContext, layer: number): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.convertSmartToLayers(layer)));
  }

export function createHandle(context: () => FeatureHandleContext) {
  return {
    beginSmartChild: (...args: Parameters<OmitThisParameter<typeof beginSmartChild>>) => beginSmartChild.apply(context(), args),
    updateSmartParent: (...args: Parameters<OmitThisParameter<typeof updateSmartParent>>) => updateSmartParent.apply(context(), args),
    reloadSmartChild: (...args: Parameters<OmitThisParameter<typeof reloadSmartChild>>) => reloadSmartChild.apply(context(), args),
    exportSmartChild: (...args: Parameters<OmitThisParameter<typeof exportSmartChild>>) => exportSmartChild.apply(context(), args),
    detachSmartChild: (...args: Parameters<OmitThisParameter<typeof detachSmartChild>>) => detachSmartChild.apply(context(), args),
    closeSmartChild: (...args: Parameters<OmitThisParameter<typeof closeSmartChild>>) => closeSmartChild.apply(context(), args),
    smartChildState: (...args: Parameters<OmitThisParameter<typeof smartChildState>>) => smartChildState.apply(context(), args),
    convertToSmartObject: (...args: Parameters<OmitThisParameter<typeof convertToSmartObject>>) => convertToSmartObject.apply(context(), args),
    duplicateSmartObject: (...args: Parameters<OmitThisParameter<typeof duplicateSmartObject>>) => duplicateSmartObject.apply(context(), args),
    replaceSmartContents: (...args: Parameters<OmitThisParameter<typeof replaceSmartContents>>) => replaceSmartContents.apply(context(), args),
    rasterizeSmartObject: (...args: Parameters<OmitThisParameter<typeof rasterizeSmartObject>>) => rasterizeSmartObject.apply(context(), args),
    smartLayerState: (...args: Parameters<OmitThisParameter<typeof smartLayerState>>) => smartLayerState.apply(context(), args),
    exportSmartSource: (...args: Parameters<OmitThisParameter<typeof exportSmartSource>>) => exportSmartSource.apply(context(), args),
    convertSmartToLayers: (...args: Parameters<OmitThisParameter<typeof convertSmartToLayers>>) => convertSmartToLayers.apply(context(), args),
  };
}
