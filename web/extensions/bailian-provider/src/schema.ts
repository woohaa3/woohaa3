/**
 * 百炼生图的参数面板与请求体拼装。
 *
 * 面板的**语义控件**来自契约层的卡片投影（`bailianFamilySchema`）：比例、分辨率、负向提示词、
 * 智能改写都是卡片声明的事实，这里不重写一份。本文件只补两件百炼特有的东西：
 *
 * 1. 参考图的键名是 `urls`（DashScope 的字段叫 `input.messages[].content[].image`，任务服务
 *    的 `buildInput` 只认 schema 里写的键名，所以这里用 `urls` 而不是 `referencesImage`）；
 * 2. 请求体形状固定为单轮多模态：
 *    `{ model, input: { messages: [{ role: "user", content: [{ image }..., { text }] }] }, parameters }`。
 *    参考图必须排在文本前（文档的多图编辑示例就是这个顺序），且 `text` 只能有一个。
 *
 * `parameters` 由 `bailianRequestFields` 给出（`宽*高` 的 `size`、`watermark: false`、可选的
 * `negative_prompt` / `prompt_extend`），带参考图时的档位收窄也在那里。
 */
import {
  bailianFamilySchema,
  bailianRequestFields,
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

/**
 * 面板 schema：卡片投影的语义控件 + 提示词 + 参考图。
 *
 * 投影已经覆盖比例 / 分辨率 / 负向提示词 / 智能改写，这里不再判断「哪个模型有什么」，
 * 只把 `urls` 换成百炼的键名并补上提示词。
 */
export function bailianInputSchema(
  model: BailianModelSpec,
  options: BailianInputSchemaOptions
): Record<string, unknown> {
  const projected = bailianFamilySchema(model);
  const properties: Record<string, unknown> = {
    prompt: promptSchema(),
    ...(options.withReferenceImages ? { urls: referenceSchema(model.maxReferenceImages) } : {}),
    ...projected.properties
  };
  return { type: "object", required: ["prompt"], properties };
}

export function bailianDefaultInput(
  model: BailianModelSpec,
  options: BailianInputSchemaOptions
): Record<string, unknown> {
  return {
    prompt: "",
    ...(options.withReferenceImages ? { urls: [] } : {}),
    ...bailianFamilySchema(model).defaults
  };
}

/**
 * 组装 DashScope 同步生图请求体。
 *
 * `watermark` / 档位收窄 / 两个开关都在 `bailianRequestFields` 里，本函数只负责把提示词与
 * 参考图排成 DashScope 要求的多模态 `content` 顺序。
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
  return {
    model: model.id,
    input: { messages: [{ role: "user", content }] },
    parameters: bailianRequestFields(model, raw, { hasReferences: references.length > 0 })
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

function promptText(raw: Record<string, unknown>): string {
  const value = raw.prompt ?? raw.text;
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
