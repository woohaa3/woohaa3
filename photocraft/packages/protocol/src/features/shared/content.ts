import { fnv1a64Hex } from "../../content-hash.js";
import { IMAGE_PROJECT_LIMITS } from "../../image-edit.js";
import { type ImageProjectBlendMode, isImageProjectBlendMode, canonicalizeLocks } from "../layers/content.js";
import { type ImageProjectTransform, canonicalizeTransform } from "../composition/content.js";
import { type ImageProjectMaskSummary, canonicalizeMask } from "../selections/content.js";
import { type ImageProjectTextContent, canonicalizeText } from "../type/content.js";
import { type ImageProjectAdjustmentContent, canonicalizeAdjustment } from "../adjustments/content.js";
import { type ImageProjectSmartSummary, canonicalizeSmart } from "../smart/content.js";
import {
  type ImageProjectShapeSummary,
  type ImageProjectVectorMaskSummary,
  type ImageProjectNamedPathSummary,
  type ImageProjectWorkPathSummary,
  type ImageProjectClippingPathSummary,
  canonicalizeShape,
  canonicalizeVectorMask,
  canonicalizeSavedPaths,
  canonicalizeWorkPath,
  canonicalizeClippingPath
} from "../vectors/content.js";
import { type AnimationContent as ImageProjectAnimationContent, canonicalizeAnimationContent } from "../animation/content.js";
import { type ImageProjectModeData, canonicalizeMode } from "../modes/content.js";
import { type ImageProjectFillContent, canonicalizeFillContent } from "../layers/fill-content.js";

/** 内容身份支持的图层类型；分组操作入口另受能力白名单控制。 */
/**
 * 图层 kind。`artboard` 是带裁切矩形的组（U56）：与 `group` 同一套内容身份规则，
 * 单独成 kind 是为了让工程结构可辨认，而不是另立一套指纹。
 */
export const IMAGE_PROJECT_LAYER_KINDS = ["pixel", "text", "adjustment", "group", "artboard", "smart", "shape", "fill"] as const;

export type ImageProjectLayerKind = (typeof IMAGE_PROJECT_LAYER_KINDS)[number];

/**
 * 规范文档内容（宿主与编辑器桥交换的**轻量**内容描述，不含像素/字体）。
 *
 * 像素与字体始终留在编辑器导出产物与工程对象内；宿主只持有可比较的内容语义。
 */
export type ImageProjectContent = {
  /** 内核工程图案资源摘要；空资源省略以兼容旧身份。 */
  patternContentHash?: string;
  /** 时间轴与视频帧的内容贡献；不带时间轴与视频层的旧文档省略以保持身份兼容。 */
  animation?: ImageProjectAnimationContent;
  /** 通道内容摘要（名称/种类/元数据/平面像素）；没有通道时省略以兼容旧身份。 */
  channelsContentHash?: string;
  /** 模式数据；缺省 RGB/8 位省略以兼容旧身份。 */
  mode?: ImageProjectModeData | null;
  /**
   * 内核工程文字样式表摘要（字符/段落样式的定义与顺序）；空表省略以兼容旧身份。
   *
   * 宿主不建模式式表，与 `patternContentHash` 一样原样携带内核算出的 16 位摘要并校验格式。
   * 它的存在是为了让「改样式表本身」也把工程判脏——引用该样式的文字层看起来毫无变化。
   */
  textStyles?: string;
  /** 当前画布尺寸（裁剪后）。 */
  canvasWidth: number;
  canvasHeight: number;
  /**
   * 已存命名路径的内容摘要（P7）；没有路径时省略以兼容旧身份。
   *
   * 顺序不敏感：规范化时按 `(名字, 摘要)` 排序。
   */
  paths?: ImageProjectNamedPathSummary[];
  /** 工作路径的几何摘要（P7）；没有工作路径时省略。 */
  workPath?: ImageProjectWorkPathSummary | null;
  /** 裁切路径引用（P7）；没有裁切路径时省略。 */
  clippingPath?: ImageProjectClippingPathSummary | null;
  /** 图层（自下而上；顺序即合成顺序）。 */
  layers: ImageProjectLayer[];
  /**
   * 变量与数据集（U76）。省略或为空对象时保持旧指纹形状。
   *
   * 两者都随 `.pcraft` 持久化，因此必须参与内容身份；否则「只改变量/数据集」不会改变指纹，
   * 宿主会误判为「未修改」。
   */
  variables?: ImageProjectVariablesContent;
};

