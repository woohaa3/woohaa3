import {decodeTextAntialias,type TextAntialias} from "./text-antialias.js";
import {decodePaintingSymmetry,type PaintingSymmetry} from "./painting-symmetry.js";
/**
 * 编辑内核状态 → React 视图模型
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 3.2/3.4 / design D2/D3）。
 *
 * 纯函数、无 DOM：把内核 `stateJson()` 与 `commandsJson()` 的有界结果折叠成界面直接可渲染的形状。
 * 不复制文档模型——每次操作后重新从内核取状态，React 只持有上一次的视图模型。
 */
import { decodePhotocraftCommands, type PhotocraftCommand } from "@woohaa3/photocraft-protocol";

/** 图层面板里的一行（已按显示顺序展开，含层级深度）。 */
export type EditorLayerRow = {
  bounds?:[number,number,number,number]|null;
  id: number;
  name: string;
  /** 内核图层种类（`raster`、`group`、`text`、`adjustment`…）。 */
  kind: string;
  visible: boolean;
  opacity: number;
  fill: number;
  blend: string;
  clipped: boolean;
  hasMask: boolean;
  hasEffects: boolean;
  maskEnabled: boolean;
  maskLinked: boolean;
  maskDensity?: number;
  maskFeather?: number;
  selected: boolean;
  locks: EditorLayerLocks;
  effectiveLocks: EditorLayerLocks;
  /** 是否活动图层（当前工具目标的图层）。 */
  active: boolean;
  /** 分组层级（顶层为 0）；面板用它缩进。 */
  depth: number;
  parentId: number | null;
  expanded: boolean;
  /** 内核判断的背景层；不由名称或锁定状态猜测。 */
  background?: boolean;
  labelColor?:string;
  linkGroup?:number|null;
  /** 文字层的内容（用于显示与编辑）。 */
  text: string | null;
  /** 调整层类型（用于显示与参数编辑）。 */
  adjustment: string | null;
  adjustmentParams: Record<string, unknown> | null;
  textStyle: EditorTextStyle | null;
};

export type EditorLayerLocks = Record<"transparency" | "pixels" | "position" | "artboard" | "all", boolean>;

function decodeLocks(value:unknown):EditorLayerLocks {
  const locks=isRecord(value) ? value : {};
  return {transparency:locks.transparency===true,pixels:locks.pixels===true,position:locks.position===true,artboard:locks.artboard===true,all:locks.all===true};
}

/**
 * 文字草稿的字符/段落样式（I114/I127）。
 *
 * 与原生 `CharStyle`/`ParagraphStyle` 同名同单位：`tracking` 为 1/1000 em、`leading` 与
 * `baselineShift` 为 pt、缩放为百分比。未设置表示沿用原生当前值，不写默认值覆盖。
 */
export type EditorTextStyleDetail = {
  tracking?: number;
  leading?: number;
  baselineShift?: number;
  horizontalScale?: number;
  verticalScale?: number;
  weight?: number;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fauxItalic?: boolean;
  ligatures?: boolean;
  discretionaryLigatures?: boolean;
  kerning?: "metrics" | "optical" | "off";
  firstLineIndent?: number;
  startIndent?: number;
  endIndent?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  hyphenate?: boolean;
};

export type EditorTextStyle = { orientation?:"horizontal"|"vertical"; antialias?:TextAntialias; text: string; font: "Noto Sans SC" | "Inter"; size: number; color: string; bold: boolean; align: "left" | "center" | "right"; style?: EditorTextStyleDetail };

/** 文档像素坐标中的选区边界线段。 */
export type SelectionSegment = [number, number, number, number];

