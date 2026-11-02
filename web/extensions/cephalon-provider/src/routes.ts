/**
 * 端脑云的请求体构造与响应解释。
 *
 * 文本走 OpenAI 兼容的 `/chat/completions`；图片走 `/images/generations`（同步）；
 * 视频走异步任务 `/video/tasks` + `/video/tasks/{taskId}`。
 *
 * 字段名按平台文档实测：**视频**是火山 Seedance / MiniMax H3 协议，请求体用 PascalCase
 * （`Prompt` / `FileInfos` / `OutputConfig`），模型名放在 `Model-Name` 请求头里，**不能**放进 body；
 * **图片**是 OpenAI Images 形状（`model` / `prompt` / `size` / `n`）。
 */
import { normalizeLanguagePrompt } from "@sdppp/pptask/providers/shared";
import { CEPHALON_MODEL_PREFIX } from "./shared.js";

export const CHAT_PATH = `${CEPHALON_MODEL_PREFIX}/chat/completions`;
export const IMAGES_PATH = `${CEPHALON_MODEL_PREFIX}/images/generations`;
export const VIDEO_TASKS_PATH = `${CEPHALON_MODEL_PREFIX}/video/tasks`;

/** 视频任务状态。平台只用 `PROCESSING` / `FINISH`，另兼容平台的 `queued`/`running` 措辞。 */
export type TaskView =
  | { state: "pending"; phase: "queued" | "running"; progress?: number }
  | { state: "completed"; urls: string[] }
  | { state: "failed"; error: string };

const QUEUED = new Set(["queued", "queueing", "pending", "created", "submitted", "preparing", "starting", "waiting"]);
const RUNNING = new Set(["running", "processing", "in_progress", "in-progress", "generating"]);
const SUCCEEDED = new Set(["succeeded", "succeed", "success", "completed", "complete", "done", "finish", "finished"]);
const FAILED = new Set(["failed", "fail", "error", "cancelled", "canceled", "aborted", "abort", "deleted", "expired"]);

/** 文本：OpenAI 兼容对话请求体。参考图只给平台声明 `supports_vision` 的模型。 */
export function buildChatBody(
  modelId: string,
  input: Record<string, unknown>,
  options: { supportsVision: boolean }
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: modelId,
    messages: chatMessages(input, options.supportsVision),
    max_tokens: positiveInt(input.maxTokens ?? input.max_tokens, 2048)
  };
  if (input.jsonMode === true) body.response_format = { type: "json_object" };
  return body;
}

/** 参考图是否在请求体里出现。仅对有视觉能力的模型为真（单测与调用方共用）。 */
export function chatMessages(input: Record<string, unknown>, supportsVision: boolean): unknown[] {
  const normalized = normalizeLanguagePrompt(input).messages;
  const list: unknown[] = (Array.isArray(normalized) ? normalized : []).map(openAIMessage);
  const system = text(input.system);
  if (system && !list.some((message) => record(message)?.role === "system")) {
    list.unshift({ role: "system", content: system });
  }
  // 没有视觉能力的模型：把归一化时可能已经带上的图片部件一并去掉，避免上游 400。
  const sanitized = supportsVision ? list : list.map(withoutImages);
  const refs = supportsVision ? referenceUrls(input) : [];
  if (refs.length) attachImages(sanitized, refs);
  return sanitized;
}

/** 图片：OpenAI Images 形状。`size` 按平台校验规则只接受 `auto` / `1K` / `2K` / `4K` / `WIDTHxHEIGHT`。 */
export function buildImageBody(modelId: string, input: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { model: modelId, prompt: requiredPrompt(input) };
  const size = imageSize(input);
  // 平台校验报错已经确认这两个字段：`size must be auto, 1K, 2K, 4K, or WIDTHxHEIGHT`、
  // `n must be an integer between 1 and 10`。其它字段（width/height/steps/seed 等）只在
  // 平台示例代码里出现过，没有校验证据，因此不下发。
  if (size) body.size = size;
  const count = imageCount(input.n);
  if (count > 1) body.n = count;
  return body;
}

