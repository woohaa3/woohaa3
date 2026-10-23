/**
 * 工作流表单的**声明式字段表与参数编译**（U53–U56）。
 *
 * `panels.tsx` 只负责渲染字段与收集值；把「哪个入口有哪些字段」「字段怎么进参数」放在这里，
 * 是为了能让纯函数测试覆盖全部入口，而不必逐项渲染 DOM。
 *
 * 规则：
 * - 字段值只在用户改过时才进入参数（`dirty`），默认值不等于「没填」——`imageSize` 的
 *   `percent` 就是这样既支持「只改 DPI」又支持「按百分比缩放」。
 * - 能力门在 `allowed !== true` 时一律禁用（缺失清单项按未开放处理，不默认放开）。
 * - 编译失败返回 `{ error }`，调用方就地提示，不提交旧候选。
 */

import {
  PHOTO_LAYOUTS,
  PRINT_UNITS,
  RESAMPLE_METHODS,
  autoAlignParams,
  autoBlendParams,
  fadeParams,
  fillParams,
  frameParams,
  imageSizeParams,
  photomergeParams,
  sliceParams,
  strokeParams,
  warpGridParams,
  warpMeshParams,
  warpSplitParams,
  warpStyleParams,
  type ResampleMethod,
  type WarpMesh,
  type WarpStyle
} from "./workflows.js";

export type FieldValue = string | number | boolean;
export type FieldValues = Record<string, FieldValue>;

export type WorkflowField = {
  key: string;
  label: string;
  kind: "number" | "text" | "color" | "check" | "select";
  /** 数字字段的单位后缀。 */
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly { value: string; label: string }[];
  /** 默认值；`undefined` 表示未填（不进入参数）。 */
  initial?: FieldValue;
  placeholder?: string;
};

const options = (values: readonly string[]) => values.map((value) => ({ value, label: value }));

const PROJECTIONS = options(PHOTO_LAYOUTS);