/** 变量/数据集的规范内容（顺序敏感：重排即内容变化）。 */
export type ImageProjectVariablesContent = {
  defs: ImageProjectVariableDef[];
  dataSets: ImageProjectDataSet[];
};

export type ImageProjectVariableDef =
  | { name: string; layer: string; type: "visibility" | "textReplacement" }
  | {
      name: string;
      layer: string;
      type: "pixelReplacement";
      method: "fit" | "fill" | "asIs" | "conform";
      align:
        | "topLeft"
        | "topCenter"
        | "topRight"
        | "centerLeft"
        | "center"
        | "centerRight"
        | "bottomLeft"
        | "bottomCenter"
        | "bottomRight";
      clip: boolean;
    };

export type ImageProjectDataSet = {
  name: string;
  values: ImageProjectDataValue[];
};

export type ImageProjectDataValue = {
  variable: string;
  kind: "visibility" | "text" | "pixels";
  value: boolean | string;
};


export type ImageProjectLayer = {
  id: string;
  name: string;
  kind: ImageProjectLayerKind;
  visible: boolean;
  opacity: number;
  /** 填充不透明度；省略等同于 1，与整体不透明度分开保存。 */
  fill?: number;
  /** 完整内核样式的内容摘要；省略/null 表示没有样式。 */
  effects?: {enabled:boolean;contentHash:string} | null;
  /** 缺省的锁视为关闭；锁定属于可保存的工程内容。 */
  locks?: Partial<Record<"transparency" | "pixels" | "position" | "artboard" | "all", boolean>>;
  /** 省略或 false 表示未剪贴；true 时使用下方基底透明度。 */
  clipped?: boolean;
  blend: ImageProjectBlendMode;
  /** 归一化内容变换（平移/等比缩放/旋转/翻转）。 */
  transform: ImageProjectTransform;
  /** 蒙版存在时的内容摘要；无蒙版为 null。 */
  mask: ImageProjectMaskSummary | null;
  /** 像素层内容摘要。 */
  pixel: ImageProjectPixelSummary | null;
  /** 文字层内容。 */
  text: ImageProjectTextContent | null;
  /** 调整层参数。 */
  adjustment: ImageProjectAdjustmentContent | null;
  /** 智能对象的数据前置契约；入口和上传仍由能力门控制。 */
  smart?: ImageProjectSmartSummary | null;
  /** 形状层的路径几何摘要（P7）；矢量蒙版另见 `vectorMask`。 */
  shape?: ImageProjectShapeSummary | null;
  /** 填充层的规范参数（U57）：纯色/渐变/图案是可重编内容，像素只是缓存。 */
  fillLayer?: ImageProjectFillContent | null;
  /** 矢量蒙版摘要（P7）；省略表示没有。 */
  vectorMask?: ImageProjectVectorMaskSummary | null;
  /** 仅分组具有 children；空组使用空数组。展开状态不属于内容。 */
  children?: ImageProjectLayer[];
};

/** 像素层摘要：来源对象身份 + 内容指纹。 */
export type ImageProjectPixelSummary = {
  /**
   * **基底层**的稳定资产 id；其他像素层（含置入层）一律为 null。
   *
   * 置入来源不进入内容指纹：图层 id 每次加载都会重新编号，工程字节里也没有可稳定重建的
   * 「层 → 资产」映射。把它算进指纹会让同一份冻结文档在重开后得到不同指纹（每次重开都被
   * 误判为有净变化）。置入来源保留在描述符的 `sourceAssetIds`（宿主侧引用集合）。
   */
  sourceAssetId: string | null;
  contentHash: string;
};

export type ImageProjectLevelsChannel = {
  inBlack: number;
  gamma: number;
  inWhite: number;
  /** U41 输出黑/白场（0–255）；省略按 0/255（旧工程不改变指纹）。 */
  outBlack?: number;
  outWhite?: number;
};

export const POINT_PRECISION = 1e4;

export const HASH16 = /^[0-9a-f]{16}$/;

/** 归一化固定精度数值（避免浮点噪声改变指纹）。 */
export function round(value: number, precision = POINT_PRECISION): number {
  return Math.round(value * precision) / precision;
}

/**
 * 计算规范文档内容指纹。
 *
 * 非法结构（未知层类型/混合模式/调整类型、非有限数值、越界字符串）返回 `null`，
 * 调用方必须把 `null` 当作「无法判定」，绝不当作「无变化」。
 */
