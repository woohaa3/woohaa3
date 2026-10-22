/**
 * 图片工程文档内容身份
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 2.2 / design D3/D4）。
 *
 * 纯函数、无副作用、JSON-only：把 PhotoCraft 规范文档内容的**受控子集**折叠成稳定 16 位 hex
 * 指纹，供宿主判断净变化、生成内容身份与拼装工程描述符。
 *
 * 关键约束：
 * - 只覆盖**语义内容**：图层树、每层内容（像素层/文字层/调整层）、蒙版、混合模式、不透明度、
 *   显隐、锁定、顺序、变换与裁剪画布尺寸；
 * - 明确排除**视图与交互状态**：选区、取景/缩放、活动层、工具偏好、撤销栈、保存时间与序列化
 *   容器噪声；
 * - 只接受**已归一化**的 JSON 值（数字有限、无未知字段），非法结构返回 `null`，绝不生成可能
 *   被误认为「无变化」的指纹；
 * - 同一语义内容在不同序列化顺序/打包时间下映射同一指纹；同 PNG 不同层结构映射不同指纹。
 */
import { fnv1a64Hex } from "./content-hash.js";
import { IMAGE_PROJECT_LIMITS } from "./image-edit.js";

/** 内容身份支持的图层类型；分组操作入口另受能力白名单控制。 */
export const IMAGE_PROJECT_LAYER_KINDS = ["pixel", "text", "adjustment", "group", "smart"] as const;
export type ImageProjectLayerKind = (typeof IMAGE_PROJECT_LAYER_KINDS)[number];

/** 内容身份支持的混合模式；pass-through 仅用于组。 */
export const IMAGE_PROJECT_BLEND_MODES = ["normal", "dissolve", "darken", "multiply", "color-burn", "linear-burn", "darker-color", "lighten", "screen", "color-dodge", "linear-dodge", "lighter-color", "overlay", "soft-light", "hard-light", "vivid-light", "linear-light", "pin-light", "hard-mix", "difference", "exclusion", "subtract", "divide", "hue", "saturation", "color", "luminosity", "pass-through"] as const;
export type ImageProjectBlendMode = (typeof IMAGE_PROJECT_BLEND_MODES)[number];

/** 首期允许的调整层类型。 */
export const IMAGE_PROJECT_ADJUSTMENT_KINDS = [
  "brightness-contrast",
  "hue-saturation",
  "curves"
] as const;
export type ImageProjectAdjustmentKind = (typeof IMAGE_PROJECT_ADJUSTMENT_KINDS)[number];

/**
 * 规范文档内容（宿主与编辑器桥交换的**轻量**内容描述，不含像素/字体）。
 *
 * 像素与字体始终留在编辑器导出产物与工程对象内；宿主只持有可比较的内容语义。
 */
export type ImageProjectContent = {
  /** 内核工程图案资源摘要；空资源省略以兼容旧身份。 */
  patternContentHash?: string;
  /** 当前画布尺寸（裁剪后）。 */
  canvasWidth: number;
  canvasHeight: number;
  /** 图层（自下而上；顺序即合成顺序）。 */
  layers: ImageProjectLayer[];
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
  /** 仅分组具有 children；空组使用空数组。展开状态不属于内容。 */
  children?: ImageProjectLayer[];
};

/** 共享源按本文件首次出现顺序编号，不使用进程内 contents_id。完整仿射保留非等比/剪切。 */
export type ImageProjectSmartSummary = {
  sourceContentHash: string;
  sourceName: string;
  contentsGroup: number;
  transform: [number,number,number,number,number,number];
};

/** 归一化图层变换；角度与缩放保留固定精度。 */
export type ImageProjectTransform = {
  translateX: number;
  translateY: number;
  scale: number;
  rotationDegrees: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
};

