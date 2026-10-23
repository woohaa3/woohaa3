/**
 * 通道面板的只读投影与参数编译（change: 2026-10-22-add-photocraft-channel-workflows，U25/U26）。
 *
 * 这里只有纯函数：把内核 `channelSnapshotJson()` 折成界面行，把表单折成命令参数。
 * 不复制通道模型——通道内容与元数据的权威始终是内核 `Document::channels`；
 * 目标/显隐是会话查看态（`channel_view`），不进内容身份。
 */
import { isRecord } from "../shared/panels.js";

/** 预览上限：面板内视图与计算候选都按这个单边缩放，不申请整幅画布。 */
export const CHANNEL_VIEW_MAX_SIDE = 192;
/** 面板行缩略图单边（与内核 `MAX_THUMBNAIL_SIDE` 同量级）。 */
export const CHANNEL_THUMBNAIL_MAX_SIDE = 28;

/** 可隔离预览（应用图像/计算）的命令；确认时用当前参数重跑一次。 */
export const CHANNEL_PREVIEW_COMMANDS = ["image.applyImage", "image.calculations"] as const;
export type ChannelPreviewCommand = (typeof CHANNEL_PREVIEW_COMMANDS)[number];

export function isChannelPreviewCommand(id: string): id is ChannelPreviewCommand {
  return (CHANNEL_PREVIEW_COMMANDS as readonly string[]).includes(id);
}

export type ChannelColorRow = { index: number; name: string; visible: boolean };

/** 专色通道的屏幕替代色与密度；不承诺印刷分色。 */
export type ChannelSpotView = { color: string; solidity: number };

export type ChannelAlphaRow = {
  index: number;
  name: string;
  visible: boolean;
  kind: "alpha" | "spot";
  /** 叠层显示色（例如快速蒙版的红色）。 */
  color: string;
  /** 叠层不透明度 0–100。 */
  opacity: number;
  /** 上游序列化为 `maskedAreas` / `selectedAreas`。 */
  indicates: "masked" | "selected";
  spot: ChannelSpotView | null;
};

export type ChannelDocumentRow = {
  index: number;
  name: string;
  width: number;
  height: number;
  grayscale: boolean;
  /** 与活动文档同尺寸；应用图像/计算/合并要求同尺寸。 */
  sameSize: boolean;
  active: boolean;
  /** 该文档的颜色分量名（RGB 三个 / Gray 一个），用于非活动来源的通道下拉。 */
  colorNames: string[];
  /** 该文档的 Alpha/专色行；只在来源下拉里展开，不渲染成活动文档的通道行。 */
  alpha: { index: number; name: string; kind: "alpha" | "spot" }[];
};

export type ChannelTargetKind = "composite" | "color" | "alpha" | "layerMask" | "vectorMask";

export type ChannelTargetView = { kind: ChannelTargetKind; index: number | null };

export type ChannelSnapshot = {
  /** 复合行名（RGB / CMYK / Lab / Gray）。 */
  composite: string;
  compositeVisible: boolean;
  colors: ChannelColorRow[];
  alpha: ChannelAlphaRow[];
  target: ChannelTargetView;
  documents: ChannelDocumentRow[];
  /** 快照所属文档；确认时核对，避免把预览写到别的文档。 */
  documentId: number;
  revision: number;
  maxOpenDocuments: number;
  spotCount: number;
  hasSelection: boolean;
  quickMask: boolean;
};

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 上游 `Color::to_rgb()` 的 0–1 浮点数组 → `#rrggbb`。 */
export function rgbHex(value: unknown, fallback = "#ff0000"): string {
  const channels = list(value);
  if (channels.length < 3) return fallback;
  const parts: string[] = [];
  for (const channel of channels.slice(0, 3)) {
    const number = finite(channel);
    if (number === null) return fallback;
    const byte = Math.round(Math.max(0, Math.min(1, number)) * 255);
    parts.push(byte.toString(16).padStart(2, "0"));
  }
  return `#${parts.join("")}`;
}

function decodeTarget(value: unknown): ChannelTargetView | null {
  if (!isRecord(value)) return null;
  const kind = text(value.kind);
  if (kind !== "composite" && kind !== "color" && kind !== "alpha" && kind !== "layerMask" && kind !== "vectorMask") return null;
  const index = finite(value.index);
  return { kind, index: index === null ? null : Math.trunc(index) };
}

