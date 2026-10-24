/**
 * Filter 菜单的滤镜目录与表单（I035）。
 *
 * 固定引擎 `filters.rs` 已经实现这些滤镜命令；本模块只声明每条的**公开参数范围**、默认值与
 * 显示名，并把表单值编译成命令参数。引擎对少数参数做夹紧，因此编辑器在提交前按同一范围
 * 复核，越界值先使表单无效而不是被悄悄改成别的结果。
 *
 * 这里只收「有明确参数契约、可单独提交」的滤镜；Filter Gallery、Camera Raw、液化、
 * 智能滤镜堆栈仍按矩阵保持关闭。
 */

export type FilterField = {
  key: string;
  label: string;
  /** 数值范围；`choices` 存在时是枚举字段。 */
  min?: number;
  max?: number;
  step?: number;
  choices?: readonly (readonly [string, string])[];
  integer?: boolean;
};

export type FilterSpec = {
  id: string;
  label: string;
  group: "模糊" | "锐化" | "杂色" | "像素化" | "风格化" | "扭曲" | "其它";
  fields: readonly FilterField[];
};

const radius = (min: number, max: number): FilterField => ({ key: "radius", label: "半径", min, max, step: 0.1 });

/** 与固定引擎注册表一致的滤镜目录（只有这些命令进入能力白名单）。 */
export const FILTER_SPECS: readonly FilterSpec[] = [
  { id: "filter.blur.gaussianBlur", label: "高斯模糊…", group: "模糊", fields: [radius(0.1, 1000)] },
  { id: "filter.blur.blur", label: "模糊", group: "模糊", fields: [] },
  { id: "filter.blur.blurMore", label: "进一步模糊", group: "模糊", fields: [] },
  { id: "filter.blur.boxBlur", label: "方框模糊…", group: "模糊", fields: [{ key: "radius", label: "半径", min: 1, max: 2000, step: 1 }] },
  { id: "filter.blur.motionBlur", label: "动感模糊…", group: "模糊", fields: [
    { key: "angle", label: "角度", min: -360, max: 360, step: 1 },
    { key: "distance", label: "距离", min: 1, max: 2000, step: 1 }
  ] },
  { id: "filter.blur.surfaceBlur", label: "表面模糊…", group: "模糊", fields: [
    { key: "radius", label: "半径", min: 1, max: 100, step: 1 },
    { key: "threshold", label: "阈值", min: 2, max: 255, step: 1 }
  ] },
  { id: "filter.sharpen.sharpen", label: "锐化", group: "锐化", fields: [] },
  { id: "filter.sharpen.sharpenMore", label: "进一步锐化", group: "锐化", fields: [] },
  { id: "filter.sharpen.sharpenEdges", label: "锐化边缘", group: "锐化", fields: [] },
  { id: "filter.noise.despeckle", label: "去斑", group: "杂色", fields: [] },
  { id: "filter.noise.median", label: "中间值…", group: "杂色", fields: [{ key: "radius", label: "半径", min: 1, max: 500, step: 1 }] },
  { id: "filter.noise.dustAndScratches", label: "蒙尘与划痕…", group: "杂色", fields: [
    { key: "radius", label: "半径", min: 1, max: 500, step: 1 },
    { key: "threshold", label: "阈值", min: 0, max: 255, step: 1 }
  ] },
  { id: "filter.pixelate.mosaic", label: "马赛克…", group: "像素化", fields: [{ key: "cellSize", label: "单元格大小", min: 2, max: 200, step: 1 }] },
  { id: "filter.stylize.emboss", label: "浮雕效果…", group: "风格化", fields: [
    { key: "angle", label: "角度", min: -180, max: 180, step: 1 },
    { key: "height", label: "高度", min: 1, max: 100, step: 1 },
    { key: "amount", label: "数量", min: 1, max: 500, step: 1 }
  ] },
  { id: "filter.stylize.findEdges", label: "查找边缘", group: "风格化", fields: [] },
  { id: "filter.stylize.solarize", label: "曝光过度", group: "风格化", fields: [] },
  { id: "filter.distort.twirl", label: "旋转扭曲…", group: "扭曲", fields: [{ key: "angle", label: "角度", min: -999, max: 999, step: 1 }] },
  { id: "filter.distort.pinch", label: "挤压…", group: "扭曲", fields: [{ key: "amount", label: "数量", min: -100, max: 100, step: 1 }] },
  { id: "filter.distort.spherize", label: "球面化…", group: "扭曲", fields: [
    { key: "amount", label: "数量", min: -100, max: 100, step: 1 },
    { key: "mode", label: "模式", choices: [["normal", "正常"], ["horizontalOnly", "仅水平"], ["verticalOnly", "仅垂直"]] }
  ] },
  { id: "filter.distort.ripple", label: "波纹…", group: "扭曲", fields: [
    { key: "amount", label: "数量", min: -999, max: 999, step: 1 },
    { key: "size", label: "大小", choices: [["small", "小"], ["medium", "中"], ["large", "大"]] }
  ] },
  { id: "filter.distort.polarCoordinates", label: "极坐标…", group: "扭曲", fields: [
    { key: "mode", label: "模式", choices: [["rectangularToPolar", "平面坐标到极坐标"], ["polarToRectangular", "极坐标到平面坐标"]] }
  ] },
  { id: "filter.other.highPass", label: "高反差保留…", group: "其它", fields: [radius(0.1, 1000)] },
  { id: "filter.other.minimum", label: "最小值…", group: "其它", fields: [
    { key: "radius", label: "半径", min: 0.2, max: 500, step: 0.1 },
    { key: "preserve", label: "保留", choices: [["squareness", "方形"], ["roundness", "圆度"]] }
  ] },
  { id: "filter.other.maximum", label: "最大值…", group: "其它", fields: [
    { key: "radius", label: "半径", min: 0.2, max: 500, step: 0.1 },
    { key: "preserve", label: "保留", choices: [["squareness", "方形"], ["roundness", "圆度"]] }
  ] }
] as const;

