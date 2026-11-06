/**
 * 模型参数提交门禁（change: 2026-11-06-guard-video-generation-inputs）。
 *
 * 视频模型（例如 `agnes-video-2.5`）由 Provider / 服务端用自己的 schema 描述必填项、
 * 默认值与允许值。过去这些约束只有执行面板在 UI 层检查，Host 的 submit facade 与服务端
 * 仍会把空值/越界值发给 Provider，最后只得到一句英文上游错误。
 *
 * 这里把「按 schema 解析默认值 + 校验」收敛成**一份纯函数**，前端 Host 与 Canvas/Task
 * 都调用它：缺字段、值不在允许集合、数值越界都返回可展示的中文原因，默认值则直接进入
 * 提交快照。schema 缺失时视频模型按显式配置错误处理，不静默放行。
 */

export type ModelParameterSchemaSource = {
  /** 缺省按非视频处理（只有视频模型强制要求参数 schema）。 */
  modelType?: string;
  inputSchema?: Record<string, unknown> | null;
  defaultInput?: Record<string, unknown> | null;
};

export type ModelParameterIssueKind =
  | "missing-schema"
  | "missing"
  | "not-allowed"
  | "below-minimum"
  | "above-maximum"
  | "invalid-type";

export type ModelParameterIssue = {
  field: string;
  label: string;
  kind: ModelParameterIssueKind;
  /** 可直接展示给用户的行动提示（含字段名与允许范围）。 */
  message: string;
  allowed?: readonly string[];
  minimum?: number;
  maximum?: number;
  unit?: string;
};

export type ModelParameterResolution = {
  /** 已并入模型默认值的提交参数（不含 prompt）。 */
  parameters: Record<string, unknown>;
  issues: ModelParameterIssue[];
  /** schema 是否声明了任何可校验属性。 */
  hasSchema: boolean;
};

/**
 * 语义键的兜底中文名。
 *
 * schema `title` 优先；Provider 没写 title 时至少不要把这些常见视频参数展示成英文键名。
 */
const PARAMETER_LABELS: Readonly<Record<string, string>> = {
  prompt: "提示词",
  aspectRatio: "宽高比",
  resolution: "分辨率",
  durationSeconds: "时长",
  duration: "时长",
  seconds: "时长",
  size: "尺寸",
  generationMode: "生成模式"
};

export type ResolveModelParametersOptions = {
  /** 当前 prompt；参与 required 校验，但不会写进返回的 parameters。 */
  prompt?: string | null;
  /** 调用方已单独负责的必填字段（例：Host 的 prompt 有上游文字兜底规则）。 */
  skipRequired?: readonly string[];
};

/**
 * 按模型 schema 解析默认值并校验参数。
 *
 * - 默认值顺序与面板一致：schema `default` 优先，其次 `defaultInput`；
 * - 显式值覆盖默认值；`undefined` / `null` / 空串视为未提供；
 * - `x-hidden-when` 命中的字段不参与必填与值域校验（与面板隐藏联动一致）；
 * - 只校验 schema 顶层属性，未知键原样保留（Provider 可能接受扩展参数）。
 */
export function resolveModelParameters(
  source: ModelParameterSchemaSource,
  parameters: Record<string, unknown> | null | undefined,
  options: ResolveModelParametersOptions = {}
): ModelParameterResolution {
  const inputSchema = isRecord(source.inputSchema) ? source.inputSchema : {};
  const properties = isRecord(inputSchema.properties) ? inputSchema.properties : {};
  const defaultInput = isRecord(source.defaultInput) ? source.defaultInput : {};
  const hasSchema = Object.keys(properties).length > 0;
  const issues: ModelParameterIssue[] = [];

  if (!hasSchema) {
    if (source.modelType === "video") {
      issues.push({
        field: "(schema)",
        label: "参数 schema",
        kind: "missing-schema",
        message: "该视频模型没有声明参数 schema，暂时无法提交；请重新加载模型目录或联系模型提供方"
      });
    }
    return { parameters: { ...(parameters ?? {}) }, issues, hasSchema };
  }

  const merged: Record<string, unknown> = {};
  for (const [key, rawSchema] of Object.entries(properties)) {
    if (key === "prompt") continue;
    const schema = isRecord(rawSchema) ? rawSchema : undefined;
    if (!schema) continue;
    const fallback = schema.default !== undefined ? schema.default : defaultInput[key];
    if (fallback !== undefined && fallback !== null) merged[key] = fallback;
  }
  for (const [key, value] of Object.entries(parameters ?? {})) {
    if (key === "prompt") continue;
    if (value === undefined || value === null || value === "") continue;
    merged[key] = value;
  }

  const skip = new Set(options.skipRequired ?? []);
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((key): key is string => typeof key === "string")
    : [];

  for (const key of required) {
    if (skip.has(key) || isHidden(key, properties, merged)) continue;
    if (key === "prompt") {
      if (typeof options.prompt !== "string" || options.prompt.trim() === "") {
        issues.push(missingIssue(key, undefined));
      }
      continue;
    }
    const schema = isRecord(properties[key]) ? (properties[key] as Record<string, unknown>) : undefined;
    if (!schema) continue;
    if (merged[key] === undefined) issues.push(missingIssue(key, schema));
  }

  for (const [key, rawSchema] of Object.entries(properties)) {
    if (key === "prompt") continue;
    const schema = isRecord(rawSchema) ? rawSchema : undefined;
    if (!schema) continue;
    if (isHidden(key, properties, merged)) continue;
    const value = merged[key];
    if (value === undefined) continue;
    validateField(key, schema, value, issues);
  }

  return { parameters: merged, issues, hasSchema };
}

