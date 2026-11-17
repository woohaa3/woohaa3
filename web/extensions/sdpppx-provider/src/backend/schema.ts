/**
 * 模板 `formSchema` → 宿主输入 schema 的白名单转换。
 *
 * sdpppx 的模板表单是 Formily schema（`type: "object"` + `properties`），字段类型与组件组合
 * 远比宿主输入面板能表达的丰富。这里**只映射已知可表达的字段**；未识别字段不渲染，只记入
 * `unknownFields` 供诊断。宿主面板不提供 rawParams。
 *
 * prompt 不在面板里渲染：model 的 `promptRequirement` 固定为 `none`，提示词由画布上游文字
 * 节点解析；模板声明了 prompt 字段时，`prepareInput` 仍会把解析到的 prompt 写回该字段。
 *
 * 转换结果同时保留参考字段的位置（`referenceFields`），`prepareInput` 据此把上传后的 URL
 * 写回模板真正读取的字段，而不是猜一个 `images` 之类的通用键名。
 */
import type { PromptRequirement } from "@woohaa3/contracts";
import { DEFAULT_SDPPPX_PROMPT_FIELD } from "../shared.js";

export type SdpppxReferenceField = {
  key: string;
  mediaKind: "image" | "video";
  multiple: boolean;
  maxItems: number;
};

export type SdpppxInputSchema = {
  inputSchema: Record<string, unknown>;
  defaultInput: Record<string, unknown>;
  promptRequirement: PromptRequirement;
  /** 模板里的提示词字段名；`hasPromptField` 为 false 时不写 payload。 */
  promptField: string;
  /** 模板声明了提示词字段；面板不渲染它，但提交时仍写入解析到的 prompt。 */
  hasPromptField: boolean;
  referenceFields: SdpppxReferenceField[];
  /** 无法映射、因而不会出现在面板里的字段名（诊断用）。 */
  unknownFields: string[];
  /** 成功映射的字段数（不含 prompt）。 */
  mappedFields: number;
};

export type SdpppxSchemaInput = {
  formSchema: unknown;
  formValues?: unknown;
  promptField?: string;
  /** describe 失败时为 true：不猜字段，只保留空输入 schema。 */
  minimal?: boolean;
};

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function componentOf(field: RecordValue): string {
  return textOf(field["x-component"]) ?? "";
}

function formatOf(field: RecordValue): string {
  return textOf(field.format)?.toLowerCase() ?? "";
}

function itemsOf(field: RecordValue): RecordValue | undefined {
  return isRecord(field.items) ? field.items : undefined;
}

function isUploadField(field: RecordValue, items: RecordValue | undefined): boolean {
  const component = componentOf(field).toLowerCase();
  if (component.includes("upload")) return true;
  const format = formatOf(field);
  if (format === "image" || format === "video" || format === "file") return true;
  if (items && formatOf(items).match(/^(image|video|file)$/)) return true;
  return /image|video/i.test(textOf(field["x-pptask-semantic"]) ?? "");
}

function isBooleanField(field: RecordValue): boolean {
  const type = textOf(field.type)?.toLowerCase();
  if (type === "boolean") return true;
  const component = componentOf(field).toLowerCase();
  return component === "switch" || component === "checkbox" || component === "checkbox.group";
}

function isNumericField(field: RecordValue): boolean {
  const type = textOf(field.type)?.toLowerCase();
  if (type === "number" || type === "integer") return true;
  const component = componentOf(field).toLowerCase();
  return ["numberpicker", "inputnumber", "slider", "rate"].includes(component);
}

function enumValuesOf(field: RecordValue): Array<string | number> | undefined {
  const raw = field.enum;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const values: Array<string | number> = [];
  for (const item of raw) {
    if (typeof item === "string" || typeof item === "number") {
      values.push(item);
      continue;
    }
    if (isRecord(item)) {
      const value = item.value ?? item.label;
      if (typeof value === "string" || typeof value === "number") values.push(value);
    }
  }
  return values.length > 0 ? values : undefined;
}

