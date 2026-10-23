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
  /** 是否有矢量蒙版（像素蒙版与矢量蒙版可共存，`hasMask` 只表示像素蒙版）。 */
  hasVectorMask: boolean;
  hasEffects: boolean;
  maskEnabled: boolean;
  maskLinked: boolean;
  selected: boolean;
  locks: EditorLayerLocks;
  effectiveLocks: EditorLayerLocks;
  /** 是否活动图层（当前工具目标的图层）。 */
  active: boolean;
  /** 分组层级（顶层为 0）；面板用它缩进。 */
  depth: number;
  parentId: number | null;
  expanded: boolean;
  /** 文字层的内容（用于显示与编辑）。 */
  text: string | null;
  /** 调整层类型（用于显示与参数编辑）。 */
  adjustment: string | null;
  adjustmentParams: Record<string, unknown> | null;
  textStyle: EditorTextStyle | null;
  /** 链接组 id（U58）：同组图层一起移动；`null` 表示未链接。 */
  linkGroup: number | null;
  /** 图层颜色标签 id（U58）：`none` 或 red/orange/…（与 `LabelColor` 同名）。 */
  labelColor: string;
  /** 高级混合开关与挖空（U60）：面板据此读回当前值，而不是用默认值覆盖。 */
  advancedBlending: {
    knockout: string;
    blendInterior: boolean;
    blendClipped: boolean;
    transparencyShapes: boolean;
    layerMaskHidesEffects: boolean;
    vectorMaskHidesEffects: boolean;
  };
  /** 逐通道混合开关（U60）：`null` 表示文档没有报（旧宿主）。 */
  channels: boolean[] | null;
  /** Blend If 端点（U60）：每项一个通道。 */
  blendIf: Array<{ channel: number; thisLayer: number[]; underlying: number[] }>;
};

export type EditorLayerLocks = Record<"transparency" | "pixels" | "position" | "artboard" | "all", boolean>;

function decodeLocks(value:unknown):EditorLayerLocks {
  const locks=isRecord(value) ? value : {};
  return {transparency:locks.transparency===true,pixels:locks.pixels===true,position:locks.position===true,artboard:locks.artboard===true,all:locks.all===true};
}

export type EditorTextStyle = { text: string; font: "Noto Sans SC" | "Inter"; size: number; color: string; bold: boolean; align: "left" | "center" | "right" };

/** 文档像素坐标中的选区边界线段。 */
export type SelectionSegment = [number, number, number, number];

/**
 * 通道目标：复合、单个 RGB 分量、Alpha/专色通道、图层蒙版。
 *
 * 内核 `channels.target` 的 `index` 只在 color/alpha 两类里有值；复合与图层蒙版没有。
 */
export type EditorChannelTarget =
  | { kind: "composite" }
  | { kind: "color"; index: number }
  | { kind: "alpha"; index: number }
  | { kind: "layerMask" };

/** 通道目标的目标编码（`color:0` / `alpha:1`）；复合与图层蒙版返回 null。 */
export function channelTargetCode(target: EditorChannelTarget): string | null {
  return target.kind === "color" || target.kind === "alpha" ? `${target.kind}:${target.index}` : null;
}

function decodeChannelTarget(value: unknown): EditorChannelTarget {
  if (!isRecord(value)) return { kind: "composite" };
  const index = typeof value.index === "number" && Number.isInteger(value.index) && value.index >= 0 ? value.index : null;
  if (value.kind === "color" && index !== null) return { kind: "color", index };
  if (value.kind === "alpha" && index !== null) return { kind: "alpha", index };
  if (value.kind === "layerMask") return { kind: "layerMask" };
  return { kind: "composite" };
}

