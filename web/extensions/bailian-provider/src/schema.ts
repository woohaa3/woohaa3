/**
 * 百炼生图的参数面板与请求体拼装。
 *
 * 面板只给「提示词 + 参考图 + 比例 + 分辨率」四件，其余按模型能力追加：
 * - `negative_prompt` 只有 Qwen-Image 2.0 系列接受；
 * - `prompt_extend` 只有 Qwen 系列与 Z-Image 接受（万相要提质得开 `thinking_mode`，不暴露）；
 * - 比例 + 分辨率查表得到像素 `size`：上游要求 `宽*高`，不认画幅字符串。
 *
 * 请求体形状固定为单轮多模态：
 * `{ model, input: { messages: [{ role: "user", content: [{ image }..., { text }] }] }, parameters }`。
 * 参考图必须排在文本前（文档的多图编辑示例就是这个顺序），且 `text` 只能有一个。
 */
import {
  aspectRatioField,
  resolutionField,
  resolvePixelSize,
  type GenerationModelDescription
} from "@woohaa3/contracts";
import type { BailianModelSpec } from "./catalog.js";

/** 面板与请求体共用的解析结果：模型支持哪几个开关。 */
export type BailianInputSchemaOptions = {
  withNegativePrompt: boolean;
  withPromptExtend: boolean;
  promptExtendDefault: boolean;
  withReferenceImages: boolean;
};

export function describeBailianModel(model: BailianModelSpec): GenerationModelDescription {
  const options = inputSchemaOptions(model);
  return {
    title: model.title,
    inputSchema: bailianInputSchema(model, options),
    defaultInput: bailianDefaultInput(model, options),
    promptRequirement: "required"
    // 同步接口没有远端任务可取消：保持缺省的 local（宿主只停本地请求）。
  };
}

export function inputSchemaOptions(model: BailianModelSpec): BailianInputSchemaOptions {
  return {
    withNegativePrompt: model.supportsNegativePrompt,
    withPromptExtend: model.supportsPromptExtend,
    promptExtendDefault: model.promptExtendDefault,
    withReferenceImages: model.maxReferenceImages > 0
  };
}

export function bailianInputSchema(
  model: BailianModelSpec,
  options: BailianInputSchemaOptions
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    prompt: promptSchema(),
    ...(options.withReferenceImages ? { urls: referenceSchema(model.maxReferenceImages) } : {}),
    aspectRatio: aspectRatioField({
      ratios: model.aspectRatios,
      fallback: model.defaultAspectRatio,
      title: "比例"
    }),
    ...(model.resolutions.length > 0
      ? {
          resolution: resolutionField({
            tiers: model.resolutions,
            fallback: model.defaultResolution,
            title: "图片分辨率"
          })
        }
      : {})
  };
  if (options.withNegativePrompt) {
    properties.negativePrompt = {
      type: "string",
      title: "负向提示词",
      "x-component": "Input.TextArea",
      "x-component-props": { rows: 2 }
    };
  }
  if (options.withPromptExtend) {
    properties.promptExtend = {
      type: "boolean",
      title: "智能改写提示词",
      default: options.promptExtendDefault,
      "x-component": "Switch"
    };
  }
  return { type: "object", required: ["prompt"], properties };
}

export function bailianDefaultInput(
  model: BailianModelSpec,
  options: BailianInputSchemaOptions
): Record<string, unknown> {
  return {
    prompt: "",
    ...(options.withReferenceImages ? { urls: [] } : {}),
    aspectRatio: model.defaultAspectRatio,
    ...(model.resolutions.length > 0 ? { resolution: model.defaultResolution } : {}),
    ...(options.withNegativePrompt ? { negativePrompt: "" } : {}),
    ...(options.withPromptExtend ? { promptExtend: options.promptExtendDefault } : {})
  };
}

/**
 * 组装 DashScope 同步生图请求体。
 *
 * `watermark` 固定发 false：上游默认就是 false，显式发出去是为了让「无水印」成为契约而不是
 * 随上游默认值漂移的行为。
 */
