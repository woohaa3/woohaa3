import { createFeatureHandles } from "./features/handles.js";
import * as filesHandle from "./features/files/wasm-handle.js";
import * as ioHandle from "./features/io/wasm-handle.js";
import * as vectorsHandle from "./features/vectors/wasm-handle.js";
import * as selectionsHandle from "./features/selections/wasm-handle.js";
import * as paintingHandle from "./features/painting/wasm-handle.js";
import * as retouchHandle from "./features/retouch/wasm-handle.js";
import * as adjustmentsHandle from "./features/adjustments/wasm-handle.js";
import * as filtersHandle from "./features/filters/wasm-handle.js";
import * as compositionHandle from "./features/composition/wasm-handle.js";
import * as layersHandle from "./features/layers/wasm-handle.js";
import * as smartHandle from "./features/smart/wasm-handle.js";
import * as typeHandle from "./features/type/wasm-handle.js";
import * as viewsHandle from "./features/views/wasm-handle.js";
import type { FeatureHandleContext } from "./features/contracts.js";
import type { FeatureEditorInstance as filesInstance } from "./features/files/wasm-instance.js";
import type { FeatureEditorInstance as ioInstance } from "./features/io/wasm-instance.js";
import type { FeatureEditorInstance as vectorsInstance } from "./features/vectors/wasm-instance.js";
import type { FeatureEditorInstance as selectionsInstance } from "./features/selections/wasm-instance.js";
import type { FeatureEditorInstance as channelsInstance } from "./features/channels/wasm-instance.js";
import type { FeatureEditorInstance as paintingInstance } from "./features/painting/wasm-instance.js";
import type { FeatureEditorInstance as retouchInstance } from "./features/retouch/wasm-instance.js";
import type { FeatureEditorInstance as adjustmentsInstance } from "./features/adjustments/wasm-instance.js";
import type { FeatureEditorInstance as modesInstance } from "./features/modes/wasm-instance.js";
import type { FeatureEditorInstance as filtersInstance } from "./features/filters/wasm-instance.js";
import type { FeatureEditorInstance as compositionInstance } from "./features/composition/wasm-instance.js";
import type { FeatureEditorInstance as layersInstance } from "./features/layers/wasm-instance.js";
import type { FeatureEditorInstance as smartInstance } from "./features/smart/wasm-instance.js";
import type { FeatureEditorInstance as typeInstance } from "./features/type/wasm-instance.js";
import type { FeatureEditorInstance as viewsInstance } from "./features/views/wasm-instance.js";
import type { FeatureEditorInstance as customizationInstance } from "./features/customization/wasm-instance.js";
import type { FeatureEditorInstance as historyInstance } from "./features/history/wasm-instance.js";
import type { FeatureEditorInstance as animationInstance } from "./features/animation/wasm-instance.js";
/**
 * 编辑内核的 wasm 绑定与加载器
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 3.1/3.2 / design D1/D3）。
 *
 * React **按需**动态 import wasm-bindgen 生成的 glue（本子项目的 `scripts/build-wasm.mjs`
 * 产出到 `packages/editor/dist/wasm/`，经 package exports 暴露），不再有 iframe、
 * `window.message`、origin 校验或桥协议。本模块只做两件事：
 *
 * 1. 声明 glue 的**稳定类型面**（与 Rust `crates/editor-core/src/wasm.rs` 的导出逐一对齐）；
 * 2. 按需加载模块并创建一个会话句柄，把内核 JSON/字节转成前端类型。
 *
 * 内核抛出的错误是 `{code,message}` 的字符串；本模块把它们归一化成 `EditorFailure`，
 * 调用方不需要 try/catch 解析 JSON。
 */

import { PHOTOCRAFT_ENGINE_COMMIT, PHOTOCRAFT_ENGINE_VERSION, SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS, verifyPhotocraftHandshake } from "@woohaa3/photocraft-protocol";
import { type StyleGradientFrame } from "./style-positioning.js";
import { decodeTextGeometry, type TextGeometry, type TextGeometryRequest } from "./text-geometry.js";
import { editorMetric, editorPhase, editorPreview, type EditorAssetPort } from "./ports.js";

/** 合成预览。 */
export type EditorPreview = { width: number; height: number; pixels: Uint8Array };
/** 源像素区域，不接受目标层或缩放参数。 */
export type EditorPreviewRegion = { x: number; y: number; width: number; height: number };

/** wasm-bindgen 返回的资源对象；字段可能是原型 getter，不能直接展开传递。 */
export type WasmResource<T> = T & { free?: () => void };