/** 视频：平台 PascalCase 形状。提示词必填，输出配置按平台取值范围收敛。 */
export function buildVideoBody(modelId: string, input: Record<string, unknown>): Record<string, unknown> {
  const spec = videoSpecFor(modelId);
  const body: Record<string, unknown> = { Prompt: requiredPrompt(input) };
  const refs = referenceUrls(input);
  if (refs.length) {
    body.FileInfos = refs.slice(0, spec.maxImages).map((url) => ({
      Type: "Url",
      Category: "Image",
      Url: url,
      Usage: "Reference"
    }));
  }
  const output: Record<string, unknown> = {};
  // 分辨率只在模型取值域经过平台确认时下发；没有证据时让平台用它自己的默认值，
  // 而不是猜一个档位（猜错就是必然 400）。
  const resolution = videoResolution(input, spec);
  if (resolution) output.Resolution = resolution;
  // 「自适应」不下发字段：seedance 文档的默认值就是 adaptive，H3 的枚举里没有它。
  const aspect = videoAspect(input);
  if (aspect) output.AspectRatio = aspect;
  output.Duration = videoDuration(input, spec);
  body.OutputConfig = output;
  return body;
}

/**
 * 平台对视频模型的分辨率/时长/参考图上限。
 *
 * 取值来自平台自带的接口文档（`/model` 页面内嵌的 model detail，`OutputConfig.*` 参数表）
 * 与实测报错：seedance-2.5 `720P/1080P`、seedance-2.0 `720P/1080P/4K`、
 * minimax-h3 `768P/2K`（H3 明确没有 720P）。`resolutions` 为空表示平台没给出取值域，
 * 此时不暴露分辨率控件、也不下发 `Resolution`（让平台用默认档位），而不是按模型名猜。
 */
export type VideoSpec = {
  resolutions: readonly string[];
  defaultResolution: string;
  maxDuration: number;
  maxImages: number;
};

const DEFAULT_VIDEO_SPEC: VideoSpec = {
  resolutions: [],
  defaultResolution: "",
  maxDuration: 15,
  maxImages: 9
};

/** 只按平台 model id 选文档里明确给出的取值范围；未知 id 用保守默认值。 */
export function videoSpecFor(modelId: string): VideoSpec {
  const id = modelId.trim().toLowerCase();
  if (id === "seedance-2.5") return { resolutions: ["720P", "1080P"], defaultResolution: "720P", maxDuration: 30, maxImages: 9 };
  if (id === "seedance-2.0") {
    return { resolutions: ["720P", "1080P", "4K"], defaultResolution: "720P", maxDuration: 15, maxImages: 9 };
  }
  if (id === "minimax-h3") return { resolutions: ["768P", "2K"], defaultResolution: "768P", maxDuration: 15, maxImages: 9 };
  return DEFAULT_VIDEO_SPEC;
}

/** 提交响应里的任务 ID：`Response.TaskId`，另兼容 `data.task_id` / `task_id` / `id`。 */
export function readTaskId(payload: unknown): string | undefined {
  const root = record(payload);
  const response = record(root?.Response);
  const data = record(root?.data);
  return (
    text(response?.TaskId) ??
    text(data?.task_id) ??
    text(data?.id) ??
    text(root?.task_id) ??
    text(root?.id)
  );
}

/** 业务失败码（`code` 非 0 且有 msg）：提交阶段必须直接判失败，不能进入轮询。 */
export function submitError(payload: unknown): string | undefined {
  const root = record(payload);
  if (!root) return "端脑云返回了无法识别的响应";
  const code = root.code;
  if (typeof code === "number" && code !== 0) {
    return text(root.msg) ?? text(root.message) ?? `端脑云拒绝了请求（${code}）`;
  }
  const error = record(root.error);
  if (error) return text(error.message) ?? "端脑云拒绝了请求";
  // 视频任务按平台约定「失败也返回 HTTP 200」，错误放在 `Response.Error.{Code,Message}`。
  const responseError = record(record(root.Response)?.Error);
  if (responseError) return text(responseError.Message) ?? text(responseError.message) ?? "端脑云拒绝了请求";
  return undefined;
}

