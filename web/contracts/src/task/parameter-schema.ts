/**
 * 生成参数语义。
 *
 * Provider 的 `inputSchema` 除了 JSON Schema 约束，还可以声明「这个字段应该被人类怎么选」：
 *
 * - `x-pptask-control: "aspect-ratio"`：比例选择（可带一个 `x-pptask-adaptive: true` 的
 *   「自适应」选项）；
 * - `x-pptask-control: "resolution"`：分辨率档位；
 * - `x-pptask-control: "quality"`：质量档位。
 *
 * 前端按语义渲染统一控件（比例图标网格、分辨率分段等），Provider 只声明自己的取值域与
 * 默认值；请求字段映射仍留在 Provider（原生 `aspect_ratio`、像素 `size`、预设档位各不相同）。
 * 未声明的字段继续走普通 select/number，动态 Provider（fal/replicate 等）不受影响。
 *
 * 这些常量与 builder 放在 contracts：Provider（后端扩展）与前端投影都需要同一套词汇，
 * 避免前后端各自识别 key 名（`size` / `aspectRatio` / `imageSize`）或枚举形态。
 */

/** inputSchema 扩展关键字：参数控件语义。 */
export const PPTASK_PARAMETER_CONTROL = "x-pptask-control";

/** enum 选项标记：该项代表「自适应」。 */
export const PPTASK_PARAMETER_ADAPTIVE = "x-pptask-adaptive";

/**
 * enum 选项标记：选中该项时**强制**另一个字段取某个值（联动约束）。
 *
 * 为什么需要它：有些参数单独看是合法的，组合起来才会被上游拒绝。典型是 OpenAI 的透明背景
 * ——`background: transparent` 要求 `output_format: png`，选 jpeg 会 400。把这条规则
 * 声明在枚举项上，面板就能「选透明 → 格式自动切成 PNG 并锁住」，而不是等提交后才报错。
 *
 * 形状：`{ [field]: value }`，可多个。前端只做**改写 + 锁定展示**，真正的校验仍在
 * Provider / 服务端——声明是「推荐组合」，不是唯一真相。
 */
export const PPTASK_PARAMETER_REQUIRES = "x-pptask-requires";

/** 联动约束：某字段被强制为某值。 */
export type PptaskParameterRequirement = Record<string, string | number | boolean>;

export function isPptaskParameterRequirement(value: unknown): value is PptaskParameterRequirement {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (entry) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"
  );
}

/** 从枚举项上读出联动约束；没有声明时返回 undefined。 */
export function requirementOfOption(option: unknown): PptaskParameterRequirement | undefined {
  if (typeof option !== "object" || option === null || Array.isArray(option)) return undefined;
  const declared = (option as Record<string, unknown>)[PPTASK_PARAMETER_REQUIRES];
  return isPptaskParameterRequirement(declared) ? declared : undefined;
}

/** 语义控件种类。 */
export type PptaskParameterControl = "aspect-ratio" | "resolution" | "quality" | "background";

const PARAMETER_CONTROLS: readonly PptaskParameterControl[] = [
  "aspect-ratio",
  "resolution",
  "quality",
  "background"
];

export function isPptaskParameterControl(value: unknown): value is PptaskParameterControl {
  return typeof value === "string" && (PARAMETER_CONTROLS as readonly string[]).includes(value);
}

/** 自适应比例的标准取值与标签（Provider 可覆盖，但默认用这套）。 */
export const ADAPTIVE_PARAMETER_VALUE = "auto";
export const ADAPTIVE_PARAMETER_LABEL = "自适应";

/** 比例控件的常用画幅优先顺序（UI 4 列网格前 5 个）。 */
export const PREFERRED_ASPECT_RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9"] as const;

export type ParameterSelectOption = {
  value: string;
  label: string;
  /** 选中该项时强制的其它字段值（`x-pptask-requires`）。 */
  requires?: PptaskParameterRequirement;
};

export type ParameterHiddenWhenRule = {
  field: string;
  equals: string | number | boolean;
};

export type SemanticSelectFieldOptions = {
  control: PptaskParameterControl;
  title: string;
  /** 缺省不写入 `default`（Provider 没有默认值时由面板留空）。 */
  fallback?: string;
  options: readonly (string | ParameterSelectOption)[];
  /** 追加一个「自适应」选项；false / 缺省不追加。 */
  adaptive?: boolean | { value?: string; label?: string };
  hiddenWhen?: readonly ParameterHiddenWhenRule[];
};

