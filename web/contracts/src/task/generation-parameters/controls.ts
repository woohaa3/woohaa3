/**
 * 参数最大集合：**有限、可穷举**的预设控件。
 *
 * 每个控件声明三件事：稳定的语义键（也是 schema 的属性名）、前端该用哪种控件渲染、
 * 以及把「类型预设 + 卡片收窄」的选项装配成 schema 属性。
 *
 * 加控件前先确认它真的是跨模型的语义：只服务一个 Provider 的键应该留在那个 Provider 里，
 * 不进这里——否则集合会退化成各厂商字段的并集，前端又要开始按 key 名猜。
 */
import { aspectRatioField, resolutionField, semanticSelectField } from "../parameter-schema.js";

/** 控件种类：决定前端用哪种控件渲染，也决定数值 / 枚举的读取方式。 */
export type ParameterControlKind =
  | "textarea"
  | "upload"
  | "enum"
  | "number"
  | "integer"
  | "boolean"
  | "aspect-ratio"
  | "resolution"
  | "quality";

export type ParameterControlSpec = {
  /** 语义键，同时是 schema 的属性名。 */
  key: string;
  /** 分组，仅用于展示（不参与渲染决策）。 */
  group: "通用" | "视频" | "图片" | "音频" | "遗留";
  /** 人读的控件名。 */
  label: string;
  control: ParameterControlKind;
  /** 由类型预设 + 卡片收窄给出的选项装配成 schema 属性。 */
  build: (options: Record<string, unknown>) => Record<string, unknown>;
};

/** 面板自己承载、不进参数表的键（提示词与参考素材由面板的插槽渲染）。 */
export const PANEL_OWNED_KEYS: readonly string[] = [
  "prompt",
  "referencesImage",
  "referencesVideo",
  "referencesAudio"
];

function selectOption(value: string, label: string): { value: string; label: string } {
  return { value, label };
}

function enumValues(options: Record<string, unknown>): string[] {
  return Array.isArray(options.values)
    ? options.values.filter((value): value is string => typeof value === "string")
    : [];
}

/**
 * 枚举取值，支持 `{ value, label }`。
 *
 * 音色需要人读名称（`male-qn-qingse` → 青涩青年音色），但值是上游 id；其它控件仍然
 * 只接受裸字符串，保持原行为。
 */
function labeledEnumValues(options: Record<string, unknown>): Array<{ value: string; label: string }> {
  const raw = Array.isArray(options.values) ? options.values : [];
  const out: Array<{ value: string; label: string }> = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      out.push(selectOption(entry, entry));
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.value !== "string") continue;
    out.push(selectOption(record.value, typeof record.label === "string" ? record.label : record.value));
  }
  return out;
}

function hiddenWhenOf(options: Record<string, unknown>): Record<string, unknown> | undefined {
  return options.hiddenWhen === undefined ? undefined : options;
}

function referenceControl(
  key: string,
  title: string,
  semantic: "reference-image" | "reference-video" | "reference-audio"
): ParameterControlSpec {
  return {
    key,
    group: "通用",
    label: "素材数组",
    control: "upload",
    build: (options) => ({
      type: "array",
      title,
      maxItems: typeof options.max === "number" ? options.max : 1,
      "x-pptask-semantic": semantic,
      "x-component": "Upload"
    })
  };
}

