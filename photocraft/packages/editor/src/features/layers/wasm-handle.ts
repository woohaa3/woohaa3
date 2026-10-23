import type { FeatureHandleContext } from "../contracts.js";
import { readStyleGradientFrame, type StyleGradientFrame } from "../../style-positioning.js";
import { editorPhase } from "../../ports.js";
import { type EditorResult, type EditorPreview, type PatternLibraryState, type ContourPreset, MAX_PATTERN_FILE_BYTES, decodePatternLibrary } from "../../editor-wasm.js";

export function layerThumbnail(this: FeatureHandleContext, layer: number, mask: boolean): EditorResult<EditorPreview> {
    return this.call((i) => {
      const preview=editorPhase("image-editor.thumbnail", () => i.layerThumbnail(layer,mask,64));
      try { return {width:preview.width,height:preview.height,pixels:preview.pixels}; }
      finally { preview.free?.(); }
    });
  }

export function exportLayerTransfer(this: FeatureHandleContext, params: unknown): EditorResult<Uint8Array> {
    return this.call((i) => i.exportLayerTransfer(JSON.stringify(params)));
  }

export function inspectLayerTransfer(this: FeatureHandleContext, bytes: Uint8Array): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.inspectLayerTransfer(bytes)));
  }

export function canPasteLayerTransfer(this: FeatureHandleContext, bytes: Uint8Array): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.canPasteLayerTransfer(bytes)));
  }

export function pasteLayerTransfer(this: FeatureHandleContext, bytes: Uint8Array, params: unknown): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.pasteLayerTransfer(bytes, JSON.stringify(params))));
  }

export function filterLayers(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.filterLayers(JSON.stringify(params))));
  }

// ---------------------------------------------------------------- U57–U64 填充层与图层工作流

/**
 * 新建填充层：`id` 必须是 `layer.newFillLayer.{solidColor,gradient,pattern}` 之一。
 *
 * 命令 id 由内核能力白名单复核；这里只挡住明显的拼写错误，让面板拿到统一失败结果。
 */
export function newFillLayer(this: FeatureHandleContext, id: string, params: unknown): EditorResult<unknown> {
    return this.call((i) => {
      if (!/^layer\.newFillLayer\.(solidColor|gradient|pattern)$/.test(id)) throw new Error(`不是填充层创建命令：${id}`);
      return JSON.parse(i.newFillLayer(id, JSON.stringify(params ?? null)));
    });
  }

export function fillLayerInfo(this: FeatureHandleContext, layer: number): EditorResult<unknown> {
    return this.call((i) => {
      if (!Number.isInteger(layer) || layer < 0) throw new Error("图层 id 必须为非负整数");
      return JSON.parse(i.fillLayerInfo(layer));
    });
  }

export function previewFillLayer(this: FeatureHandleContext, layer: number, params: unknown): EditorResult<unknown> {
    return this.call((i) => {
      if (!Number.isInteger(layer) || layer < 0) throw new Error("图层 id 必须为非负整数");
      const value: unknown = JSON.parse(i.previewFillLayer(layer, JSON.stringify(params ?? null)));
      if (!isRecord(value) || !isRecord(value.info) || !isPreview(value.preview)) throw new Error("填充预览响应无效");
      return value;
    });
  }

export function applyFillLayer(this: FeatureHandleContext, layer: number, params: unknown): EditorResult<unknown> {
    return this.call((i) => {
      if (!Number.isInteger(layer) || layer < 0) throw new Error("图层 id 必须为非负整数");
      const value: unknown = JSON.parse(i.applyFillLayer(layer, JSON.stringify(params ?? null)));
      if (!isRecord(value) || typeof value.kind !== "string" || typeof value.changed !== "boolean") throw new Error("填充确认响应无效");
      return value;
    });
  }

/** 本域统一入口；`preview` 为真时内核只返回候选像素，不写文档。 */
export function layerWorkflow(this: FeatureHandleContext, id: string, params: unknown, preview: boolean): EditorResult<unknown> {
    return this.call((i) => {
      if (typeof id !== "string" || !id.trim()) throw new Error("图层命令 id 不能为空");
      const value: unknown = JSON.parse(i.layerWorkflow(id, JSON.stringify(params ?? null), preview));
      if (!isRecord(value)) throw new Error("图层命令响应无效");
      if (preview && !isPreview(value.preview)) throw new Error("图层预览响应无效");
      if (!preview && typeof value.changed !== "boolean") throw new Error("图层命令确认响应无效");
      return value;
    });
  }

export function layerComps(this: FeatureHandleContext, ): EditorResult<unknown> {
    return this.call((i) => {
      const value: unknown = JSON.parse(i.layerComps());
      if (!isRecord(value) || !Array.isArray(value.comps) || value.comps.length > 64) throw new Error("图层复合响应无效");
      // 每个复合都要带可交付的规范快照；缺它面板只能显示计数，无法判断切复合会改什么。
      for (const comp of value.comps) {
        if (!isRecord(comp) || !Array.isArray(comp.snapshot)) throw new Error("图层复合快照缺失");
      }
      return value;
    });
  }