/** 内核文档的界面视图。 */
export type EditorDocumentView = {
  documentKey?:string;
  paintingSymmetry?:PaintingSymmetry|null;
  /** 参考线与标尺原点（I096）：原生文档视图状态，不参与内容指纹。 */
  guides?:{horizontal?:unknown[];vertical?:unknown[];colors?:unknown[]};
  rulerOrigin?:[number,number];
  statusMetadata?:{flatBytes:number;layeredBytes:number;profile:string}|null;
  symmetryPaths?:string[];
  isolatedLayerIds?:number[];
  nextLayerName?:string;
  name: string;
  width: number;
  height: number;
  resolutionDpi?:number;
  mode: string;
  depthBits: number;
  activeLayerId: number | null;
  selectedLayerIds: number[];
  hasSelection: boolean;
  /** 文档是否处于 Quick Mask 编辑模式（I085）。 */
  quickMask?: boolean;
  editTarget: "pixels" | "mask";
  maskView: number | null;
  /** 活动层的蒙版是否以红色叠加显示（I220）。 */
  maskOverlay?: number | null;
  layerTransformFrame?:[number,number,number,number]|null;
  transformFrame: [number, number, number, number] | null;
  selectionOutline: SelectionSegment[];
  selectionFrame: [number, number, number, number] | null;
  canUndo: boolean;
  canRedo: boolean;
  revision: number;
  /** 撤销栈标签（最旧→当前）。 */
  historyFollowKey?:string;
  history: string[];
  /** 可重做的步骤，下一步在前；只读自内核，不缓存文档。 */
  redoHistory: string[];
  historySnapshots?:{id:number;name:string}[];
  /** 显示顺序：顶层在前，随后是它的子层。 */
  layers: EditorLayerRow[];
};

/** 一次刷新后的完整视图模型。 */
export type EditorViewModel = {
  hasDocument: boolean;
  document: EditorDocumentView | null;
  /** 内核自报的当前文档名（无文档时为 null）。 */
  sessionActiveIndex: number | null;
};

/**
 * 解析内核 `stateJson()`。
 *
 * 结构非法时返回 null（调用方显示「无法读取编辑状态」而不是渲染半截界面）。
 */
export function decodeEditorState(input: unknown): EditorViewModel | null {
  if (!isRecord(input)) return null;
  const session = input.session;
  const document = input.document;
  const sessionActiveIndex = isRecord(session) && typeof session.active === "number" ? session.active : null;
  if (document === null || document === undefined) {
    return { hasDocument: false, document: null, sessionActiveIndex };
  }
  if (!isRecord(document)) return null;
  const view = decodeDocument(document);
  if (!view) return null;
  return { hasDocument: true, document: view, sessionActiveIndex };
}