export const PARAMETER_CONTROLS: readonly ParameterControlSpec[] = [
  {
    key: "prompt",
    group: "通用",
    label: "文本域",
    control: "textarea",
    build: () => ({ type: "string", title: "提示词", "x-component": "Input.TextArea" })
  },
  referenceControl("referencesImage", "参考图", "reference-image"),
  referenceControl("referencesVideo", "参考视频", "reference-video"),
  referenceControl("referencesAudio", "参考音频", "reference-audio"),
  {
    key: "aspectRatio",
    group: "通用",
    label: "语义·比例",
    control: "aspect-ratio",
    build: (options) =>
      aspectRatioField({
        ratios: enumValues(options),
        ...(typeof options.default === "string" ? { fallback: options.default } : {}),
        ...(options.adaptive === true ? { adaptive: true } : {}),
        ...(hiddenWhenOf(options) ? { hiddenWhen: options.hiddenWhen as never } : {})
      })
  },
  {
    key: "resolution",
    group: "通用",
    label: "语义·分辨率",
    control: "resolution",
    build: (options) =>
      resolutionField({
        tiers: enumValues(options),
        ...(typeof options.default === "string" ? { fallback: options.default } : {}),
        title: typeof options.title === "string" ? options.title : "分辨率",
        ...(hiddenWhenOf(options) ? { hiddenWhen: options.hiddenWhen as never } : {})
      })
  },
  {
    key: "quality",
    group: "图片",
    label: "语义·质量",
    control: "quality",
    build: (options) => ({
      type: "string",
      title: "质量",
      default: options.default,
      "x-component": "Select",
      "x-pptask-control": "quality",
      enum: enumValues(options).map((value) => selectOption(value, value))
    })
  },
  {
    key: "voice",
    group: "音频",
    label: "枚举",
    control: "enum",
    build: (options) => {
      const values = labeledEnumValues(options);
      // 没有卡片收窄时保持自由文本：上游音色 id 不是一套跨厂商的枚举，写死一份只会很快过期。
      // 有值时才声明 `voice` 语义，前端据此渲染可选项（而不是一长排分段按钮）。
      if (values.length === 0) {
        return { type: "string", title: "音色", default: options.default };
      }
      return semanticSelectField({
        control: "voice",
        title: "音色",
        ...(typeof options.default === "string" ? { fallback: options.default } : {}),
        options: values
      });
    }
  },
  {
    key: "speed",
    group: "音频",
    label: "数值",
    control: "number",
    build: (options) => ({
      type: "number",
      title: "语速",
      default: options.default,
      minimum: options.minimum,
      maximum: options.maximum,
      step: options.step
    })
  },
  {
    key: "n",
    group: "图片",
    label: "数量",
    control: "number",
    build: (options) => ({
      type: "number",
      title: "数量",
      default: options.default,
      minimum: 1,
      maximum: options.maximum,
      step: 1,
      "x-component": "NumberPicker"
    })
  },
  {
    key: "background",
    group: "图片",
    label: "枚举",
    control: "enum",
    build: (options) => ({
      type: "string",
      title: "背景",
      default: options.default,
      enum: enumValues(options).map((value) => selectOption(value, value))
    })
  },
  {
    key: "outputFormat",
    group: "通用",
    label: "枚举",
    control: "enum",
    build: (options) => ({
      type: "string",
      title: "输出格式",
      default: options.default,
      enum: enumValues(options).map((value) => selectOption(value, value.toUpperCase()))
    })
  },
  {
    key: "generationMode",
    group: "视频",
    label: "枚举",
    control: "enum",
    build: (options) => ({
      type: "string",
      title: "模式",
      default: options.default,
      enum: options.enum
    })
  },
  {
    key: "durationSeconds",
    group: "视频",
    label: "数值",
    control: "number",
    build: (options) => {
      const schema: Record<string, unknown> = {
        type: "number",
        title: typeof options.title === "string" ? options.title : "时长",
        default: options.default,
        minimum: options.minimum,
        maximum: options.maximum,
        step: 1,
        unit: "秒"
      };
      if (options.hiddenWhen !== undefined) schema["x-hidden-when"] = options.hiddenWhen;
      return schema;
    }
  },
  {
    key: "generateAudio",
    group: "视频",
    label: "布尔",
    control: "boolean",
    build: (options) => ({
      type: "boolean",
      title: "生成音频",
      default: options.default !== false,
      "x-component": "Switch"
    })
  },
  {
    key: "seed",
    group: "视频",
    label: "整数",
    control: "integer",
    build: () => ({ type: "integer", title: "随机种子", "x-component": "NumberPicker" })
  },
  {
    key: "cameraFixed",
    group: "视频",
    label: "布尔",
    control: "boolean",
    build: () => ({ type: "boolean", title: "固定镜头", default: false })
  },
  {
    key: "returnLastFrame",
    group: "视频",
    label: "布尔",
    control: "boolean",
    build: () => ({ type: "boolean", title: "返回尾帧", default: false })
  },
  {
    key: "seconds",
    group: "遗留",
    label: "遗留·文本",
    control: "textarea",
    build: () => ({ type: "string", title: "时长（秒）", default: "4" })
  },
  {
    key: "size",
    group: "遗留",
    label: "遗留·文本",
    control: "textarea",
    build: () => ({ type: "string", title: "分辨率", default: "720p" })
  }
];

/** 语义键 → 控件。组合时按它把选项装配成 schema 属性。 */
export const CONTROL_BY_KEY: ReadonlyMap<string, ParameterControlSpec> = new Map(
  PARAMETER_CONTROLS.map((control) => [control.key, control])
);