export function buildBailianImageBody(
  model: BailianModelSpec,
  raw: Record<string, unknown>
): Record<string, unknown> {
  const prompt = promptText(raw);
  if (prompt === "") throw new Error("百炼生图需要提示词");
  const references = referenceUrls(raw).slice(0, model.maxReferenceImages);
  const content: Array<Record<string, unknown>> = [
    ...references.map((url) => ({ image: url })),
    { text: prompt }
  ];
  const parameters: Record<string, unknown> = {
    size: resolveSize(model, raw, references.length > 0),
    watermark: false
  };
  if (model.supportsNegativePrompt) {
    const negative = stringValue(raw.negativePrompt ?? raw.negative_prompt);
    if (negative !== "") parameters.negative_prompt = negative.slice(0, model.negativePromptLimit);
  }
  if (model.supportsPromptExtend) {
    parameters.prompt_extend = typeof raw.promptExtend === "boolean"
      ? raw.promptExtend
      : model.promptExtendDefault;
  }
  return {
    model: model.id,
    input: { messages: [{ role: "user", content }] },
    parameters
  };
}

/**
 * 从同步响应里取图片地址。
 *
 * 成功形状：`output.choices[].message.content[]`，其中 `{ image: url }` 是结果，
 * `{ text }` / `{ reasoning_content }` 是附带说明。失败形状是
 * `{ request_id, code, message }`，此时没有 `output`。
 */
export function readBailianImages(payload: unknown): string[] {
  const list = record(record(payload)?.output)?.choices;
  if (!Array.isArray(list)) return [];
  const urls: string[] = [];
  for (const choice of list) {
    const content = record(record(choice)?.message)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const url = record(part)?.image;
      if (typeof url === "string" && url.trim() !== "" && !urls.includes(url)) urls.push(url.trim());
    }
  }
  return urls;
}

/** DashScope 的错误是 `{ request_id, code, message }`，HTTP 状态码本身信息量不够。 */
export function bailianErrorMessage(payload: unknown): string {
  const row = record(payload);
  if (!row) return "";
  const code = typeof row.code === "string" ? row.code.trim() : "";
  const message = typeof row.message === "string" ? row.message.trim() : "";
  if (message === "") return "";
  // 内容审核失败最常见，补一句让用户知道该改提示词而不是重试。
  if (code === "DataInspectionFailed") return `${message}（提示词或参考图触发了内容审核，需要调整后重试）`;
  if (code === "Throttling") return `${message}（百炼限流，稍后重试）`;
  return code === "" ? message : `${message}（${code}）`;
}

/**
 * 比例 + 分辨率 → 像素 `size`。
 *
 * 带参考图时先降到模型声明的上限档（万相 Pro 的 4K 只对纯文生图开放）。
 */
function resolveSize(model: BailianModelSpec, raw: Record<string, unknown>, hasReferences: boolean): string {
  const aspectRatio = raw.aspectRatio ?? raw.aspect_ratio;
  const resolution = raw.resolution;
  if (!hasReferences || model.referenceResolutionCap === undefined) {
    return resolvePixelSize({ table: model.sizes, aspectRatio, resolution, fallback: model.fallbackSize });
  }
  const capped = resolvePixelSize({
    table: model.sizes,
    aspectRatio,
    resolution: model.referenceResolutionCap,
    fallback: model.fallbackSize
  });
  return capped;
}

function promptText(raw: Record<string, unknown>): string {
  const value = raw.prompt ?? raw.text;
  return typeof value === "string" ? value.trim() : "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 参考图既接受公网 URL，也接受 DashScope 明文支持的 Base64 data URI。
 * 顺序即提交顺序（多图编辑里「最后一张图决定输出比例」）。
 */
function referenceUrls(raw: Record<string, unknown>): string[] {
  const source = raw.urls ?? raw.images;
  const values = source === undefined ? [] : Array.isArray(source) ? source : [source];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const item of values) {
    if (typeof item !== "string") continue;
    const value = item.trim();
    if (!/^(https?:|data:image\/)/i.test(value) || seen.has(value)) continue;
    seen.add(value);
    urls.push(value);
  }
  return urls;
}

function promptSchema(): Record<string, unknown> {
  return { type: "string", title: "提示词", "x-component": "Input.TextArea", "x-component-props": { rows: 4 } };
}

function referenceSchema(maxItems: number): Record<string, unknown> {
  return {
    type: "array",
    title: "参考图",
    maxItems,
    "x-pptask-semantic": "reference-image",
    "x-component": "Upload",
    "x-component-props": { maxCount: maxItems }
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