/** 蒙版摘要：只描述状态与来源像素摘要，不含蒙版像素。 */
export type ImageProjectMaskSummary = {
  linked?: boolean;
  enabled: boolean;
  /** 蒙版来源：选区转换/手工绘制。 */
  origin: "selection" | "paint";
  /** 蒙版内容指纹（编辑器上报；宿主只比较）。 */
  contentHash: string;
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

/** 文字层内容（可重编）。 */
export type ImageProjectTextContent = {
  /** 段落框的文字空间范围；省略或 null 表示点文字。 */
  box?: [number, number, number, number] | null;
  text: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  bold: boolean;
  align: "left" | "center" | "right";
};

/** 调整层参数（首期三类）。 */
export type ImageProjectAdjustmentContent = {
  kind: ImageProjectAdjustmentKind;
  /** 参数：亮度/对比度、色相/饱和度或 RGB 曲线控制点。 */
  parameters: ImageProjectAdjustmentParameters;
};

export type ImageProjectAdjustmentParameters =
  | { kind: "brightness-contrast"; brightness: number; contrast: number }
  | { kind: "hue-saturation"; hue: number; saturation: number; lightness: number }
  | { kind: "curves"; rgb: Array<{ x: number; y: number }> };

const POINT_PRECISION = 1e4;
const HASH16 = /^[0-9a-f]{16}$/;

/** 归一化固定精度数值（避免浮点噪声改变指纹）。 */
function round(value: number, precision = POINT_PRECISION): number {
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
  const budget = { count: 0, smart: new Map<number,string>() };
  for (const layer of content.layers) {
    const line = canonicalizeLayer(layer, 1, budget);
    if (line === null) return null;
    lines.push(line);
  }
  return lines.join("\n");
}

function canonicalizeLayer(layer: ImageProjectLayer, depth: number, budget: { count: number; smart:Map<number,string> }): string | null {
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
  if (layer.blend === "pass-through" && layer.kind !== "group") return null;
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
  const present = [layer.pixel !== null, layer.text !== null, layer.adjustment !== null, layer.smart != null].filter(Boolean).length;
  if (present !== (layer.kind === "group" ? 0 : 1)) return null;
  if (layer.kind !== "group" && layer.children !== undefined) return null;
  let body: string;
  if (layer.kind === "group") {
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
  } else if (layer.kind === "text") {
    const text = canonicalizeText(layer.text);
    if (text === null) return null;
    body = text;
  } else {
    const adjustment = canonicalizeAdjustment(layer.adjustment);
    if (adjustment === null) return null;
    body = adjustment;
  }
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
  ].join("|") + locks + clipping + fill + style;
}

function canonicalizeLocks(locks: ImageProjectLayer["locks"]): string | null {
  if (locks === undefined) return "";
  if (locks === null || typeof locks !== "object" || Array.isArray(locks)) return null;
  const keys = ["transparency", "pixels", "position", "artboard", "all"] as const;
  if (Object.keys(locks).some(key => !keys.includes(key as typeof keys[number]))) return null;
  if (Object.values(locks).some(value => typeof value !== "boolean")) return null;
  const flags = keys.map(key => locks[key] === true ? "1" : "0").join("");
  return flags.includes("1") ? `|locks:${flags}` : "";
}

function canonicalizeTransform(transform: ImageProjectTransform): string | null {
  if (!transform || typeof transform !== "object") return null;
  if (!isFiniteNumberValue(transform.translateX) || !isFiniteNumberValue(transform.translateY)) return null;
  if (!isFiniteNumberValue(transform.scale) || transform.scale <= 0) return null;
  if (!isFiniteNumberValue(transform.rotationDegrees)) return null;
  if (typeof transform.flipHorizontal !== "boolean" || typeof transform.flipVertical !== "boolean") return null;
  return [
    String(round(transform.translateX)),
    String(round(transform.translateY)),
    String(round(transform.scale)),
    String(round(transform.rotationDegrees)),
    transform.flipHorizontal ? "1" : "0",
    transform.flipVertical ? "1" : "0"
  ].join(",");
}

/** 返回 `"none"` 表示无蒙版；`null` 表示非法。 */
function canonicalizeMask(mask: ImageProjectMaskSummary | null): string | null {
  if (mask === null) return "none";
  if (typeof mask !== "object") return null;
  if (typeof mask.enabled !== "boolean") return null;
  if (mask.linked !== undefined && typeof mask.linked !== "boolean") return null;
  if (mask.origin !== "selection" && mask.origin !== "paint") return null;
  if (typeof mask.contentHash !== "string" || !HASH16.test(mask.contentHash)) return null;
  return `mask:${mask.enabled ? "1" : "0"}:${mask.origin}:${mask.contentHash}${mask.linked === false ? ":unlinked" : ""}`;
}

