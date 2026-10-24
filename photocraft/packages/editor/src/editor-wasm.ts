import {decodeHistogram,type HistogramReadout} from "./histogram-data.js";
import {validatePixelGridRegion,decodePixelGrid,type PixelGridRegion,type PixelGridSegment} from "./pixel-grid-data.js";
import {decodeInfoReadout,type InfoReadout,type InfoRequest} from "./info-readout.js";
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

import { PHOTOCRAFT_ENGINE_COMMIT, PHOTOCRAFT_ENGINE_VERSION, SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS } from "@woohaa3/photocraft-protocol";
import {readStyleGradientFrame,type StyleGradientFrame} from "./style-positioning.js";
import { decodeTextGeometry, type TextGeometry, type TextGeometryRequest } from "./text-geometry.js";
import { editorMetric, editorPhase, editorPreview, type EditorAssetPort } from "./ports.js";

/** 合成预览。 */
export type EditorPreview = { width: number; height: number; pixels: Uint8Array };
export type MoveHover={layer:number;frame:[number,number,number,number]};
/** 源像素区域，不接受目标层或缩放参数。 */
export type EditorPreviewRegion = { x: number; y: number; width: number; height: number };

/** wasm-bindgen 返回的资源对象；字段可能是原型 getter，不能直接展开传递。 */
type WasmResource<T> = T & { free?: () => void };

/** 一次冻结导出的成对产物。 */
export type EditorExportBundle = {
  revision: number;
  documentContentHash: string;
  canvasWidth: number;
  canvasHeight: number;
  project: Uint8Array;
  output: Uint8Array;
};