/**
 * 带语义的选择字段。所有 builder 的公共落点：
 * - `enum` 支持字符串或 `{ value, label }`，统一转成对象；
 * - `x-pptask-control` 声明 UI 控件；
 * - `x-pptask-adaptive` 只标在自适应选项上，前端无需猜 `auto` / `adaptive`。
 */
export function semanticSelectField(options: SemanticSelectFieldOptions): Record<string, unknown> {
  const adaptive = normalizeAdaptive(options.adaptive);
  const enumValues: Array<ParameterSelectOption & Record<string, unknown>> = [
    ...(adaptive ? [{ ...adaptive, [PPTASK_PARAMETER_ADAPTIVE]: true }] : []),
    ...options.options.map((entry) =>
      typeof entry === "string"
        ? { value: entry, label: entry }
        : {
            value: entry.value,
            label: entry.label,
            ...(entry.requires !== undefined ? { [PPTASK_PARAMETER_REQUIRES]: entry.requires } : {}),
          }
    ),
  ];
  return {
    type: "string",
    title: options.title,
    ...(options.fallback !== undefined ? { default: options.fallback } : {}),
    "x-component": "Select",
    [PPTASK_PARAMETER_CONTROL]: options.control,
    enum: enumValues,
    ...(options.hiddenWhen && options.hiddenWhen.length > 0 ? { "x-hidden-when": options.hiddenWhen.map((rule) => ({ ...rule })) } : {}),
  };
}

export type AspectRatioFieldOptions = {
  ratios: readonly string[];
  /** 默认选中；缺省为自适应值（有自适应时）或第一个比例。 */
  fallback?: string;
  /** 追加「自适应」；默认不追加，Provider 明确支持省略比例时再打开。 */
  adaptive?: boolean | { value?: string; label?: string };
  title?: string;
  hiddenWhen?: readonly ParameterHiddenWhenRule[];
};

export function aspectRatioField(options: AspectRatioFieldOptions): Record<string, unknown> {
  return semanticSelectField({
    control: "aspect-ratio",
    title: options.title ?? "比例",
    fallback: options.fallback,
    options: options.ratios,
    adaptive: options.adaptive,
    hiddenWhen: options.hiddenWhen,
  });
}

export type ResolutionFieldOptions = {
  tiers: readonly string[];
  fallback?: string;
  title?: string;
  hiddenWhen?: readonly ParameterHiddenWhenRule[];
};

export function resolutionField(options: ResolutionFieldOptions): Record<string, unknown> {
  return semanticSelectField({
    control: "resolution",
    title: options.title ?? "分辨率",
    fallback: options.fallback,
    options: options.tiers,
    hiddenWhen: options.hiddenWhen,
  });
}

export type QualityFieldOptions = {
  levels: readonly (string | ParameterSelectOption)[];
  fallback?: string;
  title?: string;
  hiddenWhen?: readonly ParameterHiddenWhenRule[];
};

export function qualityField(options: QualityFieldOptions): Record<string, unknown> {
  return semanticSelectField({
    control: "quality",
    title: options.title ?? "质量",
    fallback: options.fallback,
    options: options.levels,
    hiddenWhen: options.hiddenWhen,
  });
}

export type BackgroundFieldOptions = {
  /** 可选背景值；缺省是 `auto` / `transparent` / `opaque`。 */
  values?: readonly (string | ParameterSelectOption)[];
  fallback?: string;
  title?: string;
  hiddenWhen?: readonly ParameterHiddenWhenRule[];
};

/**
 * 背景字段（透明背景）。
 *
 * 透明不是独立能力：OpenAI 的 `background: transparent` 要求 `output_format: png`
 * （Azure 文档「Transparency」一节：set `background` to `transparent` and `output_format`
 * to `PNG`）。所以透明选项上挂一条 `requires: { outputFormat: "png" }`，面板选它就把
 * 格式切到 PNG；反过来没依赖格式时不会乱锁。
 */
export function backgroundField(options: BackgroundFieldOptions = {}): Record<string, unknown> {
  const values = options.values ?? ["auto", "transparent", "opaque"];
  return semanticSelectField({
    control: "background",
    title: options.title ?? "背景",
    ...(options.fallback !== undefined ? { fallback: options.fallback } : {}),
    options: values,
    ...(options.hiddenWhen ? { hiddenWhen: options.hiddenWhen } : {})
  });
}