function decodeColorRow(value: unknown): ChannelColorRow | null {
  if (!isRecord(value)) return null;
  const index = finite(value.index);
  const name = text(value.name);
  if (index === null || name === null || typeof value.visible !== "boolean") return null;
  return { index: Math.trunc(index), name, visible: value.visible };
}

function decodeAlphaRow(value: unknown): ChannelAlphaRow | null {
  if (!isRecord(value)) return null;
  const index = finite(value.index);
  const name = text(value.name);
  if (index === null || name === null || typeof value.visible !== "boolean") return null;
  const opacity = finite(value.opacity);
  const spot = isRecord(value.spot)
    ? { color: rgbHex(value.spot.color), solidity: Math.round((finite(value.spot.solidity) ?? 0) * 100) }
    : null;
  return {
    index: Math.trunc(index),
    name,
    visible: value.visible,
    kind: spot ? "spot" : "alpha",
    color: rgbHex(value.color),
    opacity: Math.round((opacity ?? 0.5) * 100),
    indicates: value.indicates === "selectedAreas" ? "selected" : "masked",
    spot
  };
}

function decodeDocumentRow(value: unknown): ChannelDocumentRow | null {
  if (!isRecord(value)) return null;
  const index = finite(value.index);
  const name = text(value.name);
  const width = finite(value.width);
  const height = finite(value.height);
  if (index === null || name === null || width === null || height === null) return null;
  const colorNames = list(value.colorNames).map((entry) => text(entry));
  // 旧内核不带来源通道清单：按灰度/彩色给出保守默认，不凭空造 Alpha 行。
  const fallbackColors = value.grayscale === true ? ["Gray"] : ["Red", "Green", "Blue"];
  const alpha: ChannelDocumentRow["alpha"] = [];
  for (const entry of list(value.alpha)) {
    if (!isRecord(entry)) continue;
    const alphaIndex = finite(entry.index);
    const alphaName = text(entry.name);
    if (alphaIndex === null || alphaName === null) continue;
    alpha.push({ index: Math.trunc(alphaIndex), name: alphaName, kind: entry.kind === "spot" ? "spot" : "alpha" });
  }
  return {
    index: Math.trunc(index),
    name,
    width: Math.trunc(width),
    height: Math.trunc(height),
    grayscale: value.grayscale === true,
    sameSize: value.sameSize === true,
    active: value.active === true,
    colorNames: colorNames.every((entry) => entry !== null) && colorNames.length > 0
      ? (colorNames as string[])
      : fallbackColors,
    alpha
  };
}

/**
 * 解码通道快照；结构非法返回 `null`（面板显示「无法读取通道」而不是半截行）。
 *
 * 上限：行数与同时打开文档数走内核已核对的预算，这里只拒绝明显越界的数据。
 */
export function decodeChannelSnapshot(input: unknown): ChannelSnapshot | null {
  if (!isRecord(input)) return null;
  const composite = text(input.composite);
  const documentId = finite(input.documentId);
  const revision = finite(input.revision);
  const target = decodeTarget(input.target);
  if (composite === null || documentId === null || revision === null || !target) return null;
  const colors: ChannelColorRow[] = [];
  for (const entry of list(input.colors)) {
    const row = decodeColorRow(entry);
    if (!row) return null;
    colors.push(row);
  }
  const alpha: ChannelAlphaRow[] = [];
  for (const entry of list(input.alpha)) {
    const row = decodeAlphaRow(entry);
    if (!row) return null;
    alpha.push(row);
  }
  if (alpha.length > 64 || colors.length > 4) return null;
  const documents: ChannelDocumentRow[] = [];
  for (const entry of list(input.documents)) {
    const row = decodeDocumentRow(entry);
    if (!row) return null;
    documents.push(row);
  }
  if (documents.length > 8) return null;
  return {
    composite,
    compositeVisible: input.compositeVisible === true,
    colors,
    alpha,
    target,
    documents,
    documentId: Math.trunc(documentId),
    revision: Math.trunc(revision),
    maxOpenDocuments: Math.trunc(finite(input.maxOpenDocuments) ?? 8),
    spotCount: Math.trunc(finite(input.spotCount) ?? alpha.filter((row) => row.kind === "spot").length),
    hasSelection: input.hasSelection === true,
    quickMask: isRecord(input.quickMask) || input.quickMask === true
  };
}