/** 一次冻结导出的成对产物。 */
export type EditorExportBundle = {
  revision: number;
  documentContentHash: string;
  canvasWidth: number;
  canvasHeight: number;
  project: Uint8Array;
  output: Uint8Array;
};

/** 内核错误。 */
export type EditorFailure = { ok: false; code: string; message: string };
/** 成功结果。 */
export type EditorSuccess<T> = { ok: true; value: T };
export type EditorResult<T> = EditorSuccess<T> | EditorFailure;

/** wasm-bindgen 生成的 `WasmEditor` 实例（稳定类型面）。 */
export type ContourPreset = {name:string;contour:unknown};
export type StylePatternPreset={id:string;name:string;width:number;height:number};
export type UserPatternPreset=StylePatternPreset & {key:string};
export type PatternLibraryState={presets:UserPatternPreset[];patternPresets?:StylePatternPreset[]};
export const MAX_PATTERN_FILE_BYTES=32*1024*1024;
/** ABR 单文件预算（与 `rust/project-limits.json` 的 `maxAbrFileBytes` 一致）。 */
export const MAX_ABR_FILE_BYTES=32*1024*1024;
export function decodePatternLibrary(raw:string):PatternLibraryState {
  const value=JSON.parse(raw) as PatternLibraryState;
  const name=(s:unknown)=>typeof s==="string" && !!s.trim() && s.length<=200 && !s.includes("\0");
  const list=(items:unknown,max:number,user=false):items is UserPatternPreset[]=>{
    if(!Array.isArray(items) || items.length>max) return false;
    const ids=new Set<string>(),keys=new Set<string>();let pixels=0;
    return items.every(p=>{
      if(!p || typeof p!=="object" || !name(p.id) || !name(p.name) || ids.has(p.id) || !Number.isInteger(p.width) || !Number.isInteger(p.height) || p.width<1 || p.height<1 || p.width>1024 || p.height>1024) return false;
      if(user && (!name(p.key) || keys.has(p.key))) return false;
      ids.add(p.id);keys.add(p.key);pixels+=p.width*p.height;return !user || pixels<=4_194_304;
    });
  };
  if(!value || typeof value!=="object" || !list(value.presets,64,true) || (value.patternPresets!==undefined && !list(value.patternPresets,192))) throw new Error("图案库响应无效");
  return value;
}

export type EditorInstance = {
textGeometry(paramsJson: string): string;
renderPreview(maxSide: number): WasmResource<EditorPreview>;
renderRegion(paramsJson: string): WasmResource<EditorPreview>;
contentHash(): string;
assetIdsJson(): string;
commandsJson(): string;
allowedCommandIdsJson(): string;
stateJson(): string;
capabilityHandshakeJson(): string;
retouchStateJson(): string;
execute(id: string, paramsJson: string): string;
undo(): string;
redo(): string;
} & filesInstance & ioInstance & vectorsInstance & selectionsInstance & channelsInstance & paintingInstance & retouchInstance & adjustmentsInstance & modesInstance & filtersInstance & compositionInstance & layersInstance & smartInstance & typeInstance & viewsInstance & customizationInstance & historyInstance & animationInstance;

/** wasm-bindgen 生成的模块（稳定类型面）。 */
export type EditorModule = {
  default: (input?: unknown) => Promise<unknown>;
  WasmEditor: {
    new (): EditorInstance;
    /** 上游固定提交、宿主能力与格式版本。 */
    buildInfoJson(): string;
    registerFixedFont(bytes: Uint8Array): void;
  };
};

/** 加载 glue 的工厂（默认为字面量动态 import；测试注入替身）。 */
export type EditorModuleFactory = () => Promise<EditorModule>;

/**
 * 默认工厂：产物由子项目 `scripts/build-wasm.mjs` 生成到 `packages/editor/dist/wasm/`。
 *
 * 用**字面量**动态 import：Vite 把它切成独立 chunk，只有真正进入编辑器时才请求（普通页面初始加载
 * 不下载数十 MiB 的 wasm）；glue 内部的 `new URL('./photocraft_editor_bg.wasm', import.meta.url)`
 * 由 Vite 改写成随包资源 URL，根挂载与子路径部署都可用。
 *
 * 不能把产物放进 `public/` 再用变量 URL 动态 import：Vite 开发服务器会给动态 import 补 `?import`
 * 并走转换管线，而 `public/` 下的 `.js` 不经过插件转换，会直接报错（实测踩过）。
 */
