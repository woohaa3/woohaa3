import type { FeatureHandleContext } from "../contracts.js";
import { type EditorResult, type EditorExportBundle } from "../../editor-wasm.js";
import { INTERCHANGE_BINDINGS, type FeatureEncodedImage, type InterchangeBindings } from "./wasm-instance.js";

/** 把 WASM 资源摊平成普通数据并释放句柄（报告仍是未解码的 JSON 文本）。 */
function takeEncoded(resource: FeatureEncodedImage): FeatureEncodedImage {
  try {
    return { bytes: resource.bytes, reportJson: resource.reportJson };
  } finally {
    (resource as FeatureEncodedImage & { free?: () => void }).free?.();
  }
}

/**
 * 取本域新增绑定，缺失时按「内核产物过旧」失败。
 *
 * 宿主可能仍加载着不含本 change 导出的 `.wasm`（升级顺序由集成负责人保证）。这种情况必须是
 * 一条可读的失败，而不是 `TypeError`：调用方按 `ok:false` 走重试/提示，不把缺失当成空结果。
 */
function interchangeBindings(context: FeatureHandleContext): EditorResult<InterchangeBindings> {
  const instance = context.instance as unknown as Record<string, unknown>;
  const missing = INTERCHANGE_BINDINGS.filter((name) => typeof instance[name] !== "function");
  if (missing.length > 0) {
    return {
      ok: false,
      code: "capability-disabled",
      message: `当前编辑内核产物不支持栅格交换（缺少 ${missing.join("、")}）；请更新 WASM 产物后重试`
    };
  }
  return { ok: true, value: instance as unknown as InterchangeBindings };
}

export function placeImage(this: FeatureHandleContext, name: string, assetId: string, bytes: Uint8Array, params: unknown = null): EditorResult<unknown> {
    return this.call((i) => i.placeImage(name, assetId, bytes, JSON.stringify(params ?? null)));
  }

export function saveProject(this: FeatureHandleContext, ): EditorResult<Uint8Array> {
    return this.call((i) => i.saveProject());
  }

export function exportBundle(this: FeatureHandleContext, ): EditorResult<EditorExportBundle> {
    return this.call((i) => {
      const bundle = i.exportBundle();
      try {
        return {
          revision: bundle.revision, documentContentHash: bundle.documentContentHash,
          canvasWidth: bundle.canvasWidth, canvasHeight: bundle.canvasHeight,
          project: bundle.project, output: bundle.output
        };
      } finally {
        bundle.free?.();
      }
    });
  }

export function inspectPlaceAsset(this: FeatureHandleContext, bytes: Uint8Array): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.inspectPlaceAsset(bytes)));
  }

export function placeAsset(this: FeatureHandleContext, bytes: Uint8Array, params: unknown): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.placeAsset(JSON.stringify(params), bytes)));
  }

export function psdMatrix(this: FeatureHandleContext, ): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.psdMatrixJson()));
  }

export function inspectPsd(this: FeatureHandleContext, bytes: Uint8Array): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.inspectPsd(bytes)));
  }

export function importPsd(this: FeatureHandleContext, bytes: Uint8Array, flat = false): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.importPsd(bytes, JSON.stringify({ flat }))));
  }

export function inspectPsdExport(this: FeatureHandleContext, ): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.inspectPsdExport()));
  }

export function exportPsd(this: FeatureHandleContext, rasterizeLossy = false): EditorResult<Uint8Array> {
    return this.call((i) => {
      const bytes = i.exportPsd(JSON.stringify({ rasterizeLossy }));
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error("PSD 导出为空");
      return bytes;
    });
  }

export function lastPsdExportReport(this: FeatureHandleContext, ): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.lastPsdExportReportJson()));
  }
// ---------------------------------------------------------------- U05 逐格式与打开

/** 真实构建的格式矩阵（读写/位深/布局/打开准入与暂缓原因）。 */
export function interchangeMatrix(this: FeatureHandleContext): EditorResult<unknown> {
  const bindings = interchangeBindings(this);
  if (!bindings.ok) return bindings;
  return this.call((i) => JSON.parse(bindings.value.interchangeMatrixJson.call(i)));
}