function readExportBundle(bundle:{revision:number;documentContentHash:string;canvasWidth:number;canvasHeight:number;project:Uint8Array;output:Uint8Array}):EditorExportBundle {
  if(!Number.isSafeInteger(bundle.revision)||bundle.revision<0)throw new Error("导出修订无效");
  if(!Number.isSafeInteger(bundle.canvasWidth)||!Number.isSafeInteger(bundle.canvasHeight)||bundle.canvasWidth<1||bundle.canvasHeight<1)throw new Error("导出尺寸无效");
  if(!(bundle.output instanceof Uint8Array)||!bundle.output.byteLength)throw new Error("导出字节为空");
  return {revision:bundle.revision,documentContentHash:bundle.documentContentHash,canvasWidth:bundle.canvasWidth,canvasHeight:bundle.canvasHeight,
    project:bundle.project instanceof Uint8Array?bundle.project:new Uint8Array(),output:bundle.output};
}

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
function decodePatternLibrary(raw:string):PatternLibraryState {
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

export type CloneSourceSlot = {
  index:number; source:[number,number]|null; anchor:[number,number]|null; offset:[number,number]|null;
  layer:number|null; width:number; height:number; linked:boolean; rotation:number; flipH:boolean; flipV:boolean;
};
export type CloneSourceOverlay = {show:boolean; opacity:number; clipped:boolean; autoHide:boolean; invert:boolean; blend:"normal"|"darken"|"lighten"|"difference"};
export type CloneSourceList = {active:number; sources:CloneSourceSlot[]; overlay:CloneSourceOverlay};

const finitePoint=(value:unknown):[number,number]|null=>Array.isArray(value)&&value.length===2&&value.every(item=>typeof item==="number"&&Number.isFinite(item))?[value[0],value[1]]:null;
function decodeCloneSourceSlot(value:unknown):CloneSourceSlot {
  const invalid=()=>{throw new Error("克隆源响应无效");};
  if(!value||typeof value!=="object")return invalid();
  const slot=value as Record<string,unknown>;
  const number=(key:string,min:number,max:number,fallback:number)=>{const raw=slot[key];if(raw===undefined)return fallback;if(typeof raw!=="number"||!Number.isFinite(raw)||raw<min||raw>max)return invalid();return raw;};
  return {index:number("index",0,4,0),
    source:slot.source===null||slot.source===undefined?null:finitePoint(slot.source)??invalid(),
    anchor:slot.anchor===null||slot.anchor===undefined?null:finitePoint(slot.anchor)??invalid(),
    offset:slot.offset===null||slot.offset===undefined?null:finitePoint(slot.offset)??invalid(),
    layer:slot.layer===null||slot.layer===undefined?null:typeof slot.layer==="number"?slot.layer:invalid(),
    width:number("width",1,1000,100), height:number("height",1,1000,100),
    linked:typeof slot.linked==="boolean"?slot.linked:false,
    rotation:number("rotation",-180,180,0),
    flipH:typeof slot.flipH==="boolean"?slot.flipH:false,
    flipV:typeof slot.flipV==="boolean"?slot.flipV:false};
}
function decodeCloneSourceOverlay(value:unknown):CloneSourceOverlay {
  const invalid=()=>{throw new Error("克隆源叠层响应无效");};
  if(!value||typeof value!=="object")return invalid();
  const overlay=value as Record<string,unknown>;
  if(!["normal","darken","lighten","difference"].includes(overlay.blend as string))return invalid();
  if(typeof overlay.opacity!=="number"||!Number.isFinite(overlay.opacity)||overlay.opacity<0||overlay.opacity>100)return invalid();
  return {show:typeof overlay.show==="boolean"?overlay.show:false, opacity:overlay.opacity,
    clipped:typeof overlay.clipped==="boolean"?overlay.clipped:false,
    autoHide:typeof overlay.autoHide==="boolean"?overlay.autoHide:false,
    invert:typeof overlay.invert==="boolean"?overlay.invert:false,
    blend:overlay.blend as CloneSourceOverlay["blend"]};
}
/** 严格解码原生 `cloneSource.list`：字段缺失或越界视为无效，不猜测默认值。 */
export function decodeCloneSourceList(value:unknown):CloneSourceList {
  const invalid=()=>{throw new Error("克隆源响应无效");};
  if(!value||typeof value!=="object")return invalid();
  const data=value as Record<string,unknown>;
  if(!Array.isArray(data.sources)||data.sources.length!==5)return invalid();
  if(typeof data.active!=="number"||!Number.isInteger(data.active)||data.active<0||data.active>4)return invalid();
  const sources=data.sources.map(entry=>decodeCloneSourceSlot(entry));
  if(sources.some((slot,index)=>slot.index!==index))return invalid();
  return {active:data.active, sources, overlay:decodeCloneSourceOverlay(data.overlay)};
}

export type EditorInstance = {
  patternLibrary():string;
  importPatternPresets(bytes:Uint8Array):string;
  renamePatternPreset(key:string,name:string):string;
  deletePatternPreset(key:string):string;
  exportPatternPresets(key?:string):Uint8Array;
  patternLibrarySnapshot():Uint8Array;
  restorePatternLibrary(bytes:Uint8Array):string;
  importContourPresets(bytes:Uint8Array):string;
  exportContourPreset(contourJson:string):Uint8Array;
  beginLayerProperties(layer:number):string;
  beginLayerVisibility?(layer:number):string;
  /** 图层重排的画布预览（I218）：候选只读，可选能力。 */
  beginReorderPreview?():string;
  previewReorder?(paramsJson:string):string;
  endReorderPreview?():string;
  stylePositionFrame(index:number):string;
  previewLayerProperties(paramsJson:string):string;
  commitLayerProperties():string;
  cancelLayerProperties():void;
  beginImageRotation?():string;
  previewImageRotation?(params:string):string;
  commitImageRotation?():string;
  cancelImageRotation?():void;
  clipboardBounds?():string;
  histogram?():string;
  pixelGrid?(params:string):string;
  infoReadout?(params:string):string;
  setPerformancePreferences?(historyStates:number,memoryUsageMb:number):string;
  setHistoryLimit?(limit:number):string;
  beginAdjustment(layer: number): string;
  previewAdjustment(paramsJson: string): string;
  commitAdjustment(): string;
  cancelAdjustment(): void;
  curveGeometry(pointsJson: string): string;
  moveHoverAt?(params:string):string;
  missingFonts?():string;
  beginText(paramsJson: string): string;
  previewText(paramsJson: string): string;
  textGeometry(paramsJson: string): string;
  checkpointText?(): string;
  commitText(): string;
  cancelText(): void;
  openImage(name: string, assetId: string, bytes: Uint8Array): string;
  openProject(bytes: Uint8Array, baseAssetId: string): string;
  placeImage(name: string, assetId: string, bytes: Uint8Array, paramsJson: string): string;
  saveProject(): Uint8Array;
  duplicateProject?(name:string):Uint8Array;
  renderPreview(maxSide: number): WasmResource<EditorPreview>;
  renderRegion(paramsJson: string): WasmResource<EditorPreview>;
  selectionContains?(x:number,y:number):boolean;
  sampleColor(x: number, y: number): string | undefined;
  sampleColorOptions?(params:string):string|undefined;
  fontPreview?(family:string,size:number,scale:number):WasmResource<EditorPreview>;
  layerThumbnail(layer: number, mask: boolean, maxSide: number): WasmResource<EditorPreview>;
  exportBundle(): WasmResource<EditorExportBundle>;
  /** 按导出格式与控制编码当前修订（I045）。 */
  exportImage?(paramsJson:string): WasmResource<EditorExportBundle>;
  /** 只读当前画笔（I132），不走命令分派。 */
  brushGet?():string;
  contentHash(): string;
  assetIdsJson(): string;
  commandsJson(): string;
  allowedCommandIdsJson(): string;
  stateJson(): string;
  beginStroke(paramsJson: string): void;
  appendStroke(paramsJson: string): void;
  takeStrokeDamage():string;
  commitStroke(): string;
  cancelStroke(): void;
  beginTransform(): void;
  beginSelectionTransform(): void;
  beginMove(paramsJson: string): boolean;
  previewTransform(matrixJson: string): void;
  commitTransform(): string;
  cancelTransform(): void;
  execute(id: string, paramsJson: string): string;
  undo(): string;
  redo(): string;
  hasDocument(): boolean;
  closeDocument(): string;
};

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
  private readonly instance: EditorInstance;
  readonly buildInfo: EditorBuildInfo;

  constructor(instance: EditorInstance, buildInfo: EditorBuildInfo) {
    this.instance = instance;
    this.buildInfo = buildInfo;
  }

  openImage(name: string, assetId: string, bytes: Uint8Array): EditorResult<unknown> {
    return editorPhase("image-editor.open-image", () => this.call((i) => i.openImage(name, assetId, bytes)));
  }

  openProject(bytes: Uint8Array, baseAssetId: string): EditorResult<unknown> {
    return editorPhase("image-editor.open-project", () => this.call((i) => i.openProject(bytes, baseAssetId)));
  }

  placeImage(name: string, assetId: string, bytes: Uint8Array, params: unknown = null): EditorResult<unknown> {
    return this.call((i) => i.placeImage(name, assetId, bytes, JSON.stringify(params ?? null)));
  }

  /** 序列化当前工程；返回 `.pcraft` 字节。 */
  saveProject(): EditorResult<Uint8Array> {
    return this.call((i) => i.saveProject());
  }

  canDuplicateProject():boolean {return typeof this.instance.duplicateProject==="function";}
  duplicateProject(name:string):EditorResult<Uint8Array> {
    if(!this.instance.duplicateProject)return {ok:false,code:"capability-disabled",message:"当前编辑器版本不支持复制文档，请更新运行组件"};
    return this.call(instance=>instance.duplicateProject!(name));
  }

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

  selectionContains(x:number,y:number):EditorResult<boolean> {
    return this.call(i=>{if(!i.selectionContains) throw new Error("请更新编辑内核以使用精确选区命中");return i.selectionContains(x,y);});
  }

  moveHoverAt(params:{x:number;y:number;target:"layer"|"group"}):EditorResult<MoveHover|null> {
    return this.call(i=>{if(!i.moveHoverAt)throw new Error("当前编辑内核未提供悬停目标，请重新加载编辑器");const value:unknown=JSON.parse(i.moveHoverAt(JSON.stringify(params)));if(value===null)return null;
      const candidate=value as MoveHover;if(!candidate||!Number.isSafeInteger(candidate.layer)||candidate.layer<=0||!Array.isArray(candidate.frame)||candidate.frame.length!==4||!candidate.frame.every(Number.isFinite)||candidate.frame[2]<=candidate.frame[0]||candidate.frame[3]<=candidate.frame[1])throw new Error("悬停目标信息无效");return candidate;});
  }
  /** 只读克隆源快照；面板据此显示五槽与叠层设置，不写文档。 */
  cloneSourceList():EditorResult<CloneSourceList> {
    return this.call(i=>decodeCloneSourceList(JSON.parse(i.execute("cloneSource.list",JSON.stringify(null)))));
  }
  cloneSourceSelect(index:number):EditorResult<CloneSourceSlot> {
    return this.call(i=>{const value:unknown=JSON.parse(i.execute("cloneSource.select",JSON.stringify({index})));return decodeCloneSourceSlot(value);});
  }
  cloneSourceSet(params:unknown):EditorResult<CloneSourceSlot> {
    return this.call(i=>{const value:unknown=JSON.parse(i.execute("cloneSource.set",JSON.stringify(params??null)));return decodeCloneSourceSlot(value);});
  }
  cloneSourceResetTransform(index:number):EditorResult<CloneSourceSlot> {
    return this.call(i=>{const value:unknown=JSON.parse(i.execute("cloneSource.resetTransform",JSON.stringify({index})));return decodeCloneSourceSlot(value);});
  }
  cloneSourceOverlay(params:unknown):EditorResult<CloneSourceOverlay> {
    return this.call(i=>{const value:unknown=JSON.parse(i.execute("cloneSource.overlay",JSON.stringify(params??null)));return decodeCloneSourceOverlay(value);});
  }
  fontPreview(family:string,size:number,scale:number):EditorResult<EditorPreview> {
    return this.call(i=>{
      if(!i.fontPreview)throw new Error("当前编辑内核未提供字体样例");
      const preview=i.fontPreview(family,size,scale);
      try{const {width,height,pixels}=preview;if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>888||height>212||!(pixels instanceof Uint8Array)||pixels.length!==width*height*4)throw new Error("字体样例数据无效");return {width,height,pixels};}finally{preview.free?.();}
    });
  }
  missingFonts():EditorResult<string[]> {
    return this.call(i=>{if(!i.missingFonts)throw new Error("当前编辑内核未提供缺失字体查询，请重新加载编辑器");const value:unknown=JSON.parse(i.missingFonts());if(!Array.isArray(value)||value.some(item=>typeof item!=="string"))throw new Error("缺失字体信息无效");return value as string[];});
  }
  sampleColor(x: number, y: number,options?:{size:number;sampleLayer:string}): EditorResult<string | null> {
    if(options && (options.size!==1 || options.sampleLayer!=="all"))return this.call(i=>{if(!i.sampleColorOptions)throw new Error("当前编辑内核未提供取样选项，请重新加载编辑器");return i.sampleColorOptions(JSON.stringify({x,y,...options}))??null;});
    return this.call((i) => i.sampleColor(x, y) ?? null);
  }

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

  layerThumbnail(layer: number, mask: boolean): EditorResult<EditorPreview> {
    return this.call((i) => {
      const preview=editorPhase("image-editor.thumbnail", () => i.layerThumbnail(layer,mask,64));
      try { return {width:preview.width,height:preview.height,pixels:preview.pixels}; }
      finally { preview.free?.(); }
    });
  }

  /** 冻结导出：同一修订的工程与 PNG。 */
  brushGet():EditorResult<unknown> {
    return this.call(i=>{if(!i.brushGet)throw new Error("当前编辑内核未提供只读画笔查询");return JSON.parse(i.brushGet());});
  }

  exportImage(params:unknown):EditorResult<EditorExportBundle> {
    return this.call(i=>{
      if(!i.exportImage)throw new Error("当前编辑内核未提供导出格式，请更新编辑内核");
      const bundle=i.exportImage(JSON.stringify(params));
      try{return readExportBundle(bundle);}finally{bundle.free?.();}
    });
  }

  exportBundle(): EditorResult<EditorExportBundle> {
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

  beginStroke(params: unknown): EditorResult<void> {
    return this.call((i) => i.beginStroke(JSON.stringify(params)));
  }

  beginImageRotation():EditorResult<unknown> {return this.call(i=>{if(!i.beginImageRotation)throw new Error("请更新编辑内核以预览画布旋转");return JSON.parse(i.beginImageRotation());});}
  previewImageRotation(params:unknown):EditorResult<unknown> {return this.call(i=>{if(!i.previewImageRotation)throw new Error("请更新编辑内核以预览画布旋转");return JSON.parse(i.previewImageRotation(JSON.stringify(params)));});}
  commitImageRotation():EditorResult<unknown> {return this.call(i=>{if(!i.commitImageRotation)throw new Error("请更新编辑内核以预览画布旋转");return JSON.parse(i.commitImageRotation());});}
  cancelImageRotation():EditorResult<void> {return this.call(i=>i.cancelImageRotation?.());}
  clipboardBounds():EditorResult<[number,number,number,number]|null> {return this.call(i=>{if(!i.clipboardBounds)throw new Error("请更新编辑内核以读取内部剪贴板位置");const bounds:unknown=JSON.parse(i.clipboardBounds());if(bounds===null)return null;if(!Array.isArray(bounds)||bounds.length!==4||bounds.some(n=>!Number.isSafeInteger(n))||bounds[2]<=bounds[0]||bounds[3]<=bounds[1])throw new Error("内部剪贴板边界无效");return bounds as [number,number,number,number];});}
  histogram():EditorResult<HistogramReadout> {return this.call(i=>{if(!i.histogram)throw new Error("请更新编辑内核以读取直方图");return decodeHistogram(JSON.parse(i.histogram()));});}
  pixelGrid(params:PixelGridRegion):EditorResult<PixelGridSegment[]> {return this.call(i=>{validatePixelGridRegion(params);if(!i.pixelGrid)throw new Error("请更新编辑内核以显示像素网格");return decodePixelGrid(JSON.parse(i.pixelGrid(JSON.stringify(params))),params);});}
  infoReadout(params:InfoRequest):EditorResult<InfoReadout> {return this.call(i=>{if(!(params.x===null&&params.y===null)&&!(typeof params.x==="number"&&Number.isFinite(params.x)&&typeof params.y==="number"&&Number.isFinite(params.y)))throw new Error("信息取样坐标无效");if(!Number.isSafeInteger(params.size)||![1,3,5,11,31,51,101].includes(params.size))throw new Error("信息取样尺寸无效");if(!i.infoReadout)throw new Error("请更新编辑内核以读取信息面板");return decodeInfoReadout(JSON.parse(i.infoReadout(JSON.stringify(params))));});}
  setPerformancePreferences(historyStates:number,memoryUsageMb:number):EditorResult<unknown> {return this.call(i=>{
    if(!Number.isInteger(historyStates)||historyStates<1||historyStates>1000||!Number.isInteger(memoryUsageMb)||memoryUsageMb<256||memoryUsageMb>1048576)throw new Error("无效的历史状态数量或内存预算");
    if(i.setPerformancePreferences)return JSON.parse(i.setPerformancePreferences(historyStates,memoryUsageMb));
    if(memoryUsageMb!==8192)throw new Error("请更新编辑内核以设置内存预算");
    if(i.setHistoryLimit)return JSON.parse(i.setHistoryLimit(historyStates));
    if(historyStates===50)return {historyStates,memoryUsageMb};
    throw new Error("请更新编辑内核以设置性能偏好");
  });}
  setHistoryLimit(limit:number):EditorResult<unknown> {return this.call(i=>{
    if(!Number.isInteger(limit) || limit<1 || limit>1000)throw new Error("历史状态数量须为 1–1000 的整数");
    if(!i.setHistoryLimit){if(limit===50)return {historyStates:50};throw new Error("请更新编辑内核以设置历史状态数量");}
    return JSON.parse(i.setHistoryLimit(limit));
  });}
  beginAdjustment(layer: number): EditorResult<unknown> { return this.call((i)=>JSON.parse(i.beginAdjustment(layer))); }
  patternLibrary():EditorResult<PatternLibraryState> {return this.call(i=>decodePatternLibrary(i.patternLibrary()));}
  importPatternPresets(bytes:Uint8Array):EditorResult<PatternLibraryState> {return this.call(i=>{
    if(bytes.length>MAX_PATTERN_FILE_BYTES) throw new Error("PAT 文件不能超过 32 MiB");
    return decodePatternLibrary(i.importPatternPresets(bytes));
  });}
  renamePatternPreset(key:string,name:string):EditorResult<PatternLibraryState> {return this.call(i=>decodePatternLibrary(i.renamePatternPreset(key,name)));}
  deletePatternPreset(key:string):EditorResult<PatternLibraryState> {return this.call(i=>decodePatternLibrary(i.deletePatternPreset(key)));}
  exportPatternPresets(key?:string):EditorResult<Uint8Array> {return this.call(i=>i.exportPatternPresets(key));}
  patternLibrarySnapshot():EditorResult<Uint8Array> {return this.call(i=>i.patternLibrarySnapshot());}
  restorePatternLibrary(bytes:Uint8Array):EditorResult<PatternLibraryState> {return this.call(i=>{
    if(bytes.length>MAX_PATTERN_FILE_BYTES) throw new Error("本机图案库快照不能超过 32 MiB");
    return decodePatternLibrary(i.restorePatternLibrary(bytes));
  });}
  importContourPresets(bytes:Uint8Array):EditorResult<ContourPreset[]> {
    return this.call(i=>{
      const value:unknown=JSON.parse(i.importContourPresets(bytes));
      if(!Array.isArray(value) || value.length>64 || !value.every(preset=>preset && typeof preset==="object" && typeof preset.name==="string" && preset.name.length<=200 && "contour" in preset)) throw new Error("等高线预设响应无效");
      return value as ContourPreset[];
    });
  }
  exportContourPreset(contour:unknown):EditorResult<Uint8Array> {return this.call(i=>i.exportContourPreset(JSON.stringify(contour)));}
  beginLayerProperties(layer:number):EditorResult<unknown> {return this.call(i=>JSON.parse(i.beginLayerProperties(layer)));}
  beginLayerVisibility(layer:number):EditorResult<unknown> {
    return this.call(i=>{if(!i.beginLayerVisibility) throw new Error("当前内核未提供可取消显隐扫动，请更新编辑内核");return JSON.parse(i.beginLayerVisibility(layer));});
  }
  previewLayerProperties(params:unknown):EditorResult<unknown> {return this.call(i=>JSON.parse(i.previewLayerProperties(JSON.stringify(params))));}
  beginReorderPreview():EditorResult<unknown> {
    return this.call(i=>{if(!i.beginReorderPreview) throw new Error("当前内核未提供图层重排预览，请更新编辑内核");return JSON.parse(i.beginReorderPreview());});
  }
  previewReorder(params:unknown):EditorResult<unknown> {
    return this.call(i=>{if(!i.previewReorder) throw new Error("当前内核未提供图层重排预览，请更新编辑内核");return JSON.parse(i.previewReorder(JSON.stringify(params)));});
  }
  endReorderPreview():EditorResult<boolean> {
    return this.call(i=>{if(!i.endReorderPreview) return false;const value:unknown=JSON.parse(i.endReorderPreview());return !!(value&&typeof value==="object"&&(value as {active?:unknown}).active===true);});
  }
  stylePositionFrame(index:number):EditorResult<StyleGradientFrame> {
    return this.call(i=>{
      if(!Number.isInteger(index) || index<0 || index>=64) throw new Error("定位效果索引无效");
      const frame=readStyleGradientFrame(JSON.parse(i.stylePositionFrame(index)));
      if(!frame) throw new Error("原生样式定位帧无效");return frame;
    });
  }
  commitLayerProperties():EditorResult<unknown> {return this.call(i=>JSON.parse(i.commitLayerProperties()));}
  cancelLayerProperties():EditorResult<void> {return this.call(i=>i.cancelLayerProperties());}
  previewAdjustment(params: unknown): EditorResult<unknown> { return this.call((i)=>JSON.parse(i.previewAdjustment(JSON.stringify(params)))); }
  commitAdjustment(): EditorResult<unknown> { return this.call((i)=>JSON.parse(i.commitAdjustment())); }
  cancelAdjustment(): EditorResult<void> { return this.call((i)=>i.cancelAdjustment()); }
  curveGeometry(points: readonly [number,number][]): EditorResult<number[]> {
    return this.call((i)=>{
      const samples:unknown=JSON.parse(i.curveGeometry(JSON.stringify(points)));
      if (!Array.isArray(samples) || samples.length!==256 || !samples.every(v=>typeof v==="number" && Number.isFinite(v) && v>=0 && v<=255)) throw new Error("曲线几何无效");
      return samples as number[];
    });
  }

  beginText(params: unknown): EditorResult<unknown> { return this.call((i)=>JSON.parse(i.beginText(JSON.stringify(params)))); }
  previewText(params: unknown): EditorResult<unknown> { return this.call((i)=>JSON.parse(i.previewText(JSON.stringify(params)))); }
  textGeometry(params: TextGeometryRequest): EditorResult<TextGeometry> {
    return this.call((i) => decodeTextGeometry(JSON.parse(i.textGeometry(JSON.stringify(params)))));
  }
  checkpointText(): EditorResult<unknown> {
    return this.call(i=>{if(!i.checkpointText) throw new Error("请更新编辑内核以在文字编辑期间保存");return JSON.parse(i.checkpointText());});
  }

  commitText(): EditorResult<unknown> { return this.call((i)=>JSON.parse(i.commitText())); }
  cancelText(): EditorResult<void> { return this.call((i)=>i.cancelText()); }

  beginMove(params: { x: number; y: number; autoSelect: boolean; duplicate: boolean; wholeLayer?: boolean; selectedPixels?: boolean }): EditorResult<boolean> { return this.call((i) => i.beginMove(JSON.stringify(params))); }

  beginTransform(selectionOnly = false): EditorResult<void> { return this.call((i) => selectionOnly ? i.beginSelectionTransform() : i.beginTransform()); }
  previewTransform(matrix: readonly number[]): EditorResult<void> { return this.call((i) => i.previewTransform(JSON.stringify(matrix))); }
  commitTransform(): EditorResult<unknown> { return this.call((i) => i.commitTransform()); }
  cancelTransform(): EditorResult<void> { return this.call((i) => i.cancelTransform()); }

  appendStroke(points: unknown): EditorResult<void> {
    return this.call((i) => i.appendStroke(JSON.stringify({ points })));
  }

  takeStrokeDamage():EditorResult<EditorPreviewRegion[]> {
    return this.call(i=>{
      const regions:unknown=JSON.parse(i.takeStrokeDamage());
      if(!Array.isArray(regions) || regions.length>1 || !regions.every(r=>r&&typeof r==="object"&&
        [r.x,r.y,r.width,r.height].every(Number.isSafeInteger)&&r.x>=0&&r.y>=0&&r.width>0&&r.height>0&&r.x+r.width<=32768&&r.y+r.height<=32768))throw new Error("笔迹改动范围无效");
      return regions as EditorPreviewRegion[];
    });
  }

  commitStroke(): EditorResult<unknown> {
    return this.call((i) => i.commitStroke());
  }

  cancelStroke(): EditorResult<void> {
    return this.call((i) => i.cancelStroke());
  }

  undo(): EditorResult<unknown> {
    return this.call((i) => i.undo());
  }

  redo(): EditorResult<unknown> {
    return this.call((i) => i.redo());
  }

  hasDocument(): boolean {
    return this.instance.hasDocument();
  }

  closeDocument(): EditorResult<unknown> {
    return editorPhase("image-editor.close-document", () => this.call((i) => JSON.parse(i.closeDocument())));
  }

  /** 统一捕获内核错误：内核抛 `{code,message}` 字符串。 */
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
    return { ok: true, value: new EditorHandle(instance, buildInfo) };
  } catch (error) {
    return failureFrom(error, "editor-load-failed", "无法加载图像编辑内核");
  }
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