function decodeDocument(document: Record<string, unknown>): EditorDocumentView | null {
  const width = positiveInt(document.width);
  const height = positiveInt(document.height);
  if (width === null || height === null) return null;
  const activeLayerId = typeof document.activeLayer === "number" ? document.activeLayer : null;
  const selectedLayerIds = Array.isArray(document.selectedLayers)
    ? document.selectedLayers.filter((id): id is number => typeof id === "number")
    : [];
  const rawLayers = Array.isArray(document.layers) ? document.layers : [];
  const layers: EditorLayerRow[] = [];
  for (const raw of rawLayers) {
    flattenLayer(raw, 0, activeLayerId, selectedLayerIds, layers, null);
  }
  const active = layers.find((layer) => layer.active);
  if (active?.text !== null && active && isRecord(document.activeTextStyle)) {
    active.textStyle = decodeEditorTextStyle(active.text ?? "", document.activeTextStyle);
  }
  return {
    isolatedLayerIds:Array.isArray(document.isolatedLayers)?document.isolatedLayers.filter((id):id is number=>typeof id==="number" && Number.isSafeInteger(id)):[],
    statusMetadata:isRecord(document.statusMetadata) && [document.statusMetadata.flatBytes,document.statusMetadata.layeredBytes].every(v=>typeof v==="number" && Number.isSafeInteger(v) && v>=0) && typeof document.statusMetadata.profile==="string"?document.statusMetadata as {flatBytes:number;layeredBytes:number;profile:string}:null,
    paintingSymmetry:decodePaintingSymmetry(document.paintingSymmetry),
    ...(isRecord(document.guides)?{guides:document.guides as {horizontal?:unknown[];vertical?:unknown[];colors?:unknown[]}}:{}),
    ...(Array.isArray(document.rulerOrigin)&&document.rulerOrigin.length===2&&document.rulerOrigin.every(n=>typeof n==="number"&&Number.isFinite(n))?{rulerOrigin:document.rulerOrigin as [number,number]}:{}),
    symmetryPaths:Array.isArray(document.symmetryPaths)?document.symmetryPaths.filter((p):p is string=>typeof p==="string"):[],
    nextLayerName:typeof document.nextLayerName==="string" ? document.nextLayerName : undefined,
    name: typeof document.name === "string" ? document.name : "",
    width,
    height,
    resolutionDpi:typeof document.resolution==="number" && Number.isFinite(document.resolution) && document.resolution>=1 && document.resolution<=10000?document.resolution:72,
    mode: typeof document.mode === "string" ? document.mode : "",
    depthBits: typeof document.depth === "number" ? document.depth : 8,
    ...(typeof document.documentKey==="string"?{documentKey:document.documentKey}:{}),
    activeLayerId,
    selectedLayerIds,
    hasSelection: document.hasSelection === true,
    // Quick Mask 是文档视图+像素目标状态（I085）：只有文档确实处于该模式时才报告。
    quickMask: document.quickMask === true,
    editTarget: document.editTarget === "mask" && active?.hasMask ? "mask" : "pixels",
    maskView: isRecord(document.layerMaskView) && document.layerMaskView.mode === "gray" && document.layerMaskView.layer === activeLayerId && active?.hasMask ? activeLayerId : null,
    // 遮罩叠加（红宝石色）是视图状态；只有活动层确有蒙版时才报告。
    maskOverlay: isRecord(document.layerMaskView) && document.layerMaskView.mode === "overlay" && document.layerMaskView.layer === activeLayerId && active?.hasMask ? activeLayerId : null,
    layerTransformFrame: Array.isArray(document.layerTransformFrame) && document.layerTransformFrame.length===4 && document.layerTransformFrame.every(n=>typeof n==="number" && Number.isFinite(n)) && document.layerTransformFrame[2]>document.layerTransformFrame[0] && document.layerTransformFrame[3]>document.layerTransformFrame[1]
      ? document.layerTransformFrame as [number,number,number,number] : null,
    transformFrame: Array.isArray(document.transformFrame) && document.transformFrame.length === 4
      && document.transformFrame.every((v) => typeof v === "number" && Number.isFinite(v))
      && document.transformFrame[2] > document.transformFrame[0] && document.transformFrame[3] > document.transformFrame[1]
      ? document.transformFrame as [number, number, number, number] : null,
    selectionFrame: Array.isArray(document.selectionFrame) && document.selectionFrame.length === 4
      && document.selectionFrame.every((v) => typeof v === "number" && Number.isFinite(v))
      && document.selectionFrame[2] > document.selectionFrame[0] && document.selectionFrame[3] > document.selectionFrame[1]
      ? document.selectionFrame as [number, number, number, number] : null,
    selectionOutline: document.hasSelection === true ? decodeSelectionOutline(document.selectionOutline) : [],
    canUndo: document.canUndo === true,
    canRedo: document.canRedo === true,
    revision: typeof document.revision === "number" ? document.revision : 0,
    historyFollowKey:typeof document.historyFollowKey==="string"?document.historyFollowKey:undefined,
    history: Array.isArray(document.history) ? document.history.filter((h): h is string => typeof h === "string") : [],
    redoHistory: Array.isArray(document.redoHistory) ? document.redoHistory.filter((h): h is string => typeof h === "string") : [],
    historySnapshots:Array.isArray(document.historySnapshots)?document.historySnapshots.filter((item):item is {id:number;name:string}=>!!item && typeof item==="object" && Number.isSafeInteger(item.id) && item.id>0 && typeof item.name==="string" && item.name.length>0):[],
    layers
  };
}

function decodeSelectionOutline(input: unknown): SelectionSegment[] {
  if (!Array.isArray(input)) return [];
  return input.filter((segment): segment is SelectionSegment =>
    Array.isArray(segment) && segment.length === 4 && segment.every((value) => typeof value === "number" && Number.isFinite(value))
  );
}