function canonicalizePixel(pixel: ImageProjectPixelSummary | null): string | null {
  if (!pixel || typeof pixel !== "object") return null;
  if (pixel.sourceAssetId !== null && !isNonEmptyShortString(pixel.sourceAssetId, 200)) return null;
  if (typeof pixel.contentHash !== "string" || !HASH16.test(pixel.contentHash)) return null;
  return `pixel:${pixel.sourceAssetId ?? "-"}:${pixel.contentHash}`;
}

function canonicalizeSmart(value: ImageProjectSmartSummary | null | undefined): string | null {
  if(!value || typeof value!=="object" || Array.isArray(value)
      || Object.keys(value).length!==4 || Object.keys(value).some(key=>!["sourceContentHash","sourceName","contentsGroup","transform"].includes(key))) return null;
  if(typeof value.sourceContentHash!=="string" || !HASH16.test(value.sourceContentHash)
      || typeof value.sourceName!=="string" || !value.sourceName.trim() || value.sourceName.length>200
      || /[\\/:\u0000-\u001f\u007f-\u009f]/.test(value.sourceName) || !/^.+\.pcraft$/i.test(value.sourceName) || !value.sourceName.slice(0,-7).trim()
      || !Number.isSafeInteger(value.contentsGroup) || value.contentsGroup<1 || value.contentsGroup>IMAGE_PROJECT_LIMITS.maxLayers
      || !Array.isArray(value.transform) || value.transform.length!==6 || !value.transform.every(n=>typeof n==="number" && Number.isFinite(n))) return null;
  const [a,b,c,d]=value.transform,det=a*d-b*c;
  if(!Number.isFinite(det) || Math.abs(det)<1e-12) return null;
  const view=new DataView(new ArrayBuffer(8));
  const affine=value.transform.map(n=>{view.setFloat64(0,n===0?0:n,true);return Array.from({length:8},(_,i)=>view.getUint8(i).toString(16).padStart(2,"0")).join("");}).join("");
  return `smart:${value.contentsGroup}:${value.sourceContentHash}:${affine}:${value.sourceName.length}:${value.sourceName}`;
}