export function pasteRegion(this: FeatureHandleContext, ): EditorResult<unknown> {
    return this.call((i) => {
      const value: unknown = JSON.parse(i.pasteRegion());
      if (!isRecord(value) || !["pixels", "mask"].includes(String(value.target))) throw new Error("粘贴区域响应无效");
      return value;
    });
  }

/**
 * U61：样式预设管理。
 *
 * 只改会话偏好（不写文档），因此响应里的 `changed` 恒为 false，面板靠 `presetsRevision`
 * 决定是否重绘预设列表。命令 id 由内核能力白名单复核；这里只挡住明显拼错。
 */
export function stylePresets(this: FeatureHandleContext, id: string, params: unknown): EditorResult<unknown> {
    return this.call((i) => {
      if (!/^(style\.presets\.(list|new|edit|reset)|layer\.layerStyle\.(defaultFor|makeDefault))$/.test(id)) throw new Error(`不是样式预设命令：${id}`);
      const value: unknown = JSON.parse(i.stylePresets(id, JSON.stringify(params ?? null)));
      if (!isRecord(value) || value.changed !== false || typeof value.presetsRevision !== "number") throw new Error("样式预设响应无效");
      return value;
    });
  }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 预览必须是正尺寸的 RGBA8 数组；尺寸与字节数不一致说明响应被截断。 */
function isPreview(value: unknown): value is { width: number; height: number; pixels: number[] } {
  if (!isRecord(value)) return false;
  const { width, height, pixels } = value;
  if (typeof width !== "number" || typeof height !== "number" || !Array.isArray(pixels)) return false;
  return width > 0 && height > 0 && width <= 4096 && height <= 4096 && pixels.length === width * height * 4;
}

export function patternLibrary(this: FeatureHandleContext, ):EditorResult<PatternLibraryState> {return this.call(i=>decodePatternLibrary(i.patternLibrary()));}

export function importPatternPresets(this: FeatureHandleContext, bytes:Uint8Array):EditorResult<PatternLibraryState> {return this.call(i=>{
    if(bytes.length>MAX_PATTERN_FILE_BYTES) throw new Error("PAT 文件不能超过 32 MiB");
    return decodePatternLibrary(i.importPatternPresets(bytes));
  });}

export function renamePatternPreset(this: FeatureHandleContext, key:string,name:string):EditorResult<PatternLibraryState> {return this.call(i=>decodePatternLibrary(i.renamePatternPreset(key,name)));}

export function deletePatternPreset(this: FeatureHandleContext, key:string):EditorResult<PatternLibraryState> {return this.call(i=>decodePatternLibrary(i.deletePatternPreset(key)));}

export function exportPatternPresets(this: FeatureHandleContext, key?:string):EditorResult<Uint8Array> {return this.call(i=>i.exportPatternPresets(key));}

export function patternLibrarySnapshot(this: FeatureHandleContext, ):EditorResult<Uint8Array> {return this.call(i=>i.patternLibrarySnapshot());}

export function restorePatternLibrary(this: FeatureHandleContext, bytes:Uint8Array):EditorResult<PatternLibraryState> {return this.call(i=>{
    if(bytes.length>MAX_PATTERN_FILE_BYTES) throw new Error("本机图案库快照不能超过 32 MiB");
    return decodePatternLibrary(i.restorePatternLibrary(bytes));
  });}

export function importContourPresets(this: FeatureHandleContext, bytes:Uint8Array):EditorResult<ContourPreset[]> {
    return this.call(i=>{
      const value:unknown=JSON.parse(i.importContourPresets(bytes));
      if(!Array.isArray(value) || value.length>64 || !value.every(preset=>preset && typeof preset==="object" && typeof preset.name==="string" && preset.name.length<=200 && "contour" in preset)) throw new Error("等高线预设响应无效");
      return value as ContourPreset[];
    });
  }

export function exportContourPreset(this: FeatureHandleContext, contour:unknown):EditorResult<Uint8Array> {return this.call(i=>i.exportContourPreset(JSON.stringify(contour)));}

export function beginLayerProperties(this: FeatureHandleContext, layer:number):EditorResult<unknown> {return this.call(i=>JSON.parse(i.beginLayerProperties(layer)));}

export function previewLayerProperties(this: FeatureHandleContext, params:unknown):EditorResult<unknown> {return this.call(i=>JSON.parse(i.previewLayerProperties(JSON.stringify(params))));}