/** 各入口的字段表；没有列出的入口没有参数（如「再次变换」）。 */
export const WORKFLOW_FIELDS: Record<string, readonly WorkflowField[]> = {
  // ------- U53 变换与变形
  warp: [
    {
      key: "style",
      label: "样式",
      kind: "select",
      initial: "arc",
      options: [
        "none", "arc", "arcLower", "arcUpper", "arch", "bulge", "shellLower", "shellUpper",
        "flag", "wave", "fish", "rise", "fisheye", "inflate", "squeeze", "twist"
      ].map((value) => ({ value, label: value }))
    },
    { key: "bend", label: "弯曲", kind: "number", min: -100, max: 100, unit: "%", initial: 50 },
    { key: "hDistort", label: "水平扭曲", kind: "number", min: -100, max: 100, unit: "%" },
    { key: "vDistort", label: "垂直扭曲", kind: "number", min: -100, max: 100, unit: "%" },
    { key: "vertical", label: "沿垂直方向", kind: "check", initial: false }
  ],
  warpGrid: [
    {
      key: "size",
      label: "网格",
      kind: "select",
      initial: "4",
      options: ["default", "1", "2", "3", "4", "5", "6", "8", "12", "16", "32", "64"]
        .map((value) => ({ value, label: value }))
    }
  ],
  splitWarpCrosswise: [
    { key: "atX", label: "分割点 X（文档像素）", kind: "number", placeholder: "默认块中点" },
    { key: "atY", label: "分割点 Y（文档像素）", kind: "number", placeholder: "默认块中点" }
  ],
  splitWarpHorizontally: [
    { key: "atX", label: "分割点 X（文档像素）", kind: "number", placeholder: "默认块中点" },
    { key: "atY", label: "分割点 Y（文档像素）", kind: "number", placeholder: "默认块中点" }
  ],
  splitWarpVertically: [
    { key: "atX", label: "分割点 X（文档像素）", kind: "number", placeholder: "默认块中点" },
    { key: "atY", label: "分割点 Y（文档像素）", kind: "number", placeholder: "默认块中点" }
  ],
  removeWarpSplit: [
    { key: "atX", label: "移除点 X", kind: "number", placeholder: "默认块中点" },
    { key: "atY", label: "移除点 Y", kind: "number", placeholder: "默认块中点" }
  ],
  // ------- U54 填充、描边与渐隐
  fill: [
    {
      key: "contents",
      label: "内容",
      kind: "select",
      initial: "color",
      options: [
        { value: "foreground", label: "前景色" },
        { value: "background", label: "背景色" },
        { value: "color", label: "颜色…" },
        { value: "contentAware", label: "内容识别" },
        { value: "pattern", label: "图案…" },
        { value: "history", label: "历史记录" },
        { value: "black", label: "黑色" },
        { value: "gray", label: "50% 灰" },
        { value: "white", label: "白色" }
      ]
    },
    { key: "color", label: "颜色", kind: "color", initial: "#3366cc" },
    { key: "pattern", label: "图案", kind: "text", placeholder: "图案名称或 id" },
    { key: "scale", label: "图案缩放", kind: "number", min: 1, max: 1600, unit: "%" },
    { key: "angle", label: "图案角度", kind: "number", min: -360, max: 360, unit: "°" },
    { key: "mode", label: "混合模式", kind: "select", options: options(["normal", "multiply", "screen", "overlay", "softLight", "hardLight", "darken", "lighten", "difference", "color", "luminosity", "dissolve"]) },
    { key: "opacity", label: "不透明度", kind: "number", min: 0, max: 100, unit: "%" },
    { key: "preserveTransparency", label: "保留透明区域", kind: "check", initial: false,
      // 只在「颜色/图案」这类覆盖式填充里可用；其他内容上游会忽略。
    }
  ],
  contentAwareFill: [
    { key: "sampling", label: "采样", kind: "select", initial: "auto", options: options(["auto", "rectangular", "custom"]) },
    { key: "margin", label: "边缘扩展", kind: "number", min: 0, max: 5000, unit: "px" },
    { key: "colorAdaptation", label: "颜色适应", kind: "select", options: options(["default", "none", "high", "veryHigh"]) },
    { key: "rotationAdaptation", label: "旋转适应", kind: "select", options: options(["none", "low", "medium", "high", "full"]) },
    { key: "output", label: "输出到", kind: "select", options: options(["current", "new", "duplicate"]) },
    { key: "sampleAllLayers", label: "对所有图层取样", kind: "check", initial: true }
  ],
  contentAwareScale: [
    { key: "scaleX", label: "宽度", kind: "number", min: 1, max: 400, unit: "%" },
    { key: "scaleY", label: "高度", kind: "number", min: 1, max: 400, unit: "%" },
    { key: "amount", label: "保护程度", kind: "number", min: 0, max: 100, unit: "%" },
    { key: "protectSkinTones", label: "保护肤色", kind: "check", initial: true }
  ],
  stroke: [
    { key: "width", label: "宽度", kind: "number", min: 1, max: 250, unit: "px", initial: 3 },
    {
      key: "location",
      label: "位置",
      kind: "select",
      initial: "inside",
      options: [
        { value: "inside", label: "内部" },
        { value: "center", label: "居中" },
        { value: "outside", label: "外部" }
      ]
    },
    { key: "color", label: "颜色", kind: "color", initial: "#3366cc" },
    { key: "opacity", label: "不透明度", kind: "number", min: 0, max: 100, unit: "%" },
    { key: "mode", label: "混合模式", kind: "select", options: options(["normal", "multiply", "screen", "overlay", "softLight", "hardLight", "darken", "lighten", "difference", "color", "luminosity", "dissolve"]) },
    { key: "preserveTransparency", label: "保留透明区域", kind: "check", initial: false }
  ],
  fade: [
    { key: "opacity", label: "不透明度", kind: "number", min: 0, max: 100, unit: "%", initial: 50 },
    { key: "mode", label: "混合模式", kind: "select", options: options(["normal", "multiply", "screen", "overlay", "softLight", "hardLight", "darken", "lighten", "difference", "color", "luminosity", "dissolve"]) }
  ],
  // ------- U55 照片合并
  autoAlign: [
    { key: "projection", label: "投影", kind: "select", initial: "auto", options: PROJECTIONS },
    { key: "reference", label: "参考图层 id", kind: "number", min: 0 },
    { key: "geometricCorrection", label: "几何校正", kind: "check", initial: true },
    { key: "registration", label: "配准", kind: "select", options: options(["auto", "features", "intensity"]) }
  ],
  autoBlend: [
    {
      key: "method",
      label: "方式",
      kind: "select",
      initial: "panorama",
      options: [
        { value: "panorama", label: "全景图" },
        { value: "stack", label: "堆栈" }
      ]
    },
    { key: "seamlessTones", label: "无缝色调和颜色", kind: "check", initial: true },
    { key: "haloControl", label: "光晕控制", kind: "number", min: 0, max: 8 },
    { key: "depthMap", label: "生成深度图", kind: "check", initial: false }
  ],
  photomerge: [
    { key: "layout", label: "版面", kind: "select", initial: "auto", options: PROJECTIONS },
    { key: "blend", label: "混合图像", kind: "check", initial: true },
    { key: "vignetteRemoval", label: "去除晕影", kind: "check", initial: true },
    { key: "geometricCorrection", label: "几何校正", kind: "check", initial: true },
    { key: "contentAwareFill", label: "内容识别填充", kind: "check", initial: true },
    { key: "focalLength", label: "焦距", kind: "number", min: 0, max: 2000, unit: "mm" }
  ],
  mergeToHdr: [
    { key: "mode", label: "位深", kind: "select", options: options(["32", "16", "8"]) },
    {
      key: "method",
      label: "色调方法",
      kind: "select",
      options: [
        { value: "localAdaptation", label: "局部适应" },
        { value: "exposureGamma", label: "曝光和灰度系数" },
        { value: "highlightCompression", label: "高光压缩" },
        { value: "equalizeHistogram", label: "直方图均衡化" }
      ]
    },
    { key: "align", label: "自动对齐源图像", kind: "check", initial: true },
    { key: "removeGhosts", label: "移去重影", kind: "check", initial: true }
  ],
  // ------- U56 画板、框架与切片
  newArtboard: [
    { key: "name", label: "名称", kind: "text", initial: "画板 1" },
    { key: "preset", label: "预设", kind: "text", placeholder: "如 A4、1920×1080" },
    { key: "x", label: "X", kind: "number", initial: 0 },
    { key: "y", label: "Y", kind: "number", initial: 0 },
    { key: "width", label: "宽", kind: "number", min: 1, initial: 320 },
    { key: "height", label: "高", kind: "number", min: 1, initial: 240 },
    {
      key: "background",
      label: "背景",
      kind: "select",
      options: [
        { value: "white", label: "白色" },
        { value: "black", label: "黑色" },
        { value: "transparent", label: "透明" },
        { value: "custom", label: "自定义颜色…" }
      ]
    },
    { key: "color", label: "自定义背景", kind: "color", initial: "#ffffff" },
    { key: "moveContents", label: "移动画板内容", kind: "check", initial: true }
  ],
  artboardFromLayers: [
    { key: "name", label: "名称", kind: "text", placeholder: "默认取图层名" },
    { key: "background", label: "背景", kind: "select", options: options(["white", "black", "transparent", "custom"]) }
  ],
  setArtboard: [
    { key: "name", label: "名称", kind: "text" },
    { key: "x", label: "X", kind: "number" },
    { key: "y", label: "Y", kind: "number" },
    { key: "width", label: "宽", kind: "number", min: 1 },
    { key: "height", label: "高", kind: "number", min: 1 },
    { key: "background", label: "背景", kind: "select", options: options(["white", "black", "transparent", "custom"]) },
    { key: "color", label: "自定义背景", kind: "color" },
    { key: "moveContents", label: "移动画板内容", kind: "check" }
  ],
  newFrame: [
    { key: "name", label: "名称", kind: "text", initial: "框架 1" },
    { key: "shape", label: "形状", kind: "select", initial: "rectangle", options: options(["rectangle", "ellipse"]) },
    { key: "x", label: "X", kind: "number", initial: 0 },
    { key: "y", label: "Y", kind: "number", initial: 0 },
    { key: "width", label: "宽", kind: "number", min: 1, initial: 320 },
    { key: "height", label: "高", kind: "number", min: 1, initial: 240 }
  ],
  frameFromLayers: [
    { key: "name", label: "名称", kind: "text", placeholder: "默认取图层名" }
  ],
  newSlice: [
    { key: "name", label: "名称", kind: "text", initial: "切片 1" },
    {
      key: "kind",
      label: "类型",
      kind: "select",
      initial: "image",
      options: [
        { value: "image", label: "图像" },
        { value: "noImage", label: "无图像" },
        { value: "table", label: "表格" }
      ]
    },
    { key: "x", label: "X", kind: "number", initial: 0 },
    { key: "y", label: "Y", kind: "number", initial: 0 },
    { key: "width", label: "宽", kind: "number", min: 1, initial: 100 },
    { key: "height", label: "高", kind: "number", min: 1, initial: 100 },
    { key: "url", label: "链接", kind: "text", placeholder: "https://…" },
    { key: "alt", label: "替代文本", kind: "text" },
    { key: "background", label: "背景", kind: "text", placeholder: "none 或 #rrggbb" }
  ],
  slicesFromGuides: [
    { key: "name", label: "名称前缀", kind: "text", placeholder: "如 切片" }
  ],
  layerSlice: [
    { key: "name", label: "名称", kind: "text", placeholder: "默认取图层名" },
    { key: "url", label: "链接", kind: "text", placeholder: "https://…" },
    { key: "alt", label: "替代文本", kind: "text" }
  ]
};