export function imageProjectContentHash(content: ImageProjectContent): string | null {
  const canonical = canonicalizeImageProjectContent(content);
  if (canonical === null) return null;
  return fnv1a64Hex(canonical);
}

/**
 * 规范化文档内容为**确定性**文本。
 *
 * 只读取已知字段；未知字段被忽略；数值统一固定精度；图层顺序敏感。
 */
export function canonicalizeImageProjectContent(content: ImageProjectContent): string | null {
  if (!isFinitePositiveInteger(content.canvasWidth) || !isFinitePositiveInteger(content.canvasHeight)) return null;
  if (!Array.isArray(content.layers) || content.layers.length === 0) return null;
  const lines: string[] = [`canvas:${content.canvasWidth}x${content.canvasHeight}`];
  if (content.patternContentHash !== undefined) {
    if(typeof content.patternContentHash!=="string" || !/^[a-f0-9]{16}$/.test(content.patternContentHash)) return null;
    lines.push(`patterns:${content.patternContentHash}`);
  }
  // 通道摘要与图案摘要同形；省略表示没有通道，旧工程身份因此逐字节不变。
  if (content.channelsContentHash !== undefined) {
    if(typeof content.channelsContentHash!=="string" || !/^[a-f0-9]{16}$/.test(content.channelsContentHash)) return null;
    lines.push(`channels:${content.channelsContentHash}`);
  }
  // 模式行（change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.2）。
  // 缺省模式返回 `""`，不追加；`null` 表示结构不可判定，整份内容随之不可判定。
  // `canonicalizeMode` 产出的文本已自带 `mode:` 前缀。
  const modeLine = canonicalizeMode(content.mode);
  if (modeLine === null) return null;
  if (modeLine !== "") lines.push(modeLine);
  // 文档级文字样式表摘要（与内核 `identity.rs` 的 `textStyles:` 行对应）。
  if (content.textStyles !== undefined) {
    if (typeof content.textStyles !== "string" || !/^[a-f0-9]{16}$/.test(content.textStyles)) return null;
    lines.push(`textStyles:${content.textStyles}`);
  }
  // 文档级路径（已存命名路径 / 工作路径 / 裁切路径）：**可选**行，空值省略，
  // 因此没有路径的旧工程指纹逐字节不变
  // （change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.2）。
  const savedPaths = canonicalizeSavedPaths(content.paths);
  if (savedPaths === null) return null;
  if (savedPaths !== "") lines.push(savedPaths);
  const workPath = canonicalizeWorkPath(content.workPath);
  if (workPath === null) return null;
  if (workPath !== "") lines.push(workPath);
  const clippingPath = canonicalizeClippingPath(content.clippingPath);
  if (clippingPath === null) return null;
  if (clippingPath !== "") lines.push(clippingPath);
  const budget = { count: 0, smart: new Map<number,string>() };
  for (const layer of content.layers) {
    const line = canonicalizeLayer(layer, 1, budget);
    if (line === null) return null;
    lines.push(line);
  }
  // 动画贡献（change: 2026-10-22-add-photocraft-animation-workflows）：只有真的带时间轴/视频层
  // 才追加，旧内容的规范文本因此逐字节不变（指纹兼容）。
  if (content.animation !== undefined) {
    const line = canonicalizeAnimationContent(content.animation);
    if (line === null) return null;
    lines.push(line);
  }
  // 变量与数据集：省略或为空时保持旧指纹形状。
  if (content.variables != null) {
    const variables = canonicalizeVariables(content.variables);
    if (variables === null) return null;
    lines.push(variables);
  }
  return lines.join("\n");
}

/** 单个变量定义名称/图层引用/数据集名称的长度上限（UTF-16 单元）。 */
const MAX_VARIABLE_NAME_UNITS = 200;
/** 数据集里替换文本与像素资源键的长度上限。 */
const MAX_VARIABLE_TEXT_UNITS = 100_000;
/** 一份文档的变量/数据集/单集取值上限（与内核预算一致）。 */
const MAX_VARIABLES = 256;
const MAX_DATA_SETS = 1024;
const MAX_VALUES_PER_SET = 512;

const PIXEL_METHODS = ["fit", "fill", "asIs", "conform"] as const;
const PIXEL_ALIGNS = [
  "topLeft","topCenter","topRight","centerLeft","center","centerRight","bottomLeft","bottomCenter","bottomRight"
] as const;