let fixedFont: Promise<void> | null = null;
/**
 * 默认工厂：**字面量**动态 import 本包 `./wasm` 子路径（由 `scripts/build-wasm.mjs` 产出到
 * `dist/wasm/`）。Vite 把它切成独立 chunk，只有真正进入编辑器时才请求 wasm；glue 内部的
 * `new URL('./photocraft_editor_bg.wasm', import.meta.url)` 由消费方构建器改写成随包资源 URL。
 *
 * 不能把产物放进宿主 public 再用变量 URL import：开发服务器会给动态 import 补 `?import`，
 * 而 public 下的 `.js` 不经过转换管线。
 */
const defaultModuleFactory: EditorModuleFactory = async () => {
  // 产物由 `scripts/build-wasm.mjs` 生成；类型面由本模块显式声明，不依赖 glue 的生成声明。
  return import("@woohaa3/photocraft-editor/wasm") as unknown as Promise<EditorModule>;
};

/** 内核 build-info。 */
export type EditorBuildInfo = { upstreamCommit: string; upstreamVersion: string; engineVersion: string; formatVersion: number };

async function registerFixedFont(module: EditorModule, assetUrl: EditorAssetPort): Promise<void> {
  fixedFont ??= (async () => {
    const response = await fetch(assetUrl("/assets/fonts/NotoSansSC-Regular.otf"), { credentials: "same-origin" });
    if (!response.ok) throw new Error("中文字体加载失败，请重试");
    module.WasmEditor.registerFixedFont(new Uint8Array(await response.arrayBuffer()));
  })().catch((error) => { fixedFont = null; throw error; });
  await fixedFont;
}

/** 一个已就绪的编辑会话句柄：把内核调用包成 `EditorResult`，不抛异常。 */
export class EditorHandle {
  readonly features = createFeatureHandles(() => this.featureHandleContext());
  private readonly instance: EditorInstance;
  readonly buildInfo: EditorBuildInfo;

  constructor(instance: EditorInstance, buildInfo: EditorBuildInfo) {
    this.instance = instance;
    this.buildInfo = buildInfo;
  }

  openImage(name: string, assetId: string, bytes: Uint8Array): EditorResult<unknown> { return filesHandle.openImage.call(this.featureHandleContext(), name, assetId, bytes); }

  openProject(bytes: Uint8Array, baseAssetId: string): EditorResult<unknown> { return filesHandle.openProject.call(this.featureHandleContext(), bytes, baseAssetId); }

  placeImage(name: string, assetId: string, bytes: Uint8Array, params: unknown = null): EditorResult<unknown> { return ioHandle.placeImage.call(this.featureHandleContext(), name, assetId, bytes, params); }

  /** 序列化当前工程；返回 `.pcraft` 字节。 */
  saveProject(): EditorResult<Uint8Array> { return ioHandle.saveProject.call(this.featureHandleContext(), ); }

  renderPreview(maxSide: number): EditorResult<EditorPreview> {
    return this.call((i) => {
      return editorPreview("full", () => {
      const preview = editorMetric("full.kernel", () => i.renderPreview(maxSide));
      try {
        // 显式取值，向 React 和纹理端口交付普通数据；pixels getter 已复制 WASM 字节。
        return { width: preview.width, height: preview.height, pixels: editorMetric("full.pixel-copy", () => preview.pixels, preview.width * preview.height * 4) };
      } finally {
        preview.free?.();
      }
      });
    });
  }

  sampleColor(x: number, y: number): EditorResult<string | null> { return paintingHandle.sampleColor.call(this.featureHandleContext(), x, y); }

  renderRegion(region: EditorPreviewRegion): EditorResult<EditorPreview> {
    // 提前校验，避免非法数值在 JSON/wasm-bindgen 中被转换成别的有效坐标。
    const {x,y,width,height}=region;
    if (![x,y,width,height].every(Number.isSafeInteger) || x<0 || y<0 || width<1 || height<1 || width>1024 || height>1024 || x+width>2147483647 || y+height>2147483647) {
      return {ok:false,code:"render-failed",message:"预览区域须为整数坐标，宽高为 1–1024 源像素"};
    }
    return this.call((i)=>{
      return editorPreview("region", () => {
      const preview=editorMetric("region.kernel", () => i.renderRegion(JSON.stringify({x,y,width,height})));
      try {
        const result={width:preview.width,height:preview.height,pixels:editorMetric("region.pixel-copy", () => preview.pixels, width*height*4)};
        if (result.width!==width || result.height!==height || !(result.pixels instanceof Uint8Array) || result.pixels.length!==width*height*4) throw new Error("源像素预览数据不完整");
        return result;
      } finally { preview.free?.(); }
      });
    });
  }

  layerThumbnail(layer: number, mask: boolean): EditorResult<EditorPreview> { return layersHandle.layerThumbnail.call(this.featureHandleContext(), layer, mask); }