/** 打开前预检：真实解码一次，核对格式、位深与尺寸；不创建文档。 */
export function inspectRaster(this: FeatureHandleContext, bytes: Uint8Array): EditorResult<unknown> {
  const bindings = interchangeBindings(this);
  if (!bindings.ok) return bindings;
  return this.call((i) => JSON.parse(bindings.value.inspectRaster.call(i, bytes)));
}

/**
 * 可编辑打开（成功后替换当前文档）。
 *
 * 只给**已有文档生命周期**的调用方使用：句柄层的这次替换不会经过工作区的 opened 流程
 * （发布视图、建立基线）。UI 的打开手势必须走 `EditorWorkspaceController.openImage` 对应的
 * 共享管线；见 `../workspace.ts` 的说明。
 */
export function openRaster(this: FeatureHandleContext, name: string, bytes: Uint8Array): EditorResult<unknown> {
  const bindings = interchangeBindings(this);
  if (!bindings.ok) return bindings;
  return this.call((i) => JSON.parse(bindings.value.openRaster.call(i, name, bytes)));
}

// ---------------------------------------------------------------- U06 导出与 Save for Web

/** 通用导出矩阵（可写格式、参数集合与可用 Save for Web 格式词）。 */
export function exportMatrix(this: FeatureHandleContext): EditorResult<unknown> {
  const bindings = interchangeBindings(this);
  if (!bindings.ok) return bindings;
  return this.call((i) => JSON.parse(bindings.value.exportMatrixJson.call(i)));
}

/** 导出预检：设置归一化 + 目标尺寸 + 格式能力，不编码。 */
export function inspectExport(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  const bindings = interchangeBindings(this);
  if (!bindings.ok) return bindings;
  return this.call((i) => JSON.parse(bindings.value.inspectExport.call(i, JSON.stringify(params))));
}

/** 真实编码预览（与交付同一编码器；不提交任何内容）。 */
export function previewExport(this: FeatureHandleContext, params: unknown): EditorResult<FeatureEncodedImage> {
  const bindings = interchangeBindings(this);
  if (!bindings.ok) return bindings;
  return this.call((i) => takeEncoded(bindings.value.previewExport.call(i, JSON.stringify(params))));
}

/** 导出交付（不推进工程保存基线）。 */
export function exportRaster(this: FeatureHandleContext, params: unknown): EditorResult<FeatureEncodedImage> {
  const bindings = interchangeBindings(this);
  if (!bindings.ok) return bindings;
  return this.call((i) => takeEncoded(bindings.value.exportRaster.call(i, JSON.stringify(params))));
}

// ---------------------------------------------------------------- U07 逐层与资产

/** 逐层导出计划：目标层、边界、交付名、改写原因与预算。 */
export function inspectLayerExport(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  const bindings = interchangeBindings(this);
  if (!bindings.ok) return bindings;
  return this.call((i) => JSON.parse(bindings.value.inspectLayerExport.call(i, JSON.stringify(params))));
}

/** 逐层 / Layers to Files 交付（内存 ZIP）。 */
export function exportLayerBundle(this: FeatureHandleContext, params: unknown): EditorResult<FeatureEncodedImage> {
  const bindings = interchangeBindings(this);
  if (!bindings.ok) return bindings;
  return this.call((i) => takeEncoded(bindings.value.exportLayerBundle.call(i, JSON.stringify(params))));
}

/** 单层 Quick Export / Export As（缺省 PNG）。 */
export function exportLayerAs(this: FeatureHandleContext, params: unknown): EditorResult<FeatureEncodedImage> {
  const bindings = interchangeBindings(this);
  if (!bindings.ok) return bindings;
  return this.call((i) => takeEncoded(bindings.value.exportLayerAs.call(i, JSON.stringify(params))));
}

/** 按名称资产计划。 */
export function inspectImageAssets(this: FeatureHandleContext): EditorResult<unknown> {
  const bindings = interchangeBindings(this);
  if (!bindings.ok) return bindings;
  return this.call((i) => JSON.parse(bindings.value.inspectImageAssets.call(i)));
}

