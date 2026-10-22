/**
 * TokenHub 按模型系列分发请求。
 *
 * 文本统一走 `/v1/chat/completions`。图片和视频没有统一协议：每个系列有自己的提交路径、
 * 请求体和任务状态字段。这里只覆盖文档里请求体已经明确的系列；动作控制、优图视频、
 * Vidu 视频、WAND 生图的入参各不相同，没有协议就不注册，避免猜错端点。
 */
import {
  ADAPTIVE_PARAMETER_VALUE,
  IMAGE_ASPECT_RATIOS_STANDARD as IMAGE_ASPECTS,
  imageModelPresetFor,
  seedreamPixelSize,
  seedreamSizePresetFor
} from "@woohaa3/contracts";

export type TokenHubKind = "language" | "image" | "video";

export type ModelRoute = {
  kind: TokenHubKind;
  family: string;
  mode: "sync" | "async";
};

export type TaskView =
  | { state: "pending"; phase: "queued" | "running" }
  | { state: "completed"; urls: string[] }
  | { state: "failed"; error: string };

const KLING_VIDEO_ASPECTS = ["16:9", "9:16", "1:1"] as const;
const HY_VIDEO_ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;
const PIXVERSE_ASPECTS = ["16:9", "4:3", "1:1", "3:4", "9:16", "2:3", "3:2", "21:9"] as const;
const MINIMAX_ASPECTS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
const VEGA_ASPECTS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;

const PIXELS_1K: Record<string, string> = {
  "1:1": "1024x1024",
  "16:9": "1280x720",
  "9:16": "720x1280",
  "4:3": "1024x768",
  "3:4": "768x1024",
  "3:2": "1152x768",
  "2:3": "768x1152",
  "21:9": "1344x576"
};

const PIXELS_2K: Record<string, string> = {
  "1:1": "2048x2048",
  "16:9": "2048x1152",
  "9:16": "1152x2048",
  "4:3": "2048x1536",
  "3:4": "1536x2048",
  "3:2": "2048x1366",
  "2:3": "1366x2048",
  "21:9": "2048x878"
};

const PIXELS_1_5K: Record<string, string> = {
  "1:1": "1536x1536",
  "16:9": "2048x1152",
  "9:16": "1152x2048",
  "4:3": "1728x1296",
  "3:4": "1296x1728",
  "3:2": "1920x1280",
  "2:3": "1280x1920",
  "21:9": "2352x1008"
};

const PIXELS_4K: Record<string, string> = {
  "1:1": "4096x4096",
  "16:9": "4096x2304",
  "9:16": "2304x4096",
  "4:3": "4096x3072",
  "3:4": "3072x4096",
  "3:2": "4096x2730",
  "2:3": "2730x4096",
  "21:9": "4096x1756"
};

const SUCCESS = new Set(["succeeded", "succeed", "success", "completed", "complete", "done"]);
const FAILED = new Set(["failed", "fail", "error", "cancelled", "canceled", "deleted"]);
const QUEUED = new Set(["queued", "queueing", "created", "submitted", "pending", "preparing"]);

/** 有文档的系列才返回路由。无法执行的 id 返回 undefined。 */
export function routeModel(modelId: string): ModelRoute | undefined {
  const id = modelId.trim();
  if (id.startsWith("hy-image-v3.5")) return { kind: "image", family: "hy-image-v35", mode: "sync" };
  if (id === "hy-image-v3" || id === "hy-image-v3.0") return { kind: "image", family: "hy-image-v3", mode: "sync" };
  if (id.startsWith("seedream-image-")) return { kind: "image", family: "seedream-image", mode: "sync" };
  if (id.startsWith("vidu-image-")) return { kind: "image", family: "vidu-image", mode: "async" };
  if (id.startsWith("kling-image-")) return { kind: "image", family: "kling-image", mode: "async" };
  if (id.startsWith("hy-video")) return { kind: "video", family: "hy-video", mode: "async" };
  if (id.startsWith("kling-video-v3-omni") || id.startsWith("kling-video-o1")) {
    return { kind: "video", family: "kling-omni", mode: "async" };
  }
  if (id.startsWith("kling-video-") && !id.startsWith("kling-video-motion-control")) {
    return { kind: "video", family: "kling-video", mode: "async" };
  }
  if (id.startsWith("pixverse-video-")) return { kind: "video", family: "pixverse-video", mode: "async" };
  if (id.startsWith("minimax-video-h3")) return { kind: "video", family: "minimax-video-v2", mode: "async" };
  if (id.startsWith("minimax-video-")) return { kind: "video", family: "minimax-video", mode: "async" };
  if (id.startsWith("wand-vega-video")) return { kind: "video", family: "vega-video", mode: "async" };
  return undefined;
}