function canonicalizeText(text: ImageProjectTextContent | null): string | null {
  if (!text || typeof text !== "object") return null;
  if (typeof text.text !== "string" || text.text.length > 100_000) return null;
  if (!isNonEmptyShortString(text.fontFamily, 200)) return null;
  if (!isFiniteNumberValue(text.fontSize) || text.fontSize <= 0) return null;
  if (!/^#[0-9a-f]{6}$/.test(text.color)) return null;
  if (typeof text.bold !== "boolean") return null;
  if (text.align !== "left" && text.align !== "center" && text.align !== "right") return null;
  const box=text.box;
  if (box != null && (!Array.isArray(box) || box.length!==4 || !box.every((n)=>isFiniteNumberValue(n) && Math.abs(n)<=8192) || box[2]<=0 || box[3]<=0)) return null;
  return [
    box == null ? "text" : `text-box:${box.map((n)=>String(round(n))).join(",")}`,
    String(round(text.fontSize)),
    text.color,
    text.bold ? "1" : "0",
    text.align,
    text.fontFamily,
    text.text
  ].join(":");
}

function canonicalizeAdjustment(adjustment: ImageProjectAdjustmentContent | null): string | null {
  if (!adjustment || typeof adjustment !== "object") return null;
  const parameters = adjustment.parameters;
  if (!parameters || typeof parameters !== "object") return null;
  if (adjustment.kind !== parameters.kind) return null;
  if (parameters.kind === "brightness-contrast") {
    if (!isFiniteNumberValue(parameters.brightness) || !isFiniteNumberValue(parameters.contrast)) return null;
    return `adjust:brightness-contrast:${round(parameters.brightness)}:${round(parameters.contrast)}`;
  }
  if (parameters.kind === "hue-saturation") {
    if (!isFiniteNumberValue(parameters.hue) || !isFiniteNumberValue(parameters.saturation)) return null;
    if (!isFiniteNumberValue(parameters.lightness)) return null;
    return `adjust:hue-saturation:${round(parameters.hue)}:${round(parameters.saturation)}:${round(parameters.lightness)}`;
  }
  if (parameters.kind === "curves") {
    if (!Array.isArray(parameters.rgb) || parameters.rgb.length === 0) return null;
    const points: string[] = [];
    for (const point of parameters.rgb) {
      if (!point || typeof point !== "object") return null;
      if (!isFiniteNumberValue(point.x) || !isFiniteNumberValue(point.y)) return null;
      if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null;
      points.push(`${round(point.x)},${round(point.y)}`);
    }
    return `adjust:curves:${points.join(";")}`;
  }
  return null;
}

export function isImageProjectLayerKind(value: unknown): value is ImageProjectLayerKind {
  return typeof value === "string" && (IMAGE_PROJECT_LAYER_KINDS as readonly string[]).includes(value);
}

export function isImageProjectBlendMode(value: unknown): value is ImageProjectBlendMode {
  return typeof value === "string" && (IMAGE_PROJECT_BLEND_MODES as readonly string[]).includes(value);
}

export function isImageProjectAdjustmentKind(value: unknown): value is ImageProjectAdjustmentKind {
  return typeof value === "string" && (IMAGE_PROJECT_ADJUSTMENT_KINDS as readonly string[]).includes(value);
}

function isFiniteNumberValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFinitePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isFiniteUnit(value: unknown): value is number {
  return isFiniteNumberValue(value) && value >= 0 && value <= 1;
}

function isNonEmptyShortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** 有界样式结构与可选工程图案关联检查，最终类型解析仍由固定 Rust 内核执行。 */
export function isSupportedImageProjectEffects(input: unknown,patterns?:unknown[]): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const effects = input as Record<string,unknown>;
  if (typeof effects.enabled !== "boolean" || !Array.isArray(effects.items) || effects.items.length > 64 || effects.psd_raw != null) return false;
  if (effects.reference != null && (!Array.isArray(effects.reference) || effects.reference.length !== 2 || !effects.reference.every(value=>typeof value==="number" && Number.isFinite(value)))) return false;
  const kinds = ["DropShadow","InnerShadow","OuterGlow","InnerGlow","Stroke","ColorOverlay","GradientOverlay","PatternOverlay","Satin","BevelEmboss"];
  let budget=8192;const references:{id:string;name:string}[]=[];
  const bounded=(value:unknown,depth:number,key=""):boolean=>{
    if (depth>16 || budget--<=0) return false;
    if (value===null) return key==="texture" || key==="contour";
    if (typeof value==="boolean") return true;
    if (typeof value==="number") {
      const range:Record<string,[number,number]>={opacity:[0,1],spread:[0,1],range:[0,1],jitter:[0,1],noise:[0,1],size:[0,2048],soften:[0,2048],distance:[0,2048],depth:[0,10],"texture-depth":[-10,10],scale:[.01,10],angle:[-360,360],altitude:[0,90]};
      const [min,max]=range[key]??[-1_000_000,1_000_000];return Number.isFinite(value) && value>=min && value<=max;
    }
    if (typeof value==="string") return value.length<=200;
    if (Array.isArray(value)) return value.length<=256
      && (!["stops","opacity_stops"].includes(key) || value.every(stop=>Array.isArray(stop) && stop.length===2
        && typeof stop[0]==="number" && Number.isFinite(stop[0]) && stop[0]>=0 && stop[0]<=1
        && (key!=="opacity_stops" || (typeof stop[1]==="number" && Number.isFinite(stop[1]) && stop[1]>=0 && stop[1]<=1))))
      && value.every(item=>bounded(item,depth+1));
    if (typeof value!=="object" || !value) return false;
    const entries=Object.entries(value);
    if(["Pattern","PatternOverlay","texture"].includes(key)) {
      const p=value as Record<string,unknown>;
      if(typeof p.id!=="string" || !p.id.trim() || typeof p.name!=="string" || !p.name.trim()
          || typeof p.scale!=="number" || !Number.isFinite(p.scale) || p.scale<.01 || p.scale>10
          || (p.phase!==undefined && (!Array.isArray(p.phase) || p.phase.length!==2))) return false;
      references.push({id:p.id,name:p.name});
    }
    if ("Custom" in value) {
      const custom=(value as {Custom:unknown}).Custom;
      if (!custom || typeof custom!=="object" || Array.isArray(custom)) return false;
      const {points,corners}=custom as Record<string,unknown>;
      if (!Array.isArray(points) || points.length<2 || points.length>256) return false;
      let previous=-1;
      if (!points.every(point=>{
        if (!point || typeof point!=="object" || Array.isArray(point)) return false;
        const {input,output}=point as Record<string,unknown>;
        if (typeof input!=="number" || typeof output!=="number" || !Number.isFinite(input) || !Number.isFinite(output)
          || input<0 || input>1 || output<0 || output>1 || input<=previous) return false;
        previous=input;return true;
      })) return false;
      if (corners!==undefined && (!Array.isArray(corners) || corners.length>points.length || !corners.every(corner=>typeof corner==="boolean"))) return false;
    }
    return entries.length<=64 && entries.every(([field,item])=>(field!=="blend" || (typeof item==="string" && IMAGE_PROJECT_BLEND_MODES.some(mode=>mode!=="pass-through" && mode.replace(/-/g,"")===item.toLowerCase()))) && bounded(item,depth+1,field==="depth" && key==="texture"?"texture-depth":field));
  };
  const shape=effects.items.every(item=>item && typeof item==="object" && !Array.isArray(item)
    && Object.keys(item).length===1 && kinds.includes(Object.keys(item)[0]!) && bounded(item,0));
  return shape && (patterns===undefined || references.every(ref=>patterns.some(p=>!!p && typeof p==="object" && (p as Record<string,unknown>).id===ref.id && (p as Record<string,unknown>).name===ref.name)));

}