// ---------------------------------------------------------------------------------------------
// 通道引用编码

/**
 * 面板内部用字符串编码通道引用，避免每帧新建对象导致缩略图反复重取。
 *
 * 编码与内核 `parse_ref` 接受的形状一一对应：`composite`、`color:k`、`alpha:i`、
 * `mask`、`selection`、`transparency`、`quickMask`。
 */
export function channelReference(code: string): unknown | null {
  if (code === "composite" || code === "mask" || code === "selection" || code === "transparency" || code === "quickMask") {
    return code;
  }
  if (code.startsWith("color:")) {
    const index = Number(code.slice("color:".length));
    return Number.isInteger(index) && index >= 0 ? { color: index } : null;
  }
  if (code.startsWith("alpha:")) {
    const index = Number(code.slice("alpha:".length));
    return Number.isInteger(index) && index >= 0 ? { alpha: index } : null;
  }
  return null;
}

/** 内核引用 → 面板编码；未知形状返回 `null`（不猜）。 */
export function referenceCode(reference: unknown): string | null {
  if (typeof reference === "string") {
    return ["composite", "mask", "selection", "transparency", "quickMask"].includes(reference) ? reference : null;
  }
  if (isRecord(reference)) {
    const color = finite(reference.color);
    if (color !== null) return `color:${Math.trunc(color)}`;
    const alpha = finite(reference.alpha);
    if (alpha !== null) return `alpha:${Math.trunc(alpha)}`;
  }
  return null;
}

/** 当前编辑目标对应的行编码（复合/分量/Alpha）；蒙版目标没有面板行。 */
export function targetCode(snapshot: ChannelSnapshot): string | null {
  switch (snapshot.target.kind) {
    case "composite":
      return "composite";
    case "color":
      return snapshot.target.index === null ? "composite" : `color:${snapshot.target.index}`;
    case "alpha":
      return snapshot.target.index === null ? null : `alpha:${snapshot.target.index}`;
    default:
      return null;
  }
}

/** 目标通道可以「载入选区」的引用；蒙版目标需要共享栅格化端口，这里不猜。 */
export function targetSelectionReference(snapshot: ChannelSnapshot): unknown | null {
  const code = targetCode(snapshot);
  return code === null ? null : channelReference(code);
}

/** 面板可选来源通道：按所选文档自报的分量与 Alpha 行展开（含非活动文档）。 */
export function sourceChannelOptions(snapshot: ChannelSnapshot, documentIndex: number): { value: string; label: string }[] {
  const document = snapshot.documents.find((row) => row.index === documentIndex);
  const options = [{ value: "composite", label: document?.grayscale ? "Gray" : "合成通道" }];
  if (!document) return options;
  // 灰度文档的 `color:0` 就是合成通道本身，不重复给一行。
  if (!document.grayscale) {
    document.colorNames.forEach((name, index) => options.push({ value: `color:${index}`, label: name }));
  }
  options.push({ value: "transparency", label: "透明度" });
  for (const row of document.alpha) {
    options.push({ value: `alpha:${row.index}`, label: `${row.name}${row.kind === "spot" ? "（专色）" : ""}` });
  }
  return options;
}

/** 活动文档索引；蒙版来源不带 `document` 时上游按活动文档读取，面板因此对齐同一份清单。 */
export function activeDocumentIndex(snapshot: ChannelSnapshot): number {
  return snapshot.documents.find((row) => row.active)?.index ?? 0;
}

// ---------------------------------------------------------------------------------------------
// 参数编译（应用图像 / 计算）

export type SourceForm = {
  /** 来源文档索引（同时打开文档里的一项）。 */
  document: number;
  /** 图层 id、图层名；空表示合并图像。 */
  layer: string;
  /** `channelReference` 编码。 */
  channel: string;
  invert: boolean;
};

export type ApplyImageForm = {
  source: SourceForm;
  /** 空表示不加蒙版。 */
  maskChannel: string;
  blending: string;
  opacity: number;
  scale: number;
  offset: number;
  preserveTransparency: boolean;
  /**
   * `pixels` 或 `alpha:i`。
   *
   * 图层蒙版目标**不给**：内核 `image.applyImage` 只写图层像素，传 `"mask"` 会静默改像素，
   * 因此本域在 UI 与内核两侧都拒绝该目标（`applyImageParams` 不发、内核校验报错）。
   */
  target: string;
};