function enumLabelsOf(field: RecordValue, count: number): string[] | undefined {
  const names = Array.isArray(field.enumNames) ? field.enumNames : undefined;
  if (!names) return undefined;
  const labels = names.slice(0, count).map((item) => (typeof item === "string" ? item : String(item ?? "")));
  return labels.some((label) => label !== "") ? labels : undefined;
}

function mediaKindOf(field: RecordValue, items: RecordValue | undefined): "image" | "video" {
  const hints = [
    formatOf(field),
    formatOf(items ?? {}),
    textOf(field["x-pptask-semantic"]) ?? "",
    textOf(field.accept) ?? "",
    textOf(isRecord(field["x-component-props"]) ? field["x-component-props"].accept : undefined) ?? ""
  ]
    .join(" ")
    .toLowerCase();
  return hints.includes("video") ? "video" : "image";
}

function maxItemsOf(field: RecordValue, items: RecordValue | undefined): number | undefined {
  const props = isRecord(field["x-component-props"]) ? field["x-component-props"] : {};
  const candidates = [field.maxItems, props.maxCount, props.limit, items?.maxItems];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return Math.min(Math.floor(candidate), 16);
    }
  }
  return undefined;
}

function copyBounds(source: RecordValue, target: RecordValue): void {
  for (const key of ["minLength", "maxLength", "minimum", "maximum", "multipleOf"]) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) target[key] = value;
  }
}

function isRequiredField(name: string, field: RecordValue, required: ReadonlySet<string>): boolean {
  return field.required === true || required.has(name);
}

const PROMPT_TITLES = new Set(["提示词", "prompt"]);

/**
 * 识别模板里的提示词字段。
 *
 * 模板实际会用 `2_prompt` 这类带前缀的 key，标题仍是「提示词」；只按配置的
 * `SDPPPX_PROMPT_FIELD`（缺省 `prompt`）匹配会把它当成普通参数渲染出来。
 */
function isPromptField(key: string, field: RecordValue | undefined, configured: string): boolean {
  if (key === configured) return true;
  const lower = key.toLowerCase();
  if (lower === "prompt" || lower.endsWith("_prompt") || lower.endsWith("-prompt")) return true;
  return PROMPT_TITLES.has(textOf(field?.title)?.toLowerCase() ?? "");
}

/**
 * 把一个 Formily 字段转成宿主字段；返回 undefined 表示「不认识」，交给 rawParams。
 */
function convertField(
  field: RecordValue,
  key: string,
  required: ReadonlySet<string>
): { property: RecordValue; reference?: SdpppxReferenceField } | undefined {
  const title = textOf(field.title) ?? key;
  const description = textOf(field.description);
  const items = itemsOf(field);
  // 模板字段是模型的主参数：全部进入 common，不藏进「高级参数」。
  const base: RecordValue = { title, "x-pptask-presentation": { section: "common" } };
  if (description) base.description = description;
  if (isRequiredField(key, field, required)) base.required = true;
  if (field.default !== undefined) base.default = field.default;

  if (isUploadField(field, items)) {
    const kind = mediaKindOf(field, items);
    const declaredMax = maxItemsOf(field, items);
    const multiple = textOf(field.type)?.toLowerCase() === "array" || (declaredMax !== undefined && declaredMax > 1);
    const maxItems = multiple ? (declaredMax ?? 8) : 1;
    const accept = kind === "video"
      ? { "video/*": [".mp4", ".webm", ".mov"] }
      : { "image/*": [".png", ".jpg", ".jpeg", ".webp"] };
    const property: RecordValue = {
      ...base,
      type: multiple ? "array" : "string",
      "x-component": "Upload",
      "x-component-props": {
        maxCount: multiple ? maxItems : 1,
        accept
      },
      "x-pptask-semantic": kind === "video" ? "reference-video" : "reference-image"
    };
    if (multiple) {
      property.maxItems = maxItems;
      property["x-sdpppx-multiple"] = true;
    }
    return {
      property,
      reference: { key, mediaKind: kind, multiple, maxItems }
    };
  }

  if (isBooleanField(field)) {
    return {
      property: {
        ...base,
        type: "boolean",
        "x-component": "Switch"
      }
    };
  }

  const values = enumValuesOf(field);
  if (values) {
    const labels = enumLabelsOf(field, values.length);
    return {
      property: {
        ...base,
        type: typeof values[0] === "number" ? "number" : "string",
        "x-component": "Select",
        enum: values,
        ...(labels ? { "x-enum-labels": labels } : {})
      }
    };
  }

  if (isNumericField(field)) {
    const integer =
      textOf(field.type)?.toLowerCase() === "integer" ||
      field.precision === 0 ||
      field.multipleOf === 1;
    const property: RecordValue = {
      ...base,
      type: integer ? "integer" : "number",
      "x-component": "NumberPicker"
    };
    copyBounds(field, property);
    return { property };
  }

  const type = textOf(field.type)?.toLowerCase();
  if (type === "string") {
    const component = componentOf(field);
    const multiline = /textarea/i.test(component);
    const property: RecordValue = {
      ...base,
      type: "string",
      "x-component": multiline ? "Input.TextArea" : "Input"
    };
    copyBounds(field, property);
    return { property };
  }

  return undefined;
}