/** 内核文档的界面视图。 */
export type EditorDocumentView = {
  name: string;
  width: number;
  height: number;
  mode: string;
  depthBits: number;
  activeLayerId: number | null;
  selectedLayerIds: number[];
  hasSelection: boolean;
  editTarget: "pixels" | "mask";
  /**
   * 通道面板当前查看/编辑目标（`stateJson().document.channels.target`）。
   *
   * 与 `editTarget` 分开：`editTarget` 只区分像素/图层蒙版，通道目标还要区分 RGB 分量与
   * Alpha/专色通道。像素命令据此选择落笔目标，主画布据此决定是否显示单通道灰度视图。
   */
  channelTarget: EditorChannelTarget;
  maskView: number | null;
  transformFrame: [number, number, number, number] | null;
  selectionOutline: SelectionSegment[];
  selectionFrame: [number, number, number, number] | null;
  canUndo: boolean;
  canRedo: boolean;
  revision: number;
  /** 撤销栈标签（最旧→当前）。 */
  history: string[];
  /** 可重做的步骤，下一步在前；只读自内核，不缓存文档。 */
  redoHistory: string[];
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
    name: typeof document.name === "string" ? document.name : "",
    width,
    height,
    mode: typeof document.mode === "string" ? document.mode : "",
    depthBits: typeof document.depth === "number" ? document.depth : 8,
    activeLayerId,
    selectedLayerIds,
    hasSelection: document.hasSelection === true,
    editTarget: document.editTarget === "mask" && active?.hasMask ? "mask" : "pixels",
    channelTarget: decodeChannelTarget(isRecord(document.channels) ? document.channels.target : null),
    maskView: isRecord(document.layerMaskView) && document.layerMaskView.mode === "gray" && document.layerMaskView.layer === activeLayerId && active?.hasMask ? activeLayerId : null,
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
    history: Array.isArray(document.history) ? document.history.filter((h): h is string => typeof h === "string") : [],
    redoHistory: Array.isArray(document.redoHistory) ? document.redoHistory.filter((h): h is string => typeof h === "string") : [],
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
    hasVectorMask: raw.hasVectorMask === true,
    hasEffects: isRecord(raw.effects) && Array.isArray(raw.effects.items) && raw.effects.items.length>0,
    maskEnabled: raw.maskEnabled !== false,
    maskLinked: raw.maskLinked !== false,
    selected: selectedLayerIds.includes(id),
    locks: decodeLocks(raw.locks),
    effectiveLocks: decodeLocks(raw.effectiveLocks ?? raw.locks),
    active: activeLayerId === id,
    depth,
    parentId,
    expanded: raw.expanded !== false,
    text,
    adjustment,
    adjustmentParams: isRecord(raw.adjustment) && isRecord(raw.adjustment.params) ? raw.adjustment.params : null,
    textStyle: null,
    linkGroup: typeof raw.linkGroup === "number" ? raw.linkGroup : null,
    labelColor: typeof raw.labelColor === "string" ? raw.labelColor : "none",
    advancedBlending: decodeAdvancedBlending(raw.advancedBlending),
    channels: Array.isArray(raw.channels) && raw.channels.every((value) => typeof value === "boolean") ? raw.channels as boolean[] : null,
    blendIf: decodeBlendIf(raw.blendIf)
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

/** 高级混合开关（U60）：缺字段时用上游默认值，避免面板把「没报」当成 false 去覆盖。 */
function decodeAdvancedBlending(value: unknown): EditorLayerRow["advancedBlending"] {
  const raw = isRecord(value) ? value : {};
  return {
    knockout: typeof raw.knockout === "string" ? raw.knockout : "none",
    blendInterior: raw.blendInterior === true,
    blendClipped: raw.blendClipped !== false,
    transparencyShapes: raw.transparencyShapes !== false,
    layerMaskHidesEffects: raw.layerMaskHidesEffects === true,
    vectorMaskHidesEffects: raw.vectorMaskHidesEffects === true,
  };
}

/** Blend If 端点（U60）：只接受完整的两项或四项数值端点。 */
function decodeBlendIf(value: unknown): EditorLayerRow["blendIf"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.channel !== "number") return [];
    const range = (input: unknown) => Array.isArray(input) && (input.length === 2 || input.length === 4)
      && input.every((point) => typeof point === "number" && Number.isFinite(point)) ? input as number[] : null;
    const thisLayer = range(entry.thisLayer);
    const underlying = range(entry.underlying);
    return thisLayer && underlying ? [{ channel: entry.channel, thisLayer, underlying }] : [];
  });
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

/** 命令是否可作为工具栏/菜单项渲染：首期白名单 + 引擎当前可用。 */
export function isRenderableCommand(command: PhotocraftCommand): boolean {
  return command.allowed && (command.menu.length > 0 || command.id === "edit.transform" || command.id === "layer.setExpanded");
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
  return { text, font: character.font_family === "Inter" ? "Inter" : "Noto Sans SC",
    size: typeof character.size_pt === "number" ? character.size_pt : 48,
    color: isRecord(color) && Array.isArray(color.c) ? `#${channel(color.c[0])}${channel(color.c[1])}${channel(color.c[2])}` : "#000000",
    bold: character.faux_bold === true || (typeof character.weight === "number" && character.weight >= 600),
    align: align === "center" || align === "right" ? align : "left" };
}
