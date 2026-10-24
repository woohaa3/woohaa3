/**
 * catalog → 参数表投影（共享）
 *
 * `catalog-projection.ts`（站点节点面板）与 `generic-panel-projection.ts`（Model Interaction
 * 通用面板）曾经各有一份逐字重复的参数投影。这里把它们收敛成唯一实现：投影规则
 * （spec `canvas-node-execution`「模型与参数的目录投影」）只在此维护。
 *
 * 除 JSON Schema 类型外，Provider 还可以在同一声明里标注「这个字段应该被人类怎么选」：
 * `x-pptask-control` 声明控件语义（比例 / 分辨率 / 质量），enum 选项上的
 * `x-pptask-adaptive` 声明哪一项是「自适应」。前端不再按 key 名或枚举形态猜测，
 * 未声明语义的字段仍走普通 select/number。
 */
import {
  findAdaptiveOption,
  isPptaskParameterControl,
  type CanvasTaskCatalogModel
} from "@woohaa3/contracts";
import type { ExecutionPanelParameterField } from "./execution-panel/types.js";

/** 由面板自己承载、不作为参数的 schema 字段。 */
const EXCLUDED_PARAMETER_KEYS = new Set(["prompt", "urls"]);

/**
 * 按 catalog 的 `inputSchema` 投影参数表。
 *
 * - `enum` → select（带语义时额外透传 `semantic` / `adaptiveValue`）；
 * - number 且带 minimum/maximum → slider，否则 number；
 * - boolean → checkbox；
 * - `prompt` / `urls` 不进参数表：前者是面板自己的提示词框，后者是参考输入能力；
 * - schema `default` 与 `defaultInput` 一起作为默认参数。
 */
export function projectParameterFields(
  model: CanvasTaskCatalogModel
): ExecutionPanelParameterField[] {
  const properties = readObject(model.inputSchema.properties) ?? {};
  const required = readStringArray(model.inputSchema.required);
  const fields: ExecutionPanelParameterField[] = [];

  for (const [key, rawSchema] of Object.entries(properties)) {
    if (EXCLUDED_PARAMETER_KEYS.has(key)) continue;
    const schema = readObject(rawSchema);
    if (!schema) continue;
    const label = readString(schema.title) ?? key;
    const defaultValue = schema.default ?? model.defaultInput[key];
    const isRequired = required.includes(key) ? { required: true } : {};

    const enumOptions = readEnumOptions(schema.enum);
    if (enumOptions.length > 0) {
      const semantic =
        isPptaskParameterControl(schema["x-pptask-control"])
          ? schema["x-pptask-control"]
          : undefined;
      const adaptiveValue = findAdaptiveOption(schema.enum)?.value;
      fields.push({
        key,
        label,
        type: "select",
        options: enumOptions,
        defaultValue: defaultValue as string | number | boolean | undefined,
        ...(semantic !== undefined ? { semantic } : {}),
        ...(adaptiveValue !== undefined ? { adaptiveValue } : {}),
        ...isRequired,
        hiddenWhen: readHiddenWhen(schema["x-hidden-when"])
      });
      continue;
    }

    const type = readString(schema.type);
    if (type === "boolean") {
      fields.push({
        key,
        label,
        type: "boolean",
        defaultValue: defaultValue === true,
        ...isRequired,
        hiddenWhen: readHiddenWhen(schema["x-hidden-when"])
      });
      continue;
    }
    if (type === "number" || type === "integer") {
      const minimum = readNumber(schema.minimum);
      const maximum = readNumber(schema.maximum);
      const step = readNumber(schema.step) ?? readNumber(schema["multipleOf"]);
      const slider = minimum !== undefined && maximum !== undefined;
      fields.push({
        key,
        label,
        type: "number",
        ...(slider ? { control: "slider" as const } : {}),
        minimum,
        maximum,
        step,
        defaultValue: defaultValue as number | undefined,
        ...isRequired,
        hiddenWhen: readHiddenWhen(schema["x-hidden-when"])
      });
      continue;
    }
    if (type === "array" || type === "object") continue;

    const multiline = schema["x-component"] === "Input.TextArea";
    fields.push({
      key,
      label,
      type: multiline ? "textarea" : "text",
      defaultValue: defaultValue as string | undefined,
      ...isRequired,
      hiddenWhen: readHiddenWhen(schema["x-hidden-when"])
    });
  }

  return fields;
}

/** `defaultInput` 去掉面板自己承载的字段，再叠加 schema 默认值。 */
export function projectParameterDefaults(
  model: CanvasTaskCatalogModel
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(model.defaultInput)) {
    if (EXCLUDED_PARAMETER_KEYS.has(key)) continue;
    defaults[key] = value;
  }
  const properties = readObject(model.inputSchema.properties) ?? {};
  for (const [key, rawSchema] of Object.entries(properties)) {
    if (EXCLUDED_PARAMETER_KEYS.has(key)) continue;
    const schema = readObject(rawSchema);
    if (schema?.default !== undefined) defaults[key] = schema.default;
  }
  return defaults;
}

function readStringArray(input: unknown): string[] {
  return Array.isArray(input) ? input.filter((entry): entry is string => typeof entry === "string") : [];
}

function readEnumOptions(input: unknown): Array<{ value: string; label: string }> {
  if (!Array.isArray(input)) return [];
  const options: Array<{ value: string; label: string }> = [];
  for (const entry of input) {
    if (typeof entry === "string") {
      options.push({ value: entry, label: entry });
      continue;
    }
    const record = readObject(entry);
    if (!record) continue;
    const value = readString(record.value);
    if (value === undefined) continue;
    options.push({ value, label: readString(record.label) ?? value });
  }
  return options;
}

function readHiddenWhen(
  input: unknown
): ExecutionPanelParameterField["hiddenWhen"] {
  if (!Array.isArray(input)) return undefined;
  const rules: Array<{ field: string; equals: string | number | boolean }> = [];
  for (const entry of input) {
    const record = readObject(entry);
    if (!record) continue;
    const field = readString(record.field);
    const equals = record.equals;
    if (
      field === undefined ||
      (typeof equals !== "string" && typeof equals !== "number" && typeof equals !== "boolean")
    ) {
      continue;
    }
    rules.push({ field, equals });
  }
  return rules.length > 0 ? rules : undefined;
}

function readObject(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function readString(input: unknown): string | undefined {
  return typeof input === "string" && input !== "" ? input : undefined;
}

function readNumber(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}