function flattenLayer(
  raw: unknown,
  depth: number,
  activeLayerId: number | null,
  selectedLayerIds: number[],
  out: EditorLayerRow[],
  parentId: number | null
): void {
  if (!isRecord(raw)) return;
  const id = typeof raw.id === "number" ? raw.id : null;
  if (id === null) return;
  const text = isRecord(raw.text) && typeof raw.text.text === "string" ? raw.text.text : null;
  const adjustment = isRecord(raw.adjustment) && typeof raw.adjustment.kind === "string" ? raw.adjustment.kind : null;
  out.push({
    id,
    name: typeof raw.name === "string" ? raw.name : "",
    kind: decodeLayerKind(raw.kind),
    visible: raw.visible !== false,
    opacity: typeof raw.opacity === "number" ? raw.opacity : 1,
    fill: typeof raw.fill === "number" ? raw.fill : 1,
    blend: typeof raw.blend === "string" ? raw.blend : "Normal",
    clipped: raw.clipped === true,
    hasMask: raw.hasMask === true,
    hasEffects: isRecord(raw.effects) && Array.isArray(raw.effects.items) && raw.effects.items.length>0,
    maskEnabled: raw.maskEnabled !== false,
    maskLinked: raw.maskLinked !== false,
    maskDensity: typeof raw.maskDensity==="number"?raw.maskDensity:1,
    maskFeather: typeof raw.maskFeather==="number"?raw.maskFeather:0,
    selected: selectedLayerIds.includes(id),
    locks: decodeLocks(raw.locks),
    effectiveLocks: decodeLocks(raw.effectiveLocks ?? raw.locks),
    active: activeLayerId === id,
    depth,
    parentId,
    expanded: raw.expanded !== false,
    background: raw.background === true,
    labelColor:typeof raw.labelColor==="string" ? raw.labelColor : "none",
    linkGroup:typeof raw.linkGroup==="number" ? raw.linkGroup : null,
    text,
    adjustment,
    adjustmentParams: isRecord(raw.adjustment) && isRecord(raw.adjustment.params) ? raw.adjustment.params : null,
    bounds:Array.isArray(raw.bounds) && raw.bounds.length===4 && raw.bounds.every(n=>typeof n==="number" && Number.isFinite(n)) && raw.bounds[2]>0 && raw.bounds[3]>0 ? raw.bounds as [number,number,number,number] : null,
    textStyle: null
  });
  if (Array.isArray(raw.children)) {
    for (const child of raw.children) flattenLayer(child, depth + 1, activeLayerId, selectedLayerIds, out, id);
  }
}

/** inspect 使用显示名称；在入口统一为界面种类，避免各控件分别猜测。 */
function decodeLayerKind(value: unknown): string {
  if (typeof value !== "string") return "raster";
  const kind = value.trim().toLowerCase();
  if (kind === "pixel") return "raster";
  if (kind === "type") return "text";
  if (kind === "smart object") return "smart";
  return kind;
}

/** Photoshop 普通图层混合模式，按菜单顺序排列。 */
export const PHOTOSHOP_BLENDS = ["Normal", "Dissolve", "Darken", "Multiply", "Color Burn", "Linear Burn", "Darker Color", "Lighten", "Screen", "Color Dodge", "Linear Dodge (Add)", "Lighter Color", "Overlay", "Soft Light", "Hard Light", "Vivid Light", "Linear Light", "Pin Light", "Hard Mix", "Difference", "Exclusion", "Subtract", "Divide", "Hue", "Saturation", "Color", "Luminosity"] as const;

/** 首期允许的混合模式（与 spec 的图层合成要求一致）。 */
export const FIRST_PHASE_BLENDS = ["Normal", "Multiply", "Screen"] as const;

/** 混合模式标签是否属于首期清单（大小写不敏感，内核标签可能本地化）。 */
export function isFirstPhaseBlend(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return FIRST_PHASE_BLENDS.some((blend) => blend.toLowerCase() === normalized);
}

/** Capability index also retains commands used by panels and tools without a native menu path.
 * Visible menus are explicitly projected by photo-editor-menu, never from this entire index. */
export function isRenderableCommand(command: PhotocraftCommand): boolean {
  return command.allowed;
}

/**
 * 从命令注册表里选出可渲染项并按 id 建索引。
 *
 * 结构非法时返回空表（UI 显示无可用工具，而不是渲染部分错误项）。
 */
export function indexRenderableCommands(input: unknown): Map<string, PhotocraftCommand> {
  const decoded = decodePhotocraftCommands(input);
  const index = new Map<string, PhotocraftCommand>();
  if (!decoded.ok) return index;
  for (const command of decoded.commands) {
    if (isRenderableCommand(command)) index.set(command.id, command);
  }
  return index;
}