/**
 * 变量/数据集的规范文本（与 Rust `identity::canonicalize_variables` 逐字节一致）。
 *
 * 未知种类或非法载荷返回 `null`（无法判定 ≠ 无变化）。
 */
export function canonicalizeVariables(variables: ImageProjectVariablesContent): string | null {
  if (variables === null || typeof variables !== "object") return null;
  const defs = variables.defs;
  const dataSets = variables.dataSets;
  if (!Array.isArray(defs) || !Array.isArray(dataSets)) return null;
  if (defs.length === 0 && dataSets.length === 0) return null;
  if (defs.length > MAX_VARIABLES || dataSets.length > MAX_DATA_SETS) return null;
  const defLines: string[] = [];
  for (const def of defs) {
    if (def === null || typeof def !== "object") return null;
    if (!isNonEmptyShortString(def.name, MAX_VARIABLE_NAME_UNITS)) return null;
    if (!isNonEmptyShortString(def.layer, 200)) return null;
    let tail = "";
    if (def.type === "pixelReplacement") {
      if (!PIXEL_METHODS.includes(def.method)) return null;
      if (!PIXEL_ALIGNS.includes(def.align)) return null;
      if (typeof def.clip !== "boolean") return null;
      tail = `|${def.method}|${def.align}|${def.clip ? 1 : 0}`;
    } else if (def.type !== "visibility" && def.type !== "textReplacement") {
      return null;
    }
    defLines.push(`def|${def.name.length}:${def.name}|${def.layer.length}:${def.layer}|${def.type}${tail}`);
  }
  const setLines: string[] = [];
  for (const set of dataSets) {
    if (set === null || typeof set !== "object") return null;
    if (!isNonEmptyShortString(set.name, MAX_VARIABLE_NAME_UNITS)) return null;
    if (!Array.isArray(set.values) || set.values.length > MAX_VALUES_PER_SET) return null;
    const valueLines: string[] = [];
    for (const value of set.values) {
      if (value === null || typeof value !== "object") return null;
      if (!isNonEmptyShortString(value.variable, MAX_VARIABLE_NAME_UNITS)) return null;
      let text: string;
      if (value.kind === "visibility") {
        if (typeof value.value !== "boolean") return null;
        text = value.value ? "1" : "0";
      } else if (value.kind === "text") {
        if (typeof value.value !== "string" || value.value.length > MAX_VARIABLE_TEXT_UNITS) return null;
        text = `${value.value.length}:${value.value}`;
      } else if (value.kind === "pixels") {
        if (!isNonEmptyShortString(value.value, MAX_VARIABLE_NAME_UNITS)) return null;
        text = `${value.value.length}:${value.value}`;
      } else {
        return null;
      }
      valueLines.push(`value|${value.variable.length}:${value.variable}|${value.kind}|${text}`);
    }
    setLines.push(
      `set|${set.name.length}:${set.name}|[${valueLines.map((line) => `${line.length}:${line}`).join("")}]`
    );
  }
  return `variables:[${defLines.map((line) => `${line.length}:${line}`).join("")}][${
    setLines.map((line) => `${line.length}:${line}`).join("")
  }]`;
}