/** 工程图案资源的轻量结构核验；在原生 tile 解码前执行。 */
export function isSupportedImageProjectPatterns(value:unknown):boolean {
  if(value===undefined) return true;
  if(!Array.isArray(value) || value.length>IMAGE_PROJECT_LIMITS.maxPatterns) return false;
  const ids=new Set<string>();let pixels=0;
  const object=(v:unknown):v is Record<string,unknown>=>!!v && typeof v==="object" && !Array.isArray(v);
  return value.every(p=>{
    if(!object(p) || !isNonEmptyShortString(p.id,200) || !p.id.trim() || ids.has(p.id)
        || !isNonEmptyShortString(p.name,200) || !p.name.trim()
        || !isFinitePositiveInteger(p.width) || !isFinitePositiveInteger(p.height)
        || p.width>IMAGE_PROJECT_LIMITS.maxPatternSide || p.height>IMAGE_PROJECT_LIMITS.maxPatternSide) return false;
    ids.add(p.id);pixels+=p.width*p.height;if(pixels>IMAGE_PROJECT_LIMITS.maxPatternPixels) return false;
    const s=p.surface;if(!object(s) || !object(s.format)) return false;
    const f=s.format;
    if(f.mode!=="Rgb" || f.sample!=="U8" || typeof f.alpha!=="boolean"
        || typeof s.default!=="string" || s.default.length!==(f.alpha?8:6) || !/^[a-f0-9]+$/i.test(s.default)
        || !Array.isArray(s.tiles) || s.tiles.length>16) return false;
    const width=p.width,height=p.height;
    const coords=new Set<string>();
    return s.tiles.every(t=>{
      if(!object(t) || typeof t.tx!=="number" || typeof t.ty!=="number" || !Number.isInteger(t.tx) || !Number.isInteger(t.ty)
          || t.tx<0 || t.ty<0 || t.tx>=Math.ceil(width/256) || t.ty>=Math.ceil(height/256)) return false;
      const key=`${t.tx},${t.ty}`;if(coords.has(key)) return false;coords.add(key);return true;
    });
  });
}