/**
 * 比例 + 分辨率 → 像素尺寸（`ratio -> tier -> "宽x高"` 表格）。
 *
 * 给仍以像素 `size` 调上游的 Provider 复用（如 GPT Image / TokenHub 一类）；
 * 表格由 Provider 自己声明，因为各家真实可接受的像素集合不同。
 */
export function resolvePixelSize(options: {
  table: Readonly<Record<string, Readonly<Record<string, string>>>>;
  aspectRatio?: unknown;
  resolution?: unknown;
  fallback: string;
}): string {
  const ratio = typeof options.aspectRatio === "string" && options.aspectRatio.trim() !== ""
    ? options.aspectRatio.trim()
    : "";
  const resolution = typeof options.resolution === "string" && options.resolution.trim() !== ""
    ? options.resolution.trim()
    : "";
  const tiers = ratio === "" ? undefined : options.table[ratio];
  if (!tiers || resolution === "") return options.fallback;
  return tiers[resolution] ?? options.fallback;
}

/** 从 enum 声明里找「自适应」选项（投影/测试共用，避免重复判值）。 */
export function findAdaptiveOption(
  enumValues: unknown,
): { value: string; label: string } | undefined {
  if (!Array.isArray(enumValues)) return undefined;
  for (const entry of enumValues) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (record[PPTASK_PARAMETER_ADAPTIVE] !== true) continue;
    const value = typeof record.value === "string" ? record.value : undefined;
    if (!value) continue;
    return { value, label: typeof record.label === "string" ? record.label : value };
  }
  return undefined;
}

const ADAPTIVE_VALUES = new Set(["auto", "adaptive"]);
const RESOLUTION_VALUE = /^\d+(?:\.\d+)?[kp]$/i;
const QUALITY_VALUES = new Set([
  "auto", "low", "medium", "high", "xhigh", "max", "standard", "hd", "highest", "lowest",
]);

export function isAdaptiveParameterValue(value: string): boolean {
  return ADAPTIVE_VALUES.has(value.trim().toLowerCase());
}

export function isAspectRatioValue(value: string): boolean {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value.trim());
  return match !== null && Number(match[1]) > 0 && Number(match[2]) > 0;
}

/**
 * 按上游参数名 + 枚举取值推断参数语义。
 *
 * 动态 Provider（fal / replicate 等把上游 OpenAPI 直接投影成表单的插件）拿不到模型家族
 * 信息，但参数名与取值通常足够明确：`aspect_ratio: ["auto","16:9",…]`、
 * `resolution: ["512P","768P"]`、`quality: ["low","high"]`。这里只在**名字和取值都明确**
 * 时返回，避免把 `image_size: ["square_hd","portrait_4_3"]` 这类模型专有预设误当分辨率。
 */
export function inferParameterControl(
  name: string,
  values: readonly string[],
): PptaskParameterControl | undefined {
  if (values.length < 2) return undefined;
  const normalized = name.trim().toLowerCase();
  const all = values.map((value) => value.trim());
  if (normalized === "ratio" || /(^|[_-])aspect([_-]?ratio)?$/.test(normalized)) {
    const ratios = all.filter((value) => isAspectRatioValue(value));
    const adaptive = all.filter((value) => isAdaptiveParameterValue(value));
    return ratios.length >= 2 && ratios.length + adaptive.length === all.length
      ? "aspect-ratio"
      : undefined;
  }
  if (["resolution", "image_size", "imagesize", "size"].includes(normalized)) {
    return all.every((value) => RESOLUTION_VALUE.test(value)) ? "resolution" : undefined;
  }
  if (["quality", "quality_level", "qualitylevel"].includes(normalized)) {
    return all.every((value) => QUALITY_VALUES.has(value.toLowerCase())) ? "quality" : undefined;
  }
  return undefined;
}

function normalizeAdaptive(
  adaptive: boolean | { value?: string; label?: string } | undefined,
): { value: string; label: string } | undefined {
  if (!adaptive) return undefined;
  if (adaptive === true) return { value: ADAPTIVE_PARAMETER_VALUE, label: ADAPTIVE_PARAMETER_LABEL };
  return {
    value: adaptive.value ?? ADAPTIVE_PARAMETER_VALUE,
    label: adaptive.label ?? ADAPTIVE_PARAMETER_LABEL,
  };
}