export function canonicalizeLayer(layer: ImageProjectLayer, depth: number, budget: { count: number; smart:Map<number,string> }): string | null {
  if (depth > IMAGE_PROJECT_LIMITS.maxDocumentDepth || ++budget.count > IMAGE_PROJECT_LIMITS.maxLayers) return null;
  if (!layer || typeof layer !== "object") return null;
  if (!isNonEmptyShortString(layer.id, 200)) return null;
  if (typeof layer.name !== "string" || layer.name.length > 200) return null;
  if (!isImageProjectLayerKind(layer.kind)) return null;
  if (typeof layer.visible !== "boolean") return null;
  if (!isFiniteUnit(layer.opacity)) return null;
  if (layer.fill !== undefined && !isFiniteUnit(layer.fill)) return null;
  const fill = layer.fill === undefined || layer.fill === 1 ? "" : `|fill:${round(layer.fill)}`;
  if (!isImageProjectBlendMode(layer.blend)) return null;
  if (layer.blend === "pass-through" && layer.kind !== "group" && layer.kind !== "artboard") return null;
  const effects = layer.effects;
  if (effects != null && (typeof effects !== "object" || Array.isArray(effects)
      || typeof effects.enabled !== "boolean" || !/^[a-f0-9]{16}$/.test(effects.contentHash))) return null;
  const style = effects == null ? "" : `|effects:${effects.enabled ? 1 : 0}:${effects.contentHash}`;
  const transform = canonicalizeTransform(layer.transform);
  if (transform === null) return null;
  const mask = canonicalizeMask(layer.mask);
  if (mask === null) return null;
  if (layer.clipped !== undefined && typeof layer.clipped !== "boolean") return null;
  const clipping = layer.clipped === true ? "|clipped" : "";
  const locks = canonicalizeLocks(layer.locks);
  if (locks === null) return null;
  // 每层只允许与其 kind 对应的内容字段：混合内容拒绝，避免「隐藏且无法继续编辑」的对象。
  const present = [
    layer.pixel !== null,
    layer.text !== null,
    layer.adjustment !== null,
    layer.smart != null,
    layer.shape != null,
    layer.fillLayer != null
  ].filter(Boolean).length;
  const groupLike = layer.kind === "group" || layer.kind === "artboard";
  if (present !== (groupLike ? 0 : 1)) return null;
  if (!groupLike && layer.children !== undefined) return null;
  let body: string;
  if (groupLike) {
    if (!Array.isArray(layer.children)) return null;
    const children: string[] = [];
    for (const child of layer.children) {
      const canonical = canonicalizeLayer(child, depth + 1, budget);
      if (canonical === null) return null;
      children.push(canonical);
    }
    // 按 UTF-16 长度划分子层，避免分隔符歧义及嵌套 JSON 转义的指数增长。
    body = `group:[${children.map(child => `${child.length}:${child}`).join("")}]`;
  } else if (layer.kind === "pixel") {
    const pixel = canonicalizePixel(layer.pixel);
    if (pixel === null) return null;
    body = pixel;
  } else if (layer.kind === "smart") {
    const smart=canonicalizeSmart(layer.smart);
    if(smart===null) return null;
    const info=layer.smart!,identity=`${info.sourceContentHash}:${info.sourceName}`;
    const previous=budget.smart.get(info.contentsGroup);
    if(previous!==undefined && previous!==identity) return null;
    if(previous===undefined) {if(info.contentsGroup!==budget.smart.size+1) return null;budget.smart.set(info.contentsGroup,identity);}
    body=smart;
  } else if (layer.kind === "shape") {
    const shape = canonicalizeShape(layer.shape);
    if (shape === null) return null;
    body = shape;
  } else if (layer.kind === "fill") {
    const fillLayer = canonicalizeFillContent(layer.fillLayer);
    if (fillLayer === null) return null;
    body = fillLayer;
  } else if (layer.kind === "text") {
    const text = canonicalizeText(layer.text);
    if (text === null) return null;
    body = text;
  } else {
    const adjustment = canonicalizeAdjustment(layer.adjustment);
    if (adjustment === null) return null;
    body = adjustment;
  }
  // 矢量蒙版摘要：非法结构必须让整层判为不可判定（`null`），不能把 `"null"` 拼进规范文本
  // ——那会让损坏内容得到一个合法指纹。旧工程省略该字段时是空串，指纹保持逐字节兼容。
  const vectorMask = canonicalizeVectorMask(layer.vectorMask);
  if (vectorMask === null) return null;
  return [
    "layer",
    layer.id,
    layer.name,
    layer.kind,
    layer.visible ? "1" : "0",
    String(round(layer.opacity)),
    layer.blend,
    transform,
    mask,
    body
  ].join("|") + locks + clipping + fill + style + vectorMask;
}

export function canonicalizePixel(pixel: ImageProjectPixelSummary | null): string | null {
  if (!pixel || typeof pixel !== "object") return null;
  if (pixel.sourceAssetId !== null && !isNonEmptyShortString(pixel.sourceAssetId, 200)) return null;
  if (typeof pixel.contentHash !== "string" || !HASH16.test(pixel.contentHash)) return null;
  return `pixel:${pixel.sourceAssetId ?? "-"}:${pixel.contentHash}`;
}

export function isImageProjectLayerKind(value: unknown): value is ImageProjectLayerKind {
  return typeof value === "string" && (IMAGE_PROJECT_LAYER_KINDS as readonly string[]).includes(value);
}

export function isFiniteNumberValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isFinitePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function isFiniteUnit(value: unknown): value is number {
  return isFiniteNumberValue(value) && value >= 0 && value <= 1;
}

export function isNonEmptyShortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