export function buildSubmit(modelId: string, input: Record<string, unknown>): { path: string; body: Record<string, unknown> } {
  const route = routeModel(modelId);
  if (!route || route.kind === "language") throw new Error(`TokenHub 没有 ${modelId} 的生成协议`);
  const prompt = requiredPrompt(input);
  switch (route.family) {
    case "hy-image-v3":
      return {
        path: "/v1/wand/hunyuan-image/v3-generation",
        body: compact({
          model: modelId,
          prompt,
          size: PIXELS_1K[aspect(input, "1:1", IMAGE_ASPECTS)],
          images: images(input, 3)
        })
      };
    case "hy-image-v35":
      return {
        path: "/v1/wand/hunyuan-image/v35-generation",
        body: {
          model: modelId,
          ...hy35Fields(input),
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...images(input, 20).map((url) => ({ type: "image_url", image_url: { url } }))
            ]
          }]
        }
      };
    case "seedream-image":
      return {
        path: "/v1/wand/si-image/generation",
        body: compact({
          model: modelId,
          prompt,
          images: images(input, modelId.includes("lite") ? 14 : 10),
          size: seedreamSize(modelId, input),
          response_format: "url"
        })
      };
    case "vidu-image":
      return {
        path: "/v1/wand/vidu-image/generation",
        body: compact({
          model: modelId,
          prompt,
          images: images(input, 7),
          aspect_ratio: aspect(input, "16:9", IMAGE_ASPECTS),
          resolution: viduImageResolution(input)
        })
      };
    case "kling-image":
      return { path: "/v1/wand/kling-image/generation", body: klingImageBody(modelId, prompt, input) };
    case "hy-video":
      return {
        path: "/v1/wand/hunyuan-video/generation",
        body: compact({
          model: modelId,
          prompt,
          image_url: images(input, 1)[0],
          aspect_ratio: images(input, 1).length ? undefined : aspect(input, "16:9", HY_VIDEO_ASPECTS)
        })
      };
    case "kling-video":
      return klingVideoBody(modelId, prompt, input);
    case "kling-omni":
      return klingOmniBody(modelId, prompt, input);
    case "pixverse-video":
      return pixverseBody(modelId, prompt, input);
    case "minimax-video":
      return minimaxV1Body(modelId, prompt, input);
    case "minimax-video-v2":
      return minimaxV2Body(modelId, prompt, input);
    case "vega-video":
      return vegaVideoBody(modelId, prompt, input);
    default:
      throw new Error(`TokenHub 没有 ${modelId} 的生成协议`);
  }
}

export function statusPath(family: string, taskId: string): string {
  const id = encodeURIComponent(taskId);
  switch (family) {
    case "vidu-image": return `/v1/wand/vidu-image/tasks/${id}`;
    case "kling-image": return `/v1/wand/kling-image/tasks/${id}`;
    case "hy-video": return `/v1/wand/hunyuan-video/tasks/${id}`;
    case "kling-video":
    case "kling-omni": return `/v1/wand/kling/tasks/${id}`;
    case "pixverse-video": return `/v1/wand/pixverse/tasks/${id}`;
    case "minimax-video": return `/v1/wand/minimax-video/tasks/${id}`;
    case "minimax-video-v2": return `/v1/wand/minimax-video-v2/tasks/${id}`;
    case "vega-video": return `/v1/wand/vega-videos/tasks/${id}`;
    default: throw new Error(`TokenHub 没有 ${family} 的查询接口`);
  }
}

/** 提交响应里的任务 ID。同步生图不走这里。 */
export function readTaskId(payload: unknown): string | undefined {
  const root = record(payload);
  const data = record(root?.data);
  const resp = record(root?.Resp);
  return text(data?.task_id) ?? text(data?.id) ?? text(resp?.video_id) ?? text(root?.task_id) ?? text(root?.id);
}