/** 按名称资产交付（一次用户触发）。 */
export function exportImageAssets(this: FeatureHandleContext): EditorResult<FeatureEncodedImage> {
  const bindings = interchangeBindings(this);
  if (!bindings.ok) return bindings;
  return this.call((i) => takeEncoded(bindings.value.exportImageAssets.call(i)));
}

/** 复核已交付的包（条目 + report.json）。 */
export function inspectIoBundle(this: FeatureHandleContext, bytes: Uint8Array): EditorResult<unknown> {
  const bindings = interchangeBindings(this);
  if (!bindings.ok) return bindings;
  return this.call((i) => JSON.parse(bindings.value.inspectIoBundle.call(i, bytes)));
}

export function createHandle(context: () => FeatureHandleContext) {
  return {
    placeImage: (...args: Parameters<OmitThisParameter<typeof placeImage>>) => placeImage.apply(context(), args),
    saveProject: (...args: Parameters<OmitThisParameter<typeof saveProject>>) => saveProject.apply(context(), args),
    exportBundle: (...args: Parameters<OmitThisParameter<typeof exportBundle>>) => exportBundle.apply(context(), args),
    inspectPlaceAsset: (...args: Parameters<OmitThisParameter<typeof inspectPlaceAsset>>) => inspectPlaceAsset.apply(context(), args),
    placeAsset: (...args: Parameters<OmitThisParameter<typeof placeAsset>>) => placeAsset.apply(context(), args),
    psdMatrix: (...args: Parameters<OmitThisParameter<typeof psdMatrix>>) => psdMatrix.apply(context(), args),
    inspectPsd: (...args: Parameters<OmitThisParameter<typeof inspectPsd>>) => inspectPsd.apply(context(), args),
    importPsd: (...args: Parameters<OmitThisParameter<typeof importPsd>>) => importPsd.apply(context(), args),
    inspectPsdExport: (...args: Parameters<OmitThisParameter<typeof inspectPsdExport>>) => inspectPsdExport.apply(context(), args),
    exportPsd: (...args: Parameters<OmitThisParameter<typeof exportPsd>>) => exportPsd.apply(context(), args),
    lastPsdExportReport: (...args: Parameters<OmitThisParameter<typeof lastPsdExportReport>>) => lastPsdExportReport.apply(context(), args),
    interchangeMatrix: (...args: Parameters<OmitThisParameter<typeof interchangeMatrix>>) => interchangeMatrix.apply(context(), args),
    inspectRaster: (...args: Parameters<OmitThisParameter<typeof inspectRaster>>) => inspectRaster.apply(context(), args),
    openRaster: (...args: Parameters<OmitThisParameter<typeof openRaster>>) => openRaster.apply(context(), args),
    exportMatrix: (...args: Parameters<OmitThisParameter<typeof exportMatrix>>) => exportMatrix.apply(context(), args),
    inspectExport: (...args: Parameters<OmitThisParameter<typeof inspectExport>>) => inspectExport.apply(context(), args),
    previewExport: (...args: Parameters<OmitThisParameter<typeof previewExport>>) => previewExport.apply(context(), args),
    exportRaster: (...args: Parameters<OmitThisParameter<typeof exportRaster>>) => exportRaster.apply(context(), args),
    inspectLayerExport: (...args: Parameters<OmitThisParameter<typeof inspectLayerExport>>) => inspectLayerExport.apply(context(), args),
    exportLayerBundle: (...args: Parameters<OmitThisParameter<typeof exportLayerBundle>>) => exportLayerBundle.apply(context(), args),
    exportLayerAs: (...args: Parameters<OmitThisParameter<typeof exportLayerAs>>) => exportLayerAs.apply(context(), args),
    inspectImageAssets: (...args: Parameters<OmitThisParameter<typeof inspectImageAssets>>) => inspectImageAssets.apply(context(), args),
    exportImageAssets: (...args: Parameters<OmitThisParameter<typeof exportImageAssets>>) => exportImageAssets.apply(context(), args),
    inspectIoBundle: (...args: Parameters<OmitThisParameter<typeof inspectIoBundle>>) => inspectIoBundle.apply(context(), args),
  };
}