export const FILTER_GROUPS: readonly FilterSpec["group"][] = ["模糊", "锐化", "杂色", "像素化", "风格化", "扭曲", "其它"];

export function filterSpec(id: string): FilterSpec | null {
  return FILTER_SPECS.find(spec => spec.id === id) ?? null;
}

/** 每个字段的默认值（引擎注册表里的默认）。 */
export function filterDefaults(spec: FilterSpec): Record<string, number | string> {
  const values: Record<string, number | string> = {};
  for (const field of spec.fields) {
    if (field.choices) values[field.key] = field.choices[0]![0];
    else values[field.key] = field.min ?? 0;
  }
  // 注册表默认并非一律取最小；按原生默认值覆盖。
  const native: Record<string, number> = {
    "filter.blur.gaussianBlur": 1, "filter.blur.boxBlur": 1, "filter.blur.motionBlur": 10,
    "filter.blur.surfaceBlur": 5, "filter.noise.median": 1, "filter.noise.dustAndScratches": 1,
    "filter.pixelate.mosaic": 10, "filter.stylize.emboss": 135, "filter.distort.twirl": 50,
    "filter.distort.pinch": 50, "filter.distort.spherize": 100, "filter.distort.ripple": 100,
    "filter.other.highPass": 10, "filter.other.minimum": 1, "filter.other.maximum": 1
  };
  const defaults = native[spec.id];
  if (defaults !== undefined) {
    const key = spec.group === "像素化" ? "cellSize" : spec.id === "filter.stylize.emboss" ? "angle" : "radius";
    if (spec.id === "filter.blur.surfaceBlur") values.radius = defaults;
    else if (spec.id === "filter.distort.twirl" || spec.id === "filter.distort.pinch" || spec.id === "filter.distort.spherize" || spec.id === "filter.distort.ripple") values.amount = defaults;
    else if (spec.id === "filter.stylize.emboss") { values.angle = defaults; values.height = 3; values.amount = 100; }
    else if (spec.id === "filter.blur.motionBlur") { values.angle = 0; values.distance = defaults; }
    else if (spec.id === "filter.noise.dustAndScratches") { values.radius = defaults; values.threshold = 0; }
    else values[key] = defaults;
  }
  return values;
}

/**
 * 严格校验并按原生范围编译参数；越界、缺字段或类型不符返回错误原因（不静默夹紧）。
 */
export function buildFilter(spec: FilterSpec, values: Readonly<Record<string, unknown>>): { ok: true; params: Record<string, unknown> } | { ok: false; reason: string } {
  const params: Record<string, unknown> = {};
  for (const field of spec.fields) {
    const raw = values[field.key];
    if (field.choices) {
      const chosen = typeof raw === "string" && field.choices.some(([id]) => id === raw) ? raw : null;
      if (chosen === null) return { ok: false, reason: `${field.label}无效` };
      params[field.key] = chosen;
      continue;
    }
    const number = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (!Number.isFinite(number)) return { ok: false, reason: `${field.label}必须是数值` };
    if (field.integer && !Number.isInteger(number)) return { ok: false, reason: `${field.label}必须是整数` };
    if (field.min !== undefined && number < field.min) return { ok: false, reason: `${field.label}不能小于 ${field.min}` };
    if (field.max !== undefined && number > field.max) return { ok: false, reason: `${field.label}不能大于 ${field.max}` };
    params[field.key] = number;
  }
  return { ok: true, params };
}