/** 业务码非 0 时直接失败。查询接口里 `base_resp.status_code` 恒为 0，不代表任务成功。 */
export function assertRequestAccepted(payload: unknown): void {
  const root = record(payload);
  if (!root) return;
  if (typeof root.code === "number" && root.code !== 0) {
    throw new Error(text(root.message) ?? `TokenHub 拒绝了请求（${root.code}）`);
  }
  if (typeof root.ErrCode === "number" && root.ErrCode !== 0) {
    throw new Error(text(root.ErrMsg) ?? `TokenHub 拒绝了请求（${root.ErrCode}）`);
  }
  const base = record(root.base_resp);
  if (base && typeof base.status_code === "number" && base.status_code !== 0) {
    throw new Error(text(base.status_msg) ?? `TokenHub 拒绝了请求（${base.status_code}）`);
  }
}

export function interpretStatus(payload: unknown): TaskView {
  const root = record(payload);
  if (root && typeof root.code === "number" && root.code !== 0) {
    return { state: "failed", error: text(root.message) ?? `TokenHub 查询失败（${root.code}）` };
  }
  if (root && typeof root.ErrCode === "number" && root.ErrCode !== 0) {
    return { state: "failed", error: text(root.ErrMsg) ?? `TokenHub 查询失败（${root.ErrCode}）` };
  }
  const token = statusToken(payload);
  if (typeof token === "number") {
    if (token === 1) return completed(payload);
    if (token === 5) return { state: "pending", phase: "running" };
    if (token === 6 || token === 7 || token === 8) return { state: "failed", error: failureMessage(payload) };
    return { state: "pending", phase: "running" };
  }
  const status = (token ?? "").toLowerCase();
  if (FAILED.has(status)) return { state: "failed", error: failureMessage(payload) };
  if (SUCCESS.has(status)) return completed(payload);
  return { state: "pending", phase: QUEUED.has(status) ? "queued" : "running" };
}

/** 只取结果字段里的地址，不扫请求回显里的参考图。 */
export function collectResultUrls(payload: unknown): string[] {
  const found: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) found.push(value);
  };
  const eachUrl = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) push(record(item)?.url ?? (typeof item === "string" ? item : undefined));
      return;
    }
    push(record(value)?.url);
  };
  const root = record(payload);
  if (!root) return [];
  if (Array.isArray(root.choices)) {
    for (const choice of root.choices) {
      push(record(record(record(choice)?.delta)?.image)?.url);
    }
  }
  if (Array.isArray(root.data)) {
    for (const item of root.data) {
      const row = record(item);
      push(row?.url);
      push(row?.video_url);
      eachUrl(row?.outputs);
      eachUrl(row?.videos);
      eachUrl(row?.images);
    }
  } else {
    const data = record(root.data);
    push(data?.url);
    push(data?.video_url);
    const taskResult = record(data?.task_result);
    eachUrl(taskResult?.images);
    eachUrl(taskResult?.series_images);
    eachUrl(taskResult?.videos);
  }
  eachUrl(root.creations);
  eachUrl(root.videos);
  eachUrl(root.images);
  eachUrl(root.outputs);
  push(record(root.content)?.url);
  push(record(root.content)?.video_url);
  const taskContent = record(record(root.task)?.content);
  push(taskContent?.url);
  push(taskContent?.video_url);
  push(record(root.Resp)?.url);
  push(root.video_url);
  return [...new Set(found)];
}

function completed(payload: unknown): TaskView {
  const urls = collectResultUrls(payload);
  if (!urls.length) return { state: "failed", error: "TokenHub 任务已完成但没有返回结果地址" };
  return { state: "completed", urls };
}

function failureMessage(payload: unknown): string {
  const root = record(payload) ?? {};
  const data = record(root.data);
  const first = Array.isArray(root.data) ? record(root.data[0]) : undefined;
  const task = record(root.task);
  const message = record(task?.error)?.message
    ?? data?.task_status_msg
    ?? data?.message
    ?? first?.message
    ?? record(root.error)?.message
    ?? record(root.base_resp)?.status_msg
    ?? root.ErrMsg
    ?? root.message;
  const textValue = text(message);
  return textValue && textValue !== "SUCCEED" ? textValue : "TokenHub 生成失败";
}