/**
 * 转换模板表单。`minimal` 只用于 describe 失败/超时：不猜字段，面板只剩模型选择与提交。
 */
export function buildSdpppxInputSchema(input: SdpppxSchemaInput): SdpppxInputSchema {
  const promptField = textOf(input.promptField) ?? DEFAULT_SDPPPX_PROMPT_FIELD;
  const unknownFields: string[] = [];
  const referenceFields: SdpppxReferenceField[] = [];
  const properties: RecordValue = {};
  const defaultInput: RecordValue = {};
  const required: string[] = [];
  let mappedFields = 0;

  const formSchema = isRecord(input.formSchema) ? input.formSchema : undefined;
  const rawProperties = formSchema && isRecord(formSchema.properties) ? formSchema.properties : {};
  const requiredSet = new Set(
    Array.isArray(formSchema?.required)
      ? formSchema.required.filter((item): item is string => typeof item === "string")
      : []
  );
  const formValues = isRecord(input.formValues) ? input.formValues : {};
  let detectedPromptField = promptField;
  let hasPromptField = false;

  if (!input.minimal) {
    for (const [key, rawFieldValue] of Object.entries(rawProperties)) {
      const field = isRecord(rawFieldValue) ? rawFieldValue : undefined;
      // prompt 由画布上游文字节点解析，不在宿主参数面板里重复展示。
      if (isPromptField(key, field, promptField)) {
        if (!hasPromptField) detectedPromptField = key;
        hasPromptField = true;
        continue;
      }
      if (!field) {
        unknownFields.push(key);
        continue;
      }
      const converted = convertField(field, key, requiredSet);
      if (!converted) {
        unknownFields.push(key);
        continue;
      }
      properties[key] = converted.property;
      mappedFields += 1;
      if (converted.reference) referenceFields.push(converted.reference);
      if (converted.property.required === true) required.push(key);
      const defaultValue = formValues[key] ?? converted.property.default;
      if (defaultValue !== undefined) defaultInput[key] = defaultValue;
    }
  }

  // 面板不提供提示词输入框与 rawParams：sdpppx 模型的提示词只从画布上游文字节点解析，
  // 模板声明了 prompt 字段时由 prepareInput 写入 payload。
  const promptRequirement: PromptRequirement = "none";

  return {
    inputSchema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required: [...new Set(required)] } : {})
    },
    defaultInput,
    promptRequirement,
    promptField: detectedPromptField,
    hasPromptField,
    referenceFields,
    unknownFields,
    mappedFields
  };
}