  /** 冻结导出：同一修订的工程与 PNG。 */
  exportBundle(): EditorResult<EditorExportBundle> { return ioHandle.exportBundle.call(this.featureHandleContext(), ); }

  contentHash(): EditorResult<string> {
    return editorPhase("image-editor.content-hash", () => this.call((i) => i.contentHash()));
  }

  assetIds(): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.assetIdsJson()));
  }

  commands(): EditorResult<unknown> {
    return editorPhase("image-editor.commands", () => this.call((i) => JSON.parse(i.commandsJson())));
  }

  allowedCommandIds(): EditorResult<string[]> {
    return this.call((i) => JSON.parse(i.allowedCommandIdsJson()));
  }

  state(): EditorResult<unknown> {
    return editorPhase("image-editor.state", () => this.call((i) => JSON.parse(i.stateJson())));
  }

  execute(id: string, params: unknown = null): EditorResult<unknown> {
    return this.call((i) => i.execute(id, JSON.stringify(params ?? null)));
  }

  beginStroke(params: unknown): EditorResult<void> { return paintingHandle.beginStroke.call(this.featureHandleContext(), params); }

  // ---------------------------------------------------------------- 笔刷库（P1a/P1b）

  brushPresets(full = false): EditorResult<unknown> { return paintingHandle.brushPresets.call(this.featureHandleContext(), full); }

  brushPreset(name: string): EditorResult<unknown> { return paintingHandle.brushPreset.call(this.featureHandleContext(), name); }

  saveBrushPreset(params: unknown): EditorResult<unknown> { return paintingHandle.saveBrushPreset.call(this.featureHandleContext(), params); }

  renameBrushPreset(name: string, newName: string): EditorResult<unknown> { return paintingHandle.renameBrushPreset.call(this.featureHandleContext(), name, newName); }

  deleteBrushPreset(name: string): EditorResult<unknown> { return paintingHandle.deleteBrushPreset.call(this.featureHandleContext(), name); }

  moveBrushPreset(params: unknown): EditorResult<unknown> { return paintingHandle.moveBrushPreset.call(this.featureHandleContext(), params); }

  selectBrushPreset(name: string): EditorResult<unknown> { return paintingHandle.selectBrushPreset.call(this.featureHandleContext(), name); }

  /** 真实内核笔迹预览（`{name}` 或 `{brush, side}`）。 */
  brushPreview(params: unknown): EditorResult<EditorPreview> { return paintingHandle.brushPreview.call(this.featureHandleContext(), params); }

  brushLibrarySnapshot(): EditorResult<Uint8Array> { return paintingHandle.brushLibrarySnapshot.call(this.featureHandleContext(), ); }

  restoreBrushLibrary(bytes: Uint8Array): EditorResult<unknown> { return paintingHandle.restoreBrushLibrary.call(this.featureHandleContext(), bytes); }

  inspectBrushAbr(bytes: Uint8Array, group: string): EditorResult<unknown> { return paintingHandle.inspectBrushAbr.call(this.featureHandleContext(), bytes, group); }

  commitBrushAbr(params: unknown): EditorResult<unknown> { return paintingHandle.commitBrushAbr.call(this.featureHandleContext(), params); }

  cancelBrushAbr(): EditorResult<unknown> { return paintingHandle.cancelBrushAbr.call(this.featureHandleContext(), ); }

  importBrushFromImage(name: string, bytes: Uint8Array, params: unknown): EditorResult<unknown> { return paintingHandle.importBrushFromImage.call(this.featureHandleContext(), name, bytes, params); }

  /** 分阶段能力协商快照。 */
  capabilityHandshake(): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.capabilityHandshakeJson()));
  }

  // ---------------------------------------------------------------- P2 跨文档

  /** 导出选中图层为跨文档载荷字节。 */
  exportLayerTransfer(params: unknown): EditorResult<Uint8Array> { return layersHandle.exportLayerTransfer.call(this.featureHandleContext(), params); }

  inspectLayerTransfer(bytes: Uint8Array): EditorResult<unknown> { return layersHandle.inspectLayerTransfer.call(this.featureHandleContext(), bytes); }

  canPasteLayerTransfer(bytes: Uint8Array): EditorResult<unknown> { return layersHandle.canPasteLayerTransfer.call(this.featureHandleContext(), bytes); }

  pasteLayerTransfer(bytes: Uint8Array, params: unknown): EditorResult<unknown> { return layersHandle.pasteLayerTransfer.call(this.featureHandleContext(), bytes, params); }

  /** 置入前预检：真实解码类型与尺寸。 */
  inspectPlaceAsset(bytes: Uint8Array): EditorResult<unknown> { return ioHandle.inspectPlaceAsset.call(this.featureHandleContext(), bytes); }

  /** 图片置入当前文档。 */
  placeAsset(bytes: Uint8Array, params: unknown): EditorResult<unknown> { return ioHandle.placeAsset.call(this.featureHandleContext(), bytes, params); }

  // ---------------------------------------------------------------- P3 PSD

  psdMatrix(): EditorResult<unknown> { return ioHandle.psdMatrix.call(this.featureHandleContext(), ); }

  inspectPsd(bytes: Uint8Array): EditorResult<unknown> { return ioHandle.inspectPsd.call(this.featureHandleContext(), bytes); }

  importPsd(bytes: Uint8Array, flat = false): EditorResult<unknown> { return ioHandle.importPsd.call(this.featureHandleContext(), bytes, flat); }

  inspectPsdExport(): EditorResult<unknown> { return ioHandle.inspectPsdExport.call(this.featureHandleContext(), ); }

  /** 导出 PSD；逐层报告用 `lastPsdExportReport()` 读取。 */
  exportPsd(rasterizeLossy = false): EditorResult<Uint8Array> { return ioHandle.exportPsd.call(this.featureHandleContext(), rasterizeLossy); }

  lastPsdExportReport(): EditorResult<unknown> { return ioHandle.lastPsdExportReport.call(this.featureHandleContext(), ); }

  // ---------------------------------------------------------------- P4 智能对象

  beginSmartChild(layer: number): EditorResult<unknown> { return smartHandle.beginSmartChild.call(this.featureHandleContext(), layer); }

  updateSmartParent(attemptId: string, child: Uint8Array): EditorResult<unknown> { return smartHandle.updateSmartParent.call(this.featureHandleContext(), attemptId, child); }

  reloadSmartChild(): EditorResult<unknown> { return smartHandle.reloadSmartChild.call(this.featureHandleContext(), ); }

  exportSmartChild(): EditorResult<Uint8Array> { return smartHandle.exportSmartChild.call(this.featureHandleContext(), ); }

  detachSmartChild(): EditorResult<unknown> { return smartHandle.detachSmartChild.call(this.featureHandleContext(), ); }

  closeSmartChild(): EditorResult<unknown> { return smartHandle.closeSmartChild.call(this.featureHandleContext(), ); }

  smartChildState(): EditorResult<unknown> { return smartHandle.smartChildState.call(this.featureHandleContext(), ); }

  convertToSmartObject(layers: readonly number[]): EditorResult<unknown> { return smartHandle.convertToSmartObject.call(this.featureHandleContext(), layers); }

  duplicateSmartObject(layers: readonly number[], independent: boolean): EditorResult<unknown> { return smartHandle.duplicateSmartObject.call(this.featureHandleContext(), layers, independent); }

  replaceSmartContents(layer: number, bytes: Uint8Array): EditorResult<unknown> { return smartHandle.replaceSmartContents.call(this.featureHandleContext(), layer, bytes); }

  rasterizeSmartObject(layer: number): EditorResult<unknown> { return smartHandle.rasterizeSmartObject.call(this.featureHandleContext(), layer); }

  // ---------------------------------------------------------------- P5 调色与选区

  histogram(params: unknown): EditorResult<unknown> { return adjustmentsHandle.histogram.call(this.featureHandleContext(), params); }

  beginSelectionModify(params: unknown): EditorResult<unknown> { return selectionsHandle.beginSelectionModify.call(this.featureHandleContext(), params); }

  updateSelectionModify(params: unknown): EditorResult<unknown> { return selectionsHandle.updateSelectionModify.call(this.featureHandleContext(), params); }

  commitSelectionModify(): EditorResult<unknown> { return selectionsHandle.commitSelectionModify.call(this.featureHandleContext(), ); }

  cancelSelectionModify(): EditorResult<unknown> { return selectionsHandle.cancelSelectionModify.call(this.featureHandleContext(), ); }

  prepareRefineEdge(params: unknown): EditorResult<unknown> { return selectionsHandle.prepareRefineEdge.call(this.featureHandleContext(), params); }

  // ---------------------------------------------------------------- P6 修饰与滤镜

  beginRetouch(id: string, params: unknown): EditorResult<unknown> { return retouchHandle.beginRetouch.call(this.featureHandleContext(), id, params); }

  appendRetouch(points: unknown): EditorResult<unknown> { return retouchHandle.appendRetouch.call(this.featureHandleContext(), points); }

  commitRetouch(): EditorResult<unknown> { return retouchHandle.commitRetouch.call(this.featureHandleContext(), ); }

  cancelRetouch(): EditorResult<unknown> { return retouchHandle.cancelRetouch.call(this.featureHandleContext(), ); }

  retouchState(): EditorResult<unknown> {
    return this.call((i) => JSON.parse(i.retouchStateJson()));
  }

  // 区域修饰（修补／内容识别移动／红眼）：候选 → 确认/取消。U37 的公共入口，
  // 与 `features.retouch` 同一实现，供共享画布手势与宿主直接调用。
  beginRetouchRegion(id: string, params: unknown): EditorResult<unknown> { return retouchHandle.beginRetouchRegion.call(this.featureHandleContext(), id, params); }

  commitRetouchRegion(): EditorResult<unknown> { return retouchHandle.commitRetouchRegion.call(this.featureHandleContext(), ); }

  cancelRetouchRegion(): EditorResult<unknown> { return retouchHandle.cancelRetouchRegion.call(this.featureHandleContext(), ); }

  retouchHistorySources(): EditorResult<unknown> { return retouchHandle.retouchHistorySources.call(this.featureHandleContext(), ); }

  retouchCloneSources(): EditorResult<unknown> { return retouchHandle.retouchCloneSources.call(this.featureHandleContext(), ); }

  beginFilter(id: string, params: unknown): EditorResult<unknown> { return filtersHandle.beginFilter.call(this.featureHandleContext(), id, params); }

  updateFilter(params: unknown): EditorResult<unknown> { return filtersHandle.updateFilter.call(this.featureHandleContext(), params); }

  commitFilter(): EditorResult<unknown> { return filtersHandle.commitFilter.call(this.featureHandleContext(), ); }

  cancelFilter(): EditorResult<unknown> { return filtersHandle.cancelFilter.call(this.featureHandleContext(), ); }

  // ---------------------------------------------------------------- P7 构图与矢量

  beginCompose(id: string, params: unknown): EditorResult<unknown> { return compositionHandle.beginCompose.call(this.featureHandleContext(), id, params); }

  updateCompose(params: unknown): EditorResult<unknown> { return compositionHandle.updateCompose.call(this.featureHandleContext(), params); }

  commitCompose(): EditorResult<unknown> { return compositionHandle.commitCompose.call(this.featureHandleContext(), ); }

  cancelCompose(): EditorResult<unknown> { return compositionHandle.cancelCompose.call(this.featureHandleContext(), ); }

  viewAids(): EditorResult<unknown> { return viewsHandle.viewAids.call(this.featureHandleContext(), ); }

  setViewAids(params: unknown): EditorResult<unknown> { return viewsHandle.setViewAids.call(this.featureHandleContext(), params); }

  snapPoint(params: unknown): EditorResult<unknown> { return viewsHandle.snapPoint.call(this.featureHandleContext(), params); }

  filterLayers(params: unknown): EditorResult<unknown> { return layersHandle.filterLayers.call(this.featureHandleContext(), params); }

  applyTypography(params: unknown): EditorResult<unknown> { return typeHandle.applyTypography.call(this.featureHandleContext(), params); }

  vectorCommand(id: string, params: unknown): EditorResult<unknown> { return vectorsHandle.vectorCommand.call(this.featureHandleContext(), id, params); }

  guideCommand(id: string, params: unknown): EditorResult<unknown> { return viewsHandle.guideCommand.call(this.featureHandleContext(), id, params); }

  vectorSnapshot(): EditorResult<unknown> { return vectorsHandle.vectorSnapshot.call(this.featureHandleContext(), ); }

  checkFont(font: string): EditorResult<unknown> { return typeHandle.checkFont.call(this.featureHandleContext(), font); }

  beginAdjustment(layer: number): EditorResult<unknown> { return adjustmentsHandle.beginAdjustment.call(this.featureHandleContext(), layer); }
  patternLibrary():EditorResult<PatternLibraryState> { return layersHandle.patternLibrary.call(this.featureHandleContext(), ); }
  importPatternPresets(bytes:Uint8Array):EditorResult<PatternLibraryState> { return layersHandle.importPatternPresets.call(this.featureHandleContext(), bytes); }
  renamePatternPreset(key:string,name:string):EditorResult<PatternLibraryState> { return layersHandle.renamePatternPreset.call(this.featureHandleContext(), key, name); }
  deletePatternPreset(key:string):EditorResult<PatternLibraryState> { return layersHandle.deletePatternPreset.call(this.featureHandleContext(), key); }
  exportPatternPresets(key?:string):EditorResult<Uint8Array> { return layersHandle.exportPatternPresets.call(this.featureHandleContext(), key); }
  patternLibrarySnapshot():EditorResult<Uint8Array> { return layersHandle.patternLibrarySnapshot.call(this.featureHandleContext(), ); }
  restorePatternLibrary(bytes:Uint8Array):EditorResult<PatternLibraryState> { return layersHandle.restorePatternLibrary.call(this.featureHandleContext(), bytes); }
  importContourPresets(bytes:Uint8Array):EditorResult<ContourPreset[]> { return layersHandle.importContourPresets.call(this.featureHandleContext(), bytes); }
  exportContourPreset(contour:unknown):EditorResult<Uint8Array> { return layersHandle.exportContourPreset.call(this.featureHandleContext(), contour); }
  beginLayerProperties(layer:number):EditorResult<unknown> { return layersHandle.beginLayerProperties.call(this.featureHandleContext(), layer); }
  previewLayerProperties(params:unknown):EditorResult<unknown> { return layersHandle.previewLayerProperties.call(this.featureHandleContext(), params); }
  stylePositionFrame(index:number):EditorResult<StyleGradientFrame> { return layersHandle.stylePositionFrame.call(this.featureHandleContext(), index); }
  commitLayerProperties():EditorResult<unknown> { return layersHandle.commitLayerProperties.call(this.featureHandleContext(), ); }
  cancelLayerProperties():EditorResult<void> { return layersHandle.cancelLayerProperties.call(this.featureHandleContext(), ); }
  previewAdjustment(params: unknown): EditorResult<unknown> { return adjustmentsHandle.previewAdjustment.call(this.featureHandleContext(), params); }
  commitAdjustment(): EditorResult<unknown> { return adjustmentsHandle.commitAdjustment.call(this.featureHandleContext(), ); }
  cancelAdjustment(): EditorResult<void> { return adjustmentsHandle.cancelAdjustment.call(this.featureHandleContext(), ); }
  curveGeometry(points: readonly [number,number][]): EditorResult<number[]> { return adjustmentsHandle.curveGeometry.call(this.featureHandleContext(), points); }

  beginText(params: unknown): EditorResult<unknown> { return typeHandle.beginText.call(this.featureHandleContext(), params); }
  previewText(params: unknown): EditorResult<unknown> { return typeHandle.previewText.call(this.featureHandleContext(), params); }
  textGeometry(params: TextGeometryRequest): EditorResult<TextGeometry> {
    return this.call((i) => decodeTextGeometry(JSON.parse(i.textGeometry(JSON.stringify(params)))));
  }
  commitText(): EditorResult<unknown> { return typeHandle.commitText.call(this.featureHandleContext(), ); }
  cancelText(): EditorResult<void> { return typeHandle.cancelText.call(this.featureHandleContext(), ); }

  beginMove(params: { x: number; y: number; autoSelect: boolean; duplicate: boolean }): EditorResult<boolean> { return compositionHandle.beginMove.call(this.featureHandleContext(), params); }

  beginTransform(selectionOnly = false): EditorResult<void> { return compositionHandle.beginTransform.call(this.featureHandleContext(), selectionOnly); }
  previewTransform(matrix: readonly number[]): EditorResult<void> { return compositionHandle.previewTransform.call(this.featureHandleContext(), matrix); }
  commitTransform(): EditorResult<unknown> { return compositionHandle.commitTransform.call(this.featureHandleContext(), ); }
  cancelTransform(): EditorResult<void> { return compositionHandle.cancelTransform.call(this.featureHandleContext(), ); }

  appendStroke(points: unknown): EditorResult<void> { return paintingHandle.appendStroke.call(this.featureHandleContext(), points); }

  takeStrokeDamage():EditorResult<EditorPreviewRegion[]> { return paintingHandle.takeStrokeDamage.call(this.featureHandleContext(), ); }

  commitStroke(): EditorResult<unknown> { return paintingHandle.commitStroke.call(this.featureHandleContext(), ); }

  cancelStroke(): EditorResult<void> { return paintingHandle.cancelStroke.call(this.featureHandleContext(), ); }

  undo(): EditorResult<unknown> {
    return this.call((i) => i.undo());
  }

  redo(): EditorResult<unknown> {
    return this.call((i) => i.redo());
  }

  hasDocument(): boolean { return filesHandle.hasDocument.call(this.featureHandleContext(), ); }

  closeDocument(): EditorResult<unknown> { return filesHandle.closeDocument.call(this.featureHandleContext(), ); }

  /** 统一捕获内核错误：内核抛 `{code,message}` 字符串。 */
  private featureHandleContext(): FeatureHandleContext { return { instance: this.instance, call: run => this.call(run) }; }

  private call<T>(run: (instance: EditorInstance) => T): EditorResult<T> {
    try {
      return { ok: true, value: run(this.instance) };
    } catch (error) {
      return failureFrom(error);
    }
  }
}