export type CalculationsForm = {
  source1: SourceForm;
  source2: SourceForm;
  maskChannel: string;
  blending: string;
  opacity: number;
  scale: number;
  offset: number;
  result: "newChannel" | "newDocument" | "selection";
  name: string;
};

/** 上游 `Blending::parse` 接受的分离型混合模式，外加上/减去。 */
export const BLENDINGS = [
  "normal",
  "darken",
  "multiply",
  "colorBurn",
  "linearBurn",
  "lighten",
  "screen",
  "colorDodge",
  "linearDodge",
  "overlay",
  "softLight",
  "hardLight",
  "difference",
  "exclusion",
  "add",
  "subtract"
] as const;

/** 只有上/减去使用 scale/offset；其他模式不发送，避免把默认值写成用户输入。 */
export function usesScaleOffset(blending: string): boolean {
  return blending === "add" || blending === "subtract";
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export function sourceParams(form: SourceForm): Record<string, unknown> {
  const document = Math.max(0, Math.trunc(Number.isFinite(form.document) ? form.document : 0));
  const params: Record<string, unknown> = { document };
  const layer = form.layer.trim();
  if (layer) layer_param(layer, params);
  const channel = channelReference(form.channel);
  if (channel !== null) params.channel = channel;
  if (form.invert) params.invert = true;
  return params;
}

function layer_param(layer: string, params: Record<string, unknown>): void {
  if (/^\d+$/.test(layer)) params.layer = Number(layer);
  else params.layer = layer;
}

function blendingParams(form: { blending: string; opacity: number; scale: number; offset: number }): Record<string, unknown> {
  const params: Record<string, unknown> = {
    blending: BLENDINGS.includes(form.blending as (typeof BLENDINGS)[number]) ? form.blending : "multiply",
    opacity: clamp(form.opacity, 0, 100, 100)
  };
  if (usesScaleOffset(form.blending)) {
    params.scale = clamp(form.scale, 1, 2, 1);
    params.offset = clamp(form.offset, -255, 255, 0);
  }
  return params;
}

export function applyImageParams(form: ApplyImageForm): Record<string, unknown> {
  const params = { source: sourceParams(form.source), ...blendingParams(form) };
  const mask = channelReference(form.maskChannel);
  if (mask !== null) (params as Record<string, unknown>).mask = { channel: mask };
  if (form.preserveTransparency) (params as Record<string, unknown>).preserveTransparency = true;
  // 图层蒙版目标内核不支持（只写像素），不发送；内核也会明确拒绝。
  if (form.target.startsWith("alpha:")) {
    const index = Number(form.target.slice("alpha:".length));
    if (Number.isInteger(index) && index >= 0) (params as Record<string, unknown>).target = { channel: index };
  }
  return params;
}

export function calculationsParams(form: CalculationsForm): Record<string, unknown> {
  const params: Record<string, unknown> = {
    source1: sourceParams(form.source1),
    source2: sourceParams(form.source2),
    result: form.result,
    ...blendingParams(form)
  };
  const mask = channelReference(form.maskChannel);
  if (mask !== null) params.mask = { channel: mask };
  const name = form.name.trim();
  if (name) params.name = name.slice(0, 200);
  return params;
}

export function defaultSourceForm(document = 0): SourceForm {
  return { document, layer: "", channel: "composite", invert: false };
}

/** 目标默认跟随当前通道目标：通道目标是 Alpha 时写回该通道，否则写图层像素。 */
export function defaultApplyImageForm(snapshot: ChannelSnapshot | null): ApplyImageForm {
  const active = snapshot ? activeDocumentIndex(snapshot) : 0;
  const target = snapshot?.target.kind === "alpha" && snapshot.target.index !== null ? `alpha:${snapshot.target.index}` : "pixels";
  return {
    source: defaultSourceForm(active),
    maskChannel: "",
    blending: "multiply",
    opacity: 100,
    scale: 1,
    offset: 0,
    preserveTransparency: false,
    target
  };
}

export function defaultCalculationsForm(snapshot: ChannelSnapshot | null): CalculationsForm {
  const active = snapshot ? activeDocumentIndex(snapshot) : 0;
  return {
    source1: defaultSourceForm(active),
    source2: defaultSourceForm(active),
    maskChannel: "",
    blending: "multiply",
    opacity: 100,
    scale: 1,
    offset: 0,
    result: "newChannel",
    name: ""
  };
}