/** 该入口的字段表（没有参数时为空数组）。 */
export function workflowFields(id: string): readonly WorkflowField[] {
  return WORKFLOW_FIELDS[id] ?? [];
}

/** 初始值：只收 `initial` 已定义的字段。 */
export function defaultValues(id: string): FieldValues {
  const values: FieldValues = {};
  for (const field of workflowFields(id)) {
    if (field.initial !== undefined) values[field.key] = field.initial;
  }
  return values;
}

/**
 * 能力门：只有内核明确说 `allowed === true` 才可执行。
 *
 * 清单缺失该入口（`undefined`）按未开放处理——不能因为读不到清单就默认放开。
 */
export function isWorkflowEnabled(workflow: { allowed: boolean } | undefined): boolean {
  return workflow?.allowed === true;
}

const number = (values: FieldValues, key: string): number | undefined => {
  const value = values[key];
  if (value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const text = (values: FieldValues, key: string): string | undefined => {
  const value = values[key];
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value;
};
const flag = (values: FieldValues, key: string): boolean | undefined => {
  const value = values[key];
  return typeof value === "boolean" ? value : undefined;
};
/** 分割/移除入口共用：`at` 要么成对给出，要么整体省略。 */
function splitPoint(values: FieldValues, id: string, warp?: unknown): Record<string, unknown> | { error: string } {
  const x = number(values, "atX");
  const y = number(values, "atY");
  if (x === undefined && y === undefined) return warpSplitParams(undefined, warp);
  if (x === undefined || y === undefined) return { error: `${id} 的分割点需要同时给出 X 和 Y` };
  return warpSplitParams([x, y], warp);
}

/**
 * 把表单值编译成内核参数。
 *
 * 只编译该入口**声明过**的字段：界面上的残留状态不会漏进命令参数。
 */
export function compileWorkflow(
  id: string,
  values: FieldValues,
  document?: { width: number; height: number },
  /**
   * 当前正在编辑的变形。`warpGrid`/`splitWarp*` 必须内联拿到它，否则上游只能去读活动智能
   * 对象——普通像素层上一定失败。由调用方（变形会话）提供，编译层不自己存状态。
   */
  warp?: unknown
): Record<string, unknown> | { error: string } {
  switch (id) {
    case "warp": {
      return warpStyleParams({
        style: (text(values, "style") ?? "arc") as WarpStyle,
        bend: number(values, "bend"),
        hDistort: number(values, "hDistort"),
        vDistort: number(values, "vDistort"),
        vertical: flag(values, "vertical")
      });
    }
    case "warpGrid": {
      const size = text(values, "size") ?? "default";
      return warpGridParams(size === "default" ? "default" : Number(size), warp);
    }
    case "splitWarpCrosswise":
    case "splitWarpHorizontally":
    case "splitWarpVertically":
    case "removeWarpSplit":
      return splitPoint(values, id, warp);
    case "fill": {
      const contents = (text(values, "contents") ?? "color") as never;
      return fillParams({
        contents,
        color: text(values, "color"),
        pattern: text(values, "pattern"),
        scale: number(values, "scale"),
        angle: number(values, "angle"),
        mode: text(values, "mode"),
        opacity: number(values, "opacity"),
        preserveTransparency: flag(values, "preserveTransparency")
      });
    }
    case "contentAwareFill": {
      const params: Record<string, unknown> = {};
      for (const key of ["sampling", "colorAdaptation", "rotationAdaptation", "output"] as const) {
        const value = text(values, key);
        if (value !== undefined) params[key] = value;
      }
      const margin = number(values, "margin");
      if (margin !== undefined) {
        if (margin < 0 || margin > 5000) return { error: "边缘扩展必须在 0–5000 像素之间" };
        params.margin = margin;
      }
      const sample = flag(values, "sampleAllLayers");
      if (sample !== undefined) params.sampleAllLayers = sample;
      return params;
    }
    case "contentAwareScale": {
      const params: Record<string, unknown> = {};
      for (const key of ["scaleX", "scaleY", "amount"] as const) {
        const value = number(values, key);
        if (value === undefined) continue;
        const max = key === "amount" ? 100 : 400;
        const min = key === "amount" ? 0 : 1;
        if (value < min || value > max) return { error: `${key} 必须在 ${min}–${max} 之间` };
        params[key] = value;
      }
      if (params.scaleX === undefined && params.scaleY === undefined) return { error: "内容识别缩放至少需要一个方向的百分比" };
      const skin = flag(values, "protectSkinTones");
      if (skin !== undefined) params.protectSkinTones = skin;
      if (document && document.width < 1) return { error: "当前文档没有可用像素" };
      return params;
    }
    case "stroke":
      return strokeParams({
        width: number(values, "width"),
        location: (text(values, "location") ?? "center") as never,
        color: text(values, "color"),
        opacity: number(values, "opacity"),
        mode: text(values, "mode") as never,
        preserveTransparency: flag(values, "preserveTransparency")
      });
    case "fade":
      return fadeParams(number(values, "opacity") ?? 50, text(values, "mode") as never);
    case "autoAlign":
      return autoAlignParams({
        projection: text(values, "projection") as never,
        reference: number(values, "reference"),
        geometricCorrection: flag(values, "geometricCorrection"),
        registration: text(values, "registration") as never
      });
    case "autoBlend":
      return autoBlendParams({
        method: text(values, "method") as never,
        seamlessTones: flag(values, "seamlessTones"),
        haloControl: number(values, "haloControl"),
        depthMap: flag(values, "depthMap")
      });
    case "photomerge":
      return photomergeParams({
        layout: text(values, "layout") as never,
        blend: flag(values, "blend"),
        vignetteRemoval: flag(values, "vignetteRemoval"),
        geometricCorrection: flag(values, "geometricCorrection"),
        contentAwareFill: flag(values, "contentAwareFill"),
        focalLength: number(values, "focalLength")
      });
    case "mergeToHdr": {
      const params: Record<string, unknown> = { useOpenDocuments: true };
      const mode = text(values, "mode");
      if (mode !== undefined) {
        if (!["32", "16", "8"].includes(mode)) return { error: "位深必须是 32|16|8" };
        params.mode = mode;
      }
      const method = text(values, "method");
      if (method !== undefined) {
        if (!["localAdaptation", "exposureGamma", "highlightCompression", "equalizeHistogram"].includes(method)) {
          return { error: "不支持的色调方法" };
        }
        params.method = method;
      }
      for (const key of ["align", "removeGhosts"] as const) {
        const value = flag(values, key);
        if (value !== undefined) params[key] = value;
      }
      return params;
    }
    case "newArtboard":
    case "setArtboard": {
      const rect = rectFields(values, id);
      if ("error" in rect) return rect;
      const params: Record<string, unknown> = rect.frame ? { ...rect.frame } : {};
      const name = text(values, "name");
      if (name !== undefined) params.name = name;
      const preset = text(values, "preset");
      if (preset !== undefined) params.preset = preset;
      const background = text(values, "background");
      if (background !== undefined) {
        if (!["white", "black", "transparent", "custom"].includes(background)) return { error: "不支持的画板背景" };
        params.background = background;
        if (background === "custom") {
          const color = text(values, "color");
          if (color === undefined || !/^#[0-9a-fA-F]{6}$/.test(color)) return { error: "自定义画板背景需要 #rrggbb 颜色" };
          params.color = color;
        }
      }
      const move = flag(values, "moveContents");
      if (move !== undefined) params.moveContents = move;
      if (Object.keys(params).length === 0) return { error: "编辑画板至少需要一项改动" };
      return params;
    }
    case "artboardFromLayers": {
      const params: Record<string, unknown> = {};
      const name = text(values, "name");
      if (name !== undefined) params.name = name;
      const background = text(values, "background");
      if (background !== undefined) {
        if (!["white", "black", "transparent", "custom"].includes(background)) return { error: "不支持的画板背景" };
        params.background = background;
      }
      return params;
    }
    case "newFrame": {
      const rect = rectFields(values, id, { required: true });
      if ("error" in rect) return rect;
      if (!rect.frame) return { error: "新建框架需要给出位置与尺寸" };
      return frameParams({
        ...rect.frame,
        shape: (text(values, "shape") ?? "rectangle") as never,
        name: text(values, "name")
      });
    }
    case "frameFromLayers": {
      const name = text(values, "name");
      return name === undefined ? {} : { name };
    }
    case "newSlice": {
      const rect = rectFields(values, id, { required: true });
      if ("error" in rect) return rect;
      if (!rect.frame) return { error: "新建切片需要给出位置与尺寸" };
      return sliceParams({
        frame: rect.frame,
        name: text(values, "name"),
        kind: text(values, "kind") as never,
        url: text(values, "url"),
        alt: text(values, "alt"),
        background: text(values, "background") as never
      });
    }
    case "slicesFromGuides": {
      const name = text(values, "name");
      return name === undefined ? {} : { name };
    }
    case "layerSlice": {
      const params: Record<string, unknown> = {};
      const name = text(values, "name");
      if (name !== undefined) {
        if (name.length > 200) return { error: "切片名称必须是 1–200 个字符" };
        params.name = name;
      }
      for (const key of ["url", "alt"] as const) {
        const value = text(values, key);
        if (value !== undefined) {
          if (value.length > 1024) return { error: `${key} 超过 1024 个字符` };
          params[key] = value;
        }
      }
      return params;
    }
    // 无参数入口：再次变换、Perspective Warp（专用表单）、Puppet Warp（专用表单）、
    // 裁切拉直、列出切片、宿主交付。
    default:
      return {};
  }
}

export type RectFieldResult = { error: string } | { frame: { x: number; y: number; width: number; height: number } | null };

/**
 * 表单里的 x/y/宽/高：全空时 `frame: null`（按「不改位置尺寸」处理），部分填写要求成对齐全。
 *
 * 用 `{ error }` / `{ frame }` 的判别式而不是「字段可能在也可能不在」的对象：后者在
 * `"error" in value` 收窄下拿不到具体类型，会退化成 `unknown`。
 */
function rectFields(values: FieldValues, id: string, options: { required?: boolean } = {}): RectFieldResult {
  const x = number(values, "x");
  const y = number(values, "y");
  const width = number(values, "width");
  const height = number(values, "height");
  const any = [x, y, width, height].some((value) => value !== undefined);
  if (!any) {
    if (options.required) return { error: `${id} 需要给出位置与尺寸` };
    return { frame: null };
  }
  // 尺寸先判：只给了宽时，用户的信息缺口是「高」，比报位置更贴切。
  if (width === undefined || height === undefined) return { error: `${id} 的尺寸需要同时给出宽和高` };
  if (x === undefined || y === undefined) return { error: `${id} 的位置需要同时给出 X 和 Y` };
  if (width < 1 || height < 1) return { error: `${id} 的宽高至少为 1 像素` };
  return { frame: { x, y, width, height } };
}

// ---------------------------------------------------------------- Puppet Warp 专用表单

export type PuppetPinValues = { srcX: number; srcY: number; dstX: number; dstY: number; rotate?: number };

/**
 * 钉点行 → `puppetWarpParams` 的 `at`/`to`。
 *
 * 旋转 0° 视为「自动」而不是「固定 0°」：上游 `rotate: None` 才是让网格自行求解，
 * 而界面默认值就是 0，若照传会把所有钉点锁成固定朝向。
 */
export function puppetPinOf(pin: PuppetPinValues): { at: [number, number]; to?: [number, number]; rotate?: number } {
  return {
    at: [pin.srcX, pin.srcY],
    to: [pin.dstX, pin.dstY],
    ...(pin.rotate === undefined || pin.rotate === 0 ? {} : { rotate: pin.rotate })
  };
}

/** 预设网格 + 输入法（`warpMeshParams` 的 `rect` 用 `[x0,y0,x1,y1]`）。 */
export function meshParamsFor(mesh: WarpMesh, rect: [number, number, number, number]): Record<string, unknown> | { error: string } {
  return warpMeshParams(mesh, { rect });
}

/** 只暴露表单需要的常量，避免面板自己再写一份枚举。 */
export const FORM_ENUMS = {
  resample: RESAMPLE_METHODS,
  printUnits: PRINT_UNITS,
  projections: PHOTO_LAYOUTS,
  styles: WORKFLOW_FIELDS.warp?.find((field) => field.key === "style")?.options ?? []
} as const;

/** 图像尺寸的字段取值需要按输入法切换（百分比 vs 宽高）。 */
export function imageSizeFields(mode: "pixels" | "percent"): readonly WorkflowField[] {
  return mode === "pixels"
    ? [
        { key: "width", label: "宽", kind: "number", min: 1, unit: "px" },
        { key: "height", label: "高", kind: "number", min: 1, unit: "px" },
        { key: "resolution", label: "分辨率", kind: "number", min: 1, max: 10_000, unit: "ppi", initial: 72 },
        { key: "resample", label: "重采样", kind: "select", initial: "bicubic", options: (RESAMPLE_METHODS as readonly ResampleMethod[]).map((value) => ({ value, label: value })) },
        { key: "keepPrintSize", label: "保持打印尺寸", kind: "check", initial: false }
      ]
    : [
        { key: "percent", label: "百分比", kind: "number", min: 1, max: 1600, unit: "%", initial: 100 },
        { key: "resolution", label: "分辨率", kind: "number", min: 1, max: 10_000, unit: "ppi", initial: 72 },
        { key: "resample", label: "重采样", kind: "select", initial: "bicubic", options: (RESAMPLE_METHODS as readonly ResampleMethod[]).map((value) => ({ value, label: value })) },
        { key: "keepPrintSize", label: "保持打印尺寸", kind: "check", initial: false }
      ];
}

/** 图像尺寸编译：宽高优先，其次百分比；只给一边时另一边按比例（与内核一致）。 */
export function compileImageSize(values: FieldValues): Record<string, unknown> | { error: string } {
  const width = number(values, "width");
  const height = number(values, "height");
  const percent = number(values, "percent");
  if ((width !== undefined || height !== undefined) && percent !== undefined && percent !== 100) {
    return { error: "宽高与百分比不能同时使用" };
  }
  return imageSizeParams({
    width,
    height,
    percent: width === undefined && height === undefined && percent !== undefined && percent !== 100 ? percent : undefined,
    resolution: number(values, "resolution") ?? 72,
    keepPrintSize: flag(values, "keepPrintSize") === true,
    resample: (text(values, "resample") ?? "bicubic") as ResampleMethod
  });
}