/** 图片结果：OpenAI Images 形状的 `data[].url` / `data[].b64_json`。 */
export function imageResultUrls(payload: unknown): string[] {
  const root = record(payload);
  const list = Array.isArray(root?.data) ? root!.data as unknown[] : [];
  const urls: string[] = [];
  for (const entry of list) {
    const row = record(entry);
    const url = text(row?.url);
    if (url && /^https?:\/\//i.test(url)) urls.push(url);
  }
  return urls;
}

/**
 * 图片 b64 结果：`data[].b64_json` 的 base64 载荷（不含 data URL 前缀）。
 *
 * 共享 output 解析把 `b64_json` 当 base64 字节读取，所以这里保持裸载荷。
 */
export function imageResultBase64(payload: unknown): string[] {
  const root = record(payload);
  const list = Array.isArray(root?.data) ? root!.data as unknown[] : [];
  const found: string[] = [];
  for (const entry of list) {
    const value = text(record(entry)?.b64_json);
    if (!value) continue;
    found.push(value.startsWith("data:") ? value.slice(value.indexOf(",") + 1) : value);
  }
  return found;
}

/**
 * 解释任务查询响应。
 *
 * 平台真实形状是 `Response.AigcVideoTask.{Status,Progress,ErrCode,Message,Output.FileInfos[].FileUrl}`
 * 且根上还有 `Response.Status`；先看任务状态，再看根状态。**未知状态保持非终态**，
 * 绝不把无法判定的响应当成功。
 */
export function interpretStatus(payload: unknown): TaskView {
  const root = record(payload);
  const response = record(root?.Response);
  const task = record(response?.AigcVideoTask);
  const submitFailure = submitError(payload);
  if (submitFailure) return { state: "failed", error: submitFailure };
  if (!response && !root) return { state: "failed", error: "端脑云返回了无法识别的响应" };

  const errCode = task?.ErrCode;
  const message = text(task?.Message);
  const progress = progressOf(task?.Progress);
  const token = statusToken(response, task);
  const normalized = (token ?? "").toLowerCase();

  const urls = collectResultUrls(payload);
  if (FAILED.has(normalized)) return { state: "failed", error: message || `端脑云任务失败（${token}）` };
  // 平台把失败也表达为 FINISH + ErrCode≠0 + Message。
  if (SUCCEEDED.has(normalized)) {
    if (typeof errCode === "number" && errCode !== 0) {
      return { state: "failed", error: message || `端脑云任务失败（${errCode}）` };
    }
    if (urls.length === 0) return { state: "failed", error: "端脑云任务已完成但没有返回结果地址" };
    return { state: "completed", urls };
  }
  if (QUEUED.has(normalized)) return { state: "pending", phase: "queued", ...(progress !== undefined ? { progress } : {}) };
  return {
    state: "pending",
    phase: RUNNING.has(normalized) || normalized === "" ? "running" : "running",
    ...(progress !== undefined ? { progress } : {})
  };
}

/** 只取结果字段里的成片地址，不扫请求回显（回显里含参考图）。 */
export function collectResultUrls(payload: unknown): string[] {
  const root = record(payload);
  const response = record(root?.Response);
  const task = record(response?.AigcVideoTask);
  const output = record(task?.Output);
  const files = Array.isArray(output?.FileInfos) ? output!.FileInfos as unknown[] : [];
  const found: string[] = [];
  for (const file of files) {
    const url = text(record(file)?.FileUrl);
    if (url && /^https?:\/\//i.test(url)) found.push(url);
  }
  // 兼容其它任务载荷形状（素材任务 / 旧响应）。
  const data = record(root?.data);
  for (const candidate of [text(data?.video_url), text(data?.url), text(root?.video_url), text(record(root?.content)?.url)]) {
    if (candidate && /^https?:\/\//i.test(candidate)) found.push(candidate);
  }
  return [...new Set(found)];
}

export function statusPath(taskId: string): string {
  return `${VIDEO_TASKS_PATH}/${encodeURIComponent(taskId)}`;
}

function statusToken(response: Record<string, unknown> | undefined, task: Record<string, unknown> | undefined): string | undefined {
  const value = task?.Status ?? response?.Status ?? task?.status ?? response?.state;
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : undefined;
}

function progressOf(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function openAIMessage(message: unknown): unknown {
  const row = record(message);
  if (!row || !Array.isArray(row.content)) return message;
  return {
    ...row,
    content: row.content.map((part) => {
      const item = record(part);
      if (item?.type === "image" && typeof item.url === "string") {
        return { type: "image_url", image_url: { url: item.url } };
      }
      return part;
    })
  };
}

function withoutImages(message: unknown): unknown {
  const row = record(message);
  if (!row || !Array.isArray(row.content)) return message;
  const content = row.content.filter((part) => {
    const item = record(part);
    return item?.type !== "image_url" && item?.type !== "image";
  });
  if (content.length === 0) return { ...row, content: "" };
  if (content.length === 1 && record(content[0])?.type === "text") {
    return { ...row, content: (content[0] as Record<string, unknown>).text };
  }
  return { ...row, content };
}

function attachImages(messages: unknown[], urls: string[]): void {
  const target = [...messages].reverse().find((message) => record(message)?.role === "user");
  if (!target) {
    messages.push({ role: "user", content: urls.map(imagePart) });
    return;
  }
  const row = target as Record<string, unknown>;
  const content = Array.isArray(row.content)
    ? [...row.content]
    : typeof row.content === "string" ? [{ type: "text", text: row.content }] : [];
  const existing = new Set(content.flatMap((part) => {
    const item = record(part);
    const url = record(item?.image_url)?.url ?? item?.url;
    return typeof url === "string" ? [url] : [];
  }));
  for (const url of urls) {
    if (!existing.has(url)) content.push(imagePart(url));
  }
  row.content = content;
}

function imagePart(url: string): Record<string, unknown> {
  return { type: "image_url", image_url: { url } };
}

function referenceUrls(input: Record<string, unknown>): string[] {
  const raw = input.urls ?? input.images;
  const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return values.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 9);
}

/** 平台只接受 `auto` / `1K` / `2K` / `4K` / `WIDTHxHEIGHT`；其它取值不下发，避免 400。 */
function imageSize(input: Record<string, unknown>): string | undefined {
  const raw = text(input.size ?? input.imageSize ?? input.resolution);
  if (!raw) return undefined;
  const normalized = raw.trim();
  if (/^(auto|1k|2k|4k)$/i.test(normalized)) return normalized.toLowerCase() === "auto" ? "auto" : normalized.toUpperCase();
  return /^\d{2,5}x\d{2,5}$/i.test(normalized) ? normalized : undefined;
}

function imageCount(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isInteger(number) ? Math.min(10, Math.max(1, number)) : 1;
}

const VIDEO_ASPECTS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]);

/**
 * 比例只下发平台枚举里的具体值。
 *
 * seedance 文档写「默认 adaptive」，minimax-h3 的可选值里**没有** adaptive（图生视频时该字段
 * 还会被忽略）。所以「自适应」一律不发字段：对 seedance 等价于默认值，对 H3 也不会送一个
 * 它不接受的枚举。
 */
function videoAspect(input: Record<string, unknown>): string | undefined {
  const raw = text(input.aspectRatio ?? input.aspect_ratio ?? input.ratio);
  return raw && VIDEO_ASPECTS.has(raw) ? raw : undefined;
}

function videoResolution(input: Record<string, unknown>, spec: VideoSpec): string | undefined {
  // 没有经过平台确认的取值域就不给控件：不下发 = 用平台默认档位。
  if (spec.resolutions.length === 0) return undefined;
  const raw = text(input.resolution);
  if (!raw) return spec.defaultResolution;
  const upper = raw.toUpperCase();
  return spec.resolutions.includes(upper) ? upper : spec.defaultResolution;
}

function videoDuration(input: Record<string, unknown>, spec: VideoSpec): number {
  const raw = input.duration ?? input.durationSeconds;
  const number = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
  if (!Number.isFinite(number)) return 5;
  return Math.min(spec.maxDuration, Math.max(4, Math.round(number)));
}

function requiredPrompt(input: Record<string, unknown>): string {
  const value = text(input.prompt);
  if (!value) throw new Error("提示词不能为空");
  return value;
}

function positiveInt(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isInteger(number) && number > 0 ? Math.min(1_048_576, number) : fallback;
}

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