/** 阻止原因数组（前端 Host 直接用；空数组表示可以提交）。 */
export function modelParameterBlockingReasons(
  source: ModelParameterSchemaSource,
  parameters: Record<string, unknown> | null | undefined,
  options: ResolveModelParametersOptions = {}
): string[] {
  return unique(resolveModelParameters(source, parameters, options).issues.map((issue) => issue.message));
}

/** 解析后的提交参数（并入默认值；调用方仍应先用 `issues` 拒绝非法输入）。 */
export function resolveModelSubmissionParameters(
  source: ModelParameterSchemaSource,
  parameters: Record<string, unknown> | null | undefined,
  options: ResolveModelParametersOptions = {}
): Record<string, unknown> {
  return resolveModelParameters(source, parameters, options).parameters;
}

function validateField(
  key: string,
  schema: Record<string, unknown>,
  value: unknown,
  issues: ModelParameterIssue[]
): void {
  const label = labelOf(key, schema);
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type !== undefined && !matchesType(value, type)) {
    issues.push({
      field: key,
      label,
      kind: "invalid-type",
      message: `${label}应为 ${typeLabel(type)}，当前为「${String(value)}」`
    });
    return;
  }

  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (enumValues !== undefined && enumValues.length > 0 && !enumValues.some((entry) => enumMatches(entry, value))) {
    const allowed = enumValues.flatMap((entry) => {
      const option = optionOf(entry);
      return option === undefined ? [] : [option.label];
    });
    issues.push({
      field: key,
      label,
      kind: "not-allowed",
      message: allowed.length > 0
        ? `${label}只支持 ${allowed.join("、")}，当前为「${String(value)}」`
        : `${label}不在允许的取值范围内，当前为「${String(value)}」`,
      ...(allowed.length > 0 ? { allowed } : {})
    });
    return;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) return;
  const unit = typeof schema.unit === "string" ? schema.unit : "";
  const minimum = typeof schema.minimum === "number" && Number.isFinite(schema.minimum)
    ? schema.minimum
    : undefined;
  const maximum = typeof schema.maximum === "number" && Number.isFinite(schema.maximum)
    ? schema.maximum
    : undefined;
  if (minimum !== undefined && value < minimum) {
    issues.push({
      field: key,
      label,
      kind: "below-minimum",
      message: `${label}不能小于 ${minimum}${unit}，当前为 ${value}${unit}`,
      minimum,
      ...(maximum !== undefined ? { maximum } : {}),
      ...(unit !== "" ? { unit } : {})
    });
  } else if (maximum !== undefined && value > maximum) {
    issues.push({
      field: key,
      label,
      kind: "above-maximum",
      message: `${label}不能大于 ${maximum}${unit}，当前为 ${value}${unit}`,
      ...(minimum !== undefined ? { minimum } : {}),
      maximum,
      ...(unit !== "" ? { unit } : {})
    });
  }
}

function missingIssue(key: string, schema: Record<string, unknown> | undefined): ModelParameterIssue {
  const label = schema === undefined ? PARAMETER_LABELS[key] ?? key : labelOf(key, schema);
  return {
    field: key,
    label,
    kind: "missing",
    message: `缺少必填参数「${label}」（${key}）`
  };
}

function labelOf(key: string, schema: Record<string, unknown>): string {
  return typeof schema.title === "string" && schema.title.trim() !== ""
    ? schema.title
    : PARAMETER_LABELS[key] ?? key;
}

function isHidden(
  key: string,
  properties: Record<string, unknown>,
  parameters: Record<string, unknown>
): boolean {
  const schema = isRecord(properties[key]) ? properties[key] : undefined;
  const rules = schema && Array.isArray(schema["x-hidden-when"]) ? schema["x-hidden-when"] : [];
  return rules.some((entry) => {
    if (!isRecord(entry)) return false;
    return typeof entry.field === "string" && parameters[entry.field] === entry.equals;
  });
}

function optionOf(entry: unknown): { value: unknown; label: string } | undefined {
  if (isRecord(entry) && "value" in entry) {
    return {
      value: entry.value,
      label: typeof entry.label === "string" && entry.label !== "" ? entry.label : String(entry.value)
    };
  }
  if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
    return { value: entry, label: String(entry) };
  }
  return undefined;
}

function enumMatches(candidate: unknown, value: unknown): boolean {
  if (candidate === value) return true;
  const option = optionOf(candidate);
  return option !== undefined && option.value === value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function typeLabel(type: string): string {
  switch (type) {
    case "string":
      return "文本";
    case "number":
    case "integer":
      return "数字";
    case "boolean":
      return "布尔值";
    case "array":
      return "数组";
    case "object":
      return "对象";
    default:
      return type;
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