/**
 * 按需加载编辑内核并创建会话。
 *
 * 加载失败（产物缺失、实例化失败）返回 `ok:false`，调用方保留图片查看能力并给出可重试原因。
 */
export async function loadEditor(
  factory: EditorModuleFactory = defaultModuleFactory,
  options: { assetUrl?: EditorAssetPort } = {}
): Promise<EditorResult<EditorHandle>> {
  try {
    const module = await factory();
    await module.default();
    const buildInfo = parseBuildInfo(() => module.WasmEditor.buildInfoJson());
    // 先核对实际加载产物；旧工程读取兼容表不用于运行时能力匹配。
    if (factory === defaultModuleFactory) await registerFixedFont(module, options.assetUrl ?? ((path) => path));
    const instance = new module.WasmEditor();
    // 运行时能力协商：内核自报的阶段/能力必须与当前界面契约一致，否则拒绝创建可写实例。
    // 这样「新界面 + 旧 WASM」不会渲染出没有实现的入口，「旧界面 + 新 WASM」也不会
    // 悄悄按旧语义解释新命令（change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.3）。
    try {
      parseHandshake(() => (instance as { capabilityHandshakeJson?(): string }).capabilityHandshakeJson?.call(instance));
    } catch (error) {
      // 协商失败不保留半初始化实例：释放 WASM 对象再按稳定错误码拒绝。
      (instance as { free?(): void }).free?.();
      throw error;
    }
    return { ok: true, value: new EditorHandle(instance, buildInfo) };
  } catch (error) {
    return failureFrom(error, "editor-load-failed", "无法加载图像编辑内核");
  }
}