export function stylePositionFrame(this: FeatureHandleContext, index:number):EditorResult<StyleGradientFrame> {
    return this.call(i=>{
      if(!Number.isInteger(index) || index<0 || index>=64) throw new Error("定位效果索引无效");
      const frame=readStyleGradientFrame(JSON.parse(i.stylePositionFrame(index)));
      if(!frame) throw new Error("原生样式定位帧无效");return frame;
    });
  }

export function commitLayerProperties(this: FeatureHandleContext, ):EditorResult<unknown> {return this.call(i=>JSON.parse(i.commitLayerProperties()));}

export function cancelLayerProperties(this: FeatureHandleContext, ):EditorResult<void> {return this.call(i=>i.cancelLayerProperties());}

export function createHandle(context: () => FeatureHandleContext) {
  return {
    layerThumbnail: (...args: Parameters<OmitThisParameter<typeof layerThumbnail>>) => layerThumbnail.apply(context(), args),
    exportLayerTransfer: (...args: Parameters<OmitThisParameter<typeof exportLayerTransfer>>) => exportLayerTransfer.apply(context(), args),
    inspectLayerTransfer: (...args: Parameters<OmitThisParameter<typeof inspectLayerTransfer>>) => inspectLayerTransfer.apply(context(), args),
    canPasteLayerTransfer: (...args: Parameters<OmitThisParameter<typeof canPasteLayerTransfer>>) => canPasteLayerTransfer.apply(context(), args),
    pasteLayerTransfer: (...args: Parameters<OmitThisParameter<typeof pasteLayerTransfer>>) => pasteLayerTransfer.apply(context(), args),
    filterLayers: (...args: Parameters<OmitThisParameter<typeof filterLayers>>) => filterLayers.apply(context(), args),
    newFillLayer: (...args: Parameters<OmitThisParameter<typeof newFillLayer>>) => newFillLayer.apply(context(), args),
    fillLayerInfo: (...args: Parameters<OmitThisParameter<typeof fillLayerInfo>>) => fillLayerInfo.apply(context(), args),
    previewFillLayer: (...args: Parameters<OmitThisParameter<typeof previewFillLayer>>) => previewFillLayer.apply(context(), args),
    applyFillLayer: (...args: Parameters<OmitThisParameter<typeof applyFillLayer>>) => applyFillLayer.apply(context(), args),
    layerWorkflow: (...args: Parameters<OmitThisParameter<typeof layerWorkflow>>) => layerWorkflow.apply(context(), args),
    layerComps: (...args: Parameters<OmitThisParameter<typeof layerComps>>) => layerComps.apply(context(), args),
    pasteRegion: (...args: Parameters<OmitThisParameter<typeof pasteRegion>>) => pasteRegion.apply(context(), args),
    stylePresets: (...args: Parameters<OmitThisParameter<typeof stylePresets>>) => stylePresets.apply(context(), args),
    patternLibrary: (...args: Parameters<OmitThisParameter<typeof patternLibrary>>) => patternLibrary.apply(context(), args),
    importPatternPresets: (...args: Parameters<OmitThisParameter<typeof importPatternPresets>>) => importPatternPresets.apply(context(), args),
    renamePatternPreset: (...args: Parameters<OmitThisParameter<typeof renamePatternPreset>>) => renamePatternPreset.apply(context(), args),
    deletePatternPreset: (...args: Parameters<OmitThisParameter<typeof deletePatternPreset>>) => deletePatternPreset.apply(context(), args),
    exportPatternPresets: (...args: Parameters<OmitThisParameter<typeof exportPatternPresets>>) => exportPatternPresets.apply(context(), args),
    patternLibrarySnapshot: (...args: Parameters<OmitThisParameter<typeof patternLibrarySnapshot>>) => patternLibrarySnapshot.apply(context(), args),
    restorePatternLibrary: (...args: Parameters<OmitThisParameter<typeof restorePatternLibrary>>) => restorePatternLibrary.apply(context(), args),
    importContourPresets: (...args: Parameters<OmitThisParameter<typeof importContourPresets>>) => importContourPresets.apply(context(), args),
    exportContourPreset: (...args: Parameters<OmitThisParameter<typeof exportContourPreset>>) => exportContourPreset.apply(context(), args),
    beginLayerProperties: (...args: Parameters<OmitThisParameter<typeof beginLayerProperties>>) => beginLayerProperties.apply(context(), args),
    previewLayerProperties: (...args: Parameters<OmitThisParameter<typeof previewLayerProperties>>) => previewLayerProperties.apply(context(), args),
    stylePositionFrame: (...args: Parameters<OmitThisParameter<typeof stylePositionFrame>>) => stylePositionFrame.apply(context(), args),
    commitLayerProperties: (...args: Parameters<OmitThisParameter<typeof commitLayerProperties>>) => commitLayerProperties.apply(context(), args),
    cancelLayerProperties: (...args: Parameters<OmitThisParameter<typeof cancelLayerProperties>>) => cancelLayerProperties.apply(context(), args),
  };
}