/** 参数说明解析：内核 `params` 是 JSON-ish 文本，取第一行做工具提示。 */
export function commandTooltip(command: PhotocraftCommand): string {
  const firstLine = command.params.split("\n")[0]?.trim() ?? "";
  if (!firstLine) return command.disabledReason ?? command.label;
  return `${command.label} — ${firstLine}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** 正式状态和活动文字草稿使用相同的样式投影。 */
export function decodeEditorTextStyle(text: string, value: unknown): EditorTextStyle | null {
  if (!isRecord(value)) return null;
  const character = value.character, paragraph = value.paragraph;
  if (!isRecord(character)) return null;
  const color = character.color;
  const channel = (value: unknown) => Math.round(Math.min(1, Math.max(0, typeof value === "number" ? value : 0)) * 255).toString(16).padStart(2, "0");
  const align = isRecord(paragraph) && typeof paragraph.align === "string" ? paragraph.align.toLowerCase() : "left";
  return { ...(value.orientation==="horizontal" || value.orientation==="vertical"?{orientation:value.orientation}:{}),...(decodeTextAntialias(value.antialias)?{antialias:decodeTextAntialias(value.antialias)}:{}),text, font: character.font_family === "Inter" ? "Inter" : "Noto Sans SC",
    size: typeof character.size_pt === "number" ? character.size_pt : 48,
    color: isRecord(color) && Array.isArray(color.c) ? `#${channel(color.c[0])}${channel(color.c[1])}${channel(color.c[2])}` : "#000000",
    bold: character.faux_bold === true || (typeof character.weight === "number" && character.weight >= 600),
    align: align === "center" || align === "right" ? align : "left",
    ...(decodeTextStyleDetail(character, paragraph)?{style:decodeTextStyleDetail(character, paragraph)!}:{}) };
}

const finiteNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
/** 原生 1.0 = 100%；界面按百分比显示，保留两位小数以免出现二进制浮点尾数。 */
const percentOf = (value: unknown): number | undefined => finiteNumber(value) === undefined ? undefined : Math.round((value as number) * 10000) / 100;
const optionalBoolean = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : undefined;

/** 原生 `character`/`paragraph` 投影到界面可编辑字段；缺省字段保持 undefined。 */
export function decodeTextStyleDetail(character: unknown, paragraph: unknown): EditorTextStyleDetail | null {
  if (!isRecord(character)) return null;
  const run = isRecord(paragraph) ? paragraph : {};
  const detail: EditorTextStyleDetail = {
    tracking: finiteNumber(character.tracking),
    leading: finiteNumber(character.leading_pt),
    baselineShift: finiteNumber(character.baseline_shift_pt),
    // 原生以 1.0 表示 100%，界面用百分比显示与输入（保留两位，避免浮点尾数）。
    horizontalScale: percentOf(character.horizontal_scale),
    verticalScale: percentOf(character.vertical_scale),
    weight: finiteNumber(character.weight),
    italic: optionalBoolean(character.italic),
    underline: optionalBoolean(character.underline),
    strikethrough: optionalBoolean(character.strikethrough),
    fauxItalic: optionalBoolean(character.faux_italic),
    ligatures: optionalBoolean(character.ligatures),
    discretionaryLigatures: optionalBoolean(character.discretionary_ligatures),
    ...(typeof character.kerning === "string" && ["metrics","optical","off"].includes(character.kerning) ? {kerning:character.kerning as EditorTextStyleDetail["kerning"]} : {}),
    firstLineIndent: finiteNumber(run.first_line_indent_pt),
    startIndent: finiteNumber(run.start_indent_pt),
    endIndent: finiteNumber(run.end_indent_pt),
    spaceBefore: finiteNumber(run.space_before_pt),
    spaceAfter: finiteNumber(run.space_after_pt),
    hyphenate: optionalBoolean(run.hyphenate)
  };
  const cleaned: EditorTextStyleDetail = {};
  for (const [key, value] of Object.entries(detail)) if (value !== undefined) (cleaned as Record<string, unknown>)[key] = value;
  return Object.keys(cleaned).length ? cleaned : null;
}