/**
 * 校验内核上报的能力协商快照。
 *
 * 只接受与协议契约逐项一致的阶段与能力清单；结构缺失、畸形或漂移都拒绝创建可写实例
 * （错误码与消息由协议包统一提供，界面按同一字符串判定）。
 */
function parseHandshake(read: () => string | undefined): void {
  let parsed: unknown;
  try {
    const raw = read();
    if (typeof raw !== "string") throw new Error("missing handshake");
    parsed = JSON.parse(raw);
  } catch {
    throw { code: "capability-drift", message: "图像编辑内核缺少能力协商，请刷新页面后重试" };
  }
  const verified = verifyPhotocraftHandshake(parsed);
  if (!verified.ok) throw { code: verified.code, message: verified.message };
}

function parseBuildInfo(read: () => string): EditorBuildInfo {
  try {
    const parsed: unknown = JSON.parse(read());
    if (typeof parsed === "object" && parsed !== null) {
      const value = parsed as Record<string, unknown>;
      if (value.upstreamCommit === PHOTOCRAFT_ENGINE_COMMIT &&
          value.engineVersion === PHOTOCRAFT_ENGINE_VERSION &&
          typeof value.upstreamVersion === "string" && value.upstreamVersion.trim().length > 0 &&
          typeof value.formatVersion === "number" && SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS.includes(value.formatVersion)) {
        return {
          upstreamCommit: value.upstreamCommit, upstreamVersion: value.upstreamVersion,
          engineVersion: value.engineVersion, formatVersion: value.formatVersion
        };
      }
    }
  } catch {
    // 不接受缺失或畸形元数据，也不从前端常量补造内核能力。
  }
  throw { code: "unsupported-engine-version", message: "图像编辑内核版本不匹配，请刷新页面后重试" };
}

/** 把内核抛出的错误归一化成 `{ok:false, code, message}`。 */
export function failureFrom(
  error: unknown,
  fallbackCode = "unknown",
  fallbackMessage = "图像编辑操作失败"
): EditorFailure {
  if (typeof error === "object" && error !== null) {
    const value = error as Record<string, unknown>;
    if (typeof value.code === "string" && value.code.length > 0) {
      return {
        ok: false,
        code: value.code,
        message: typeof value.message === "string" ? value.message : fallbackMessage
      };
    }
  }
  if (typeof error === "string") {
    try {
      return failureFrom(JSON.parse(error), fallbackCode, fallbackMessage);
    } catch {
      return { ok: false, code: fallbackCode, message: error || fallbackMessage };
    }
  }
  if (error instanceof Error && error.message) {
    return { ok: false, code: fallbackCode, message: error.message };
  }
  return { ok: false, code: fallbackCode, message: fallbackMessage };
}