function statusToken(payload: unknown): string | number | undefined {
  const root = record(payload);
  if (!root) return undefined;
  const data = record(root.data);
  const first = Array.isArray(root.data) ? record(root.data[0]) : undefined;
  const value = root.status ?? root.state ?? data?.task_status ?? data?.status ?? first?.status ?? record(root.task)?.status ?? record(root.Resp)?.status;
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function klingImageBody(modelId: string, prompt: string, input: Record<string, unknown>): Record<string, unknown> {
  const ratio = aspect(input, modelId === "kling-image-v3" ? "16:9" : "1:1", IMAGE_ASPECTS);
  const clarity = klingImageResolution(modelId, input);
  const refs = images(input, 10).map(klingImageRef);
  if (modelId === "kling-image-v3") {
    return compact({ model: modelId, prompt, image: refs[0], aspect_ratio: ratio, resolution: clarity });
  }
  return compact({
    model: modelId,
    prompt,
    image_list: refs.length ? refs : undefined,
    aspect_ratio: refs.length ? ratio : (ratio === "auto" ? "1:1" : ratio),
    resolution: clarity
  });
}

function klingVideoBody(modelId: string, prompt: string, input: Record<string, unknown>): { path: string; body: Record<string, unknown> } {
  const refs = images(input, 2);
  const settings = {
    resolution: klingVideoResolution(modelId, input),
    duration: klingDuration(modelId, input)
  };
  if (!refs.length) {
    return {
      path: "/v1/wand/kling/text-to-video",
      body: {
        model: modelId,
        prompt,
        settings: { ...settings, aspect_ratio: aspect(input, "16:9", KLING_VIDEO_ASPECTS) }
      }
    };
  }
  const contents: Array<Record<string, string>> = [
    { type: "prompt", text: prompt },
    { type: "first_frame", url: refs[0]! }
  ];
  if (refs[1] && !modelId.includes("v3-turbo")) contents.push({ type: "last_frame", url: refs[1] });
  return { path: "/v1/wand/kling/image-to-video", body: { model: modelId, contents, settings } };
}

function klingOmniBody(modelId: string, prompt: string, input: Record<string, unknown>): { path: string; body: Record<string, unknown> } {
  const refs = images(input, 7);
  const contents: Array<Record<string, string>> = [{ type: "prompt", text: prompt }];
  refs.forEach((url, index) => {
    contents.push({ type: index === 0 ? "first_frame" : "refer_image", url });
  });
  const settings: Record<string, unknown> = {
    resolution: klingVideoResolution(modelId, input),
    duration: klingDuration(modelId, input)
  };
  if (!refs.length) settings.aspect_ratio = aspect(input, "16:9", KLING_VIDEO_ASPECTS);
  return { path: "/v1/wand/kling/omni-video", body: { model: modelId, contents, settings } };
}

function pixverseBody(modelId: string, prompt: string, input: Record<string, unknown>): { path: string; body: Record<string, unknown> } {
  const quality = pixverseQuality(input);
  const duration = pixverseDuration(modelId, input, quality);
  const refs = images(input, 1);
  if (!refs.length) {
    return {
      path: "/v1/wand/pixverse/text-to-video",
      body: { model: modelId, prompt, duration, quality, aspect_ratio: aspect(input, "16:9", PIXVERSE_ASPECTS) }
    };
  }
  return {
    path: "/v1/wand/pixverse/image-to-video",
    body: { model: modelId, prompt, img_id: refs[0], duration, quality }
  };
}

function minimaxV1Body(modelId: string, prompt: string, input: Record<string, unknown>): { path: string; body: Record<string, unknown> } {
  const refs = images(input, 1);
  if (modelId.includes("v2.3-fast") && !refs.length) throw new Error("minimax-video-v2.3-fast 只支持图生视频，请提供参考图");
  const clarity = minimaxV1Resolution(input);
  const duration = clarity === "1080P" ? 6 : (durationOf(input, 6) >= 8 ? 10 : 6);
  return {
    path: "/v1/wand/minimax-video/generation",
    body: compact({ model: modelId, prompt, first_frame_image: refs[0], duration, resolution: clarity })
  };
}

function minimaxV2Body(modelId: string, prompt: string, input: Record<string, unknown>): { path: string; body: Record<string, unknown> } {
  const refs = images(input, 2);
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  if (refs[0]) content.push({ type: "image_url", image_url: { url: refs[0] }, role: "first_frame" });
  if (refs[1]) content.push({ type: "image_url", image_url: { url: refs[1] }, role: "last_frame" });
  const minimum = modelId.includes("h3-max") ? 5 : 4;
  return {
    path: "/v1/wand/minimax-video-v2/generation",
    body: {
      model: modelId,
      content,
      resolution: h3Resolution(modelId, input),
      duration: Math.max(minimum, Math.min(15, durationOf(input, 6))),
      ...(refs.length ? {} : { ratio: aspect(input, "16:9", MINIMAX_ASPECTS) })
    }
  };
}

function vegaVideoBody(modelId: string, prompt: string, input: Record<string, unknown>): { path: string; body: Record<string, unknown> } {
  const refs = images(input, 3);
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  refs.forEach((url, index) => {
    const role = index === 0 ? "first_frame" : index === 1 ? "last_frame" : "reference_image";
    content.push({ type: "image_url", image_url: { url }, role });
  });
  return {
    path: "/v1/wand/vega-videos/tasks",
    body: {
      model: modelId,
      content,
      resolution: vegaResolution(input),
      ratio: refs.length ? "adaptive" : aspect(input, "16:9", VEGA_ASPECTS),
      duration: Math.max(4, Math.min(15, durationOf(input, 5)))
    }
  };
}

/** Hy-Image-3.5-preview 的 generate_max_pixels 档位（面积像素数，最高 2K）。 */
const HY35_MAX_PIXELS: Record<string, number> = {
  "1K": 1048576,
  "1.5K": 2359296,
  "2K": 4194304
};

/**
 * Hy-Image-3.5-preview 的尺寸字段。
 *
 * 比例选「自适应」时不传 `size`，由模型结合 prompt 决定宽高，只按分辨率发
 * `generate_max_pixels`；固定比例时用比例 + 分辨率查像素表（默认 1.5K，与文档一致）。
 */
function hy35Fields(input: Record<string, unknown>): Record<string, string | number> {
  const requestedRatio = text(input.aspectRatio ?? input.aspect_ratio ?? input.ratio);
  const requestedResolution = resolution(input, "1.5K");
  const normalized = requestedResolution.toLowerCase() === "1.5k"
    ? "1.5K"
    : requestedResolution.toUpperCase();
  if (requestedRatio === ADAPTIVE_PARAMETER_VALUE) {
    return { generate_max_pixels: HY35_MAX_PIXELS[normalized] ?? HY35_MAX_PIXELS["1.5K"]! };
  }
  const table = normalized === "4K"
    ? PIXELS_4K
    : normalized === "2K"
      ? PIXELS_2K
      : normalized === "1.5K"
        ? PIXELS_1_5K
        : PIXELS_1K;
  return { size: table[aspect(input, "1:1", IMAGE_ASPECTS)] ?? "1024x1024" };
}

/**
 * 即梦的 `size`：官方没有 `aspect_ratio`，比例只能写进像素值。
 *
 * 选了固定比例且该版本有官方像素表时下发 `WIDTHxHEIGHT`（真正固定宽高比）；
 * 否则退回分辨率档位，由模型结合 prompt 决定宽高——与官方「方式 1」一致。
 */
function seedreamSize(modelId: string, input: Record<string, unknown>): string {
  const spec = seedreamSizePresetFor(modelId);
  if (!spec) {
    const preset = imageModelPresetFor(modelId);
    if (preset) {
      const requested = resolution(input, preset.defaultResolution);
      return preset.resolutions.includes(requested) ? requested : preset.defaultResolution;
    }
    const raw = resolution(input, "2K");
    if (modelId.includes("lite")) return raw === "3K" || raw === "4K" ? raw : "2K";
    return raw === "1K" || raw === "1.5K" ? raw : "2K";
  }
  const requested = resolution(input, spec.defaultResolution);
  const tier = spec.resolutions.includes(requested) ? requested : spec.defaultResolution;
  const ratio = text(input.aspectRatio ?? input.aspect_ratio ?? input.ratio);
  const pixel = ratio && ratio !== ADAPTIVE_PARAMETER_VALUE ? seedreamPixelSize(spec, ratio, tier) : undefined;
  return pixel ?? tier;
}

function viduImageResolution(input: Record<string, unknown>): string {
  const raw = resolution(input, "1080p").toLowerCase();
  if (raw === "2k") return "2K";
  if (raw === "4k") return "4K";
  return "1080p";
}

function klingImageResolution(modelId: string, input: Record<string, unknown>): string {
  const raw = resolution(input, "1K").toLowerCase();
  if (raw === "4k") return modelId.includes("omni") ? "4k" : "2k";
  return raw === "2k" ? "2k" : "1k";
}

function klingVideoResolution(modelId: string, input: Record<string, unknown>): string {
  const raw = resolution(input, "720p").toLowerCase();
  if (raw === "4k" && /kling-video-v3($|-omni)/.test(modelId)) return "4k";
  return raw === "1080p" || raw === "2k" || raw === "4k" ? "1080p" : "720p";
}

function klingDuration(modelId: string, input: Record<string, unknown>): number {
  const value = durationOf(input, 5);
  if (/v2\.6|v2\.5/.test(modelId)) return value >= 8 ? 10 : 5;
  if (modelId.startsWith("kling-video-o1")) return Math.max(3, Math.min(10, value));
  return Math.max(3, Math.min(15, value));
}

function pixverseQuality(input: Record<string, unknown>): string {
  const raw = resolution(input, "720p").toLowerCase();
  if (raw === "360p" || raw === "540p" || raw === "1080p") return raw;
  return raw === "2k" || raw === "4k" ? "1080p" : "720p";
}

function pixverseDuration(modelId: string, input: Record<string, unknown>, quality: string): number {
  const value = durationOf(input, 5);
  if (!modelId.includes("v5.6")) return Math.max(1, Math.min(15, value));
  if (quality === "1080p") return value >= 8 ? 8 : 5;
  if (value >= 10) return 10;
  return value >= 8 ? 8 : 5;
}

function minimaxV1Resolution(input: Record<string, unknown>): "768P" | "1080P" {
  const raw = resolution(input, "768P").toLowerCase();
  return raw === "1080p" || raw === "2k" ? "1080P" : "768P";
}

function h3Resolution(modelId: string, input: Record<string, unknown>): string {
  const raw = resolution(input, "768P").toLowerCase();
  if (modelId.includes("h3-max")) return raw === "480p" ? "480P" : "768P";
  return raw === "2k" || raw === "4k" ? "2K" : "768P";
}

function vegaResolution(input: Record<string, unknown>): string {
  const raw = resolution(input, "768P").toLowerCase();
  if (raw === "1080p") return "1080P";
  if (raw === "2k") return "2K";
  if (raw === "4k") return "4K";
  return "768P";
}

/** 可灵生图的 Base64 不接受 `data:` 前缀。 */
function klingImageRef(value: string): string {
  const match = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(value);
  return match?.[1] ?? value;
}

function requiredPrompt(input: Record<string, unknown>): string {
  const value = text(input.prompt);
  if (!value) throw new Error("提示词不能为空");
  return value;
}

function images(input: Record<string, unknown>, limit: number): string[] {
  const raw = input.urls ?? input.images ?? input.image ?? input.input_references;
  const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const urls: string[] = [];
  for (const item of values) {
    const url = typeof item === "string" ? item : text(record(item)?.url);
    if (url) urls.push(url);
  }
  return urls.slice(0, limit);
}

function aspect(input: Record<string, unknown>, fallback: string, allowed: readonly string[]): string {
  const value = text(input.aspectRatio ?? input.aspect_ratio ?? input.ratio);
  return value && allowed.includes(value) ? value : fallback;
}

function resolution(input: Record<string, unknown>, fallback: string): string {
  return text(input.resolution) ?? fallback;
}

function durationOf(input: Record<string, unknown>, fallback: number): number {
  const raw = input.duration ?? input.durationSeconds;
  const number = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && !(Array.isArray(item) && item.length === 0))) as T;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
