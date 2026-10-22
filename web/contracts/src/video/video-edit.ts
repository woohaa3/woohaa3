/**
 * 视频编辑 intent 的受限结构化契约
 * （change: port-video-editing-dialogs，任务 1.1 / 1.2 / 1.4；design D4/D5/D6/D8）。
 *
 * 本模块是**纯函数、无副作用、JSON-only** 的 contract：定义视频编辑点/区间 intent、
 * pen/rect 标注 shape、稳定 annotation preview identity、frame dimensions 的 schema，
 * 以及 sanitizer / validator / 稳定排序 / provider 编译。
 *
 * 关键约束（跨端共用，服务端与前端同一份语义）：
 * - canonical 状态只保存**稳定媒体身份**（storageKey / assetId），绝不保存 data URL、
 *   object URL、Blob 或临时签名 URL；
 * - 时间有限，区间最小跨度 0.05 秒，所有时间位于 `[0, duration]`；
 * - intent/shape/point/prompt/dimensions 与序列化总大小均有上限；
 * - provider 编译按 `startSeconds`、`endSeconds`、`id` 稳定排序，只为授权且稳定的
 *   annotation preview 生成 image reference。
 */
import { isJsonObject, isFiniteNumber, isValidStorageKey } from "../validation.js";

/** 一个视频编辑 intent 中允许的标注工具。 */
export type VideoEditAnnotationTool = "pen" | "rect";

/** 视频内容区域内归一化坐标（不含 object-fit letterbox），分量位于 `[0, 1]`。 */
export type VideoEditAnnotationPoint = {
  x: number;
  y: number;
};

/** 一条标注 shape；坐标相对实际视频内容区域归一化（design D5）。 */
export type VideoEditAnnotationShape = {
  id: string;
  tool: VideoEditAnnotationTool;
  color: string;
  strokeWidth: number;
  /** pen：≥2 个点；rect：恰好 2 个点（起点、终点）。 */
  points: VideoEditAnnotationPoint[];
};

/**
 * 稳定的 annotation preview 身份（design D6）。
 *
 * 只允许稳定媒体引用；`storageKey` 必须是内容寻址键。临时 URL / data URL / Blob
 * 一律不是合法 preview。
 */
export type VideoEditAnnotationPreview = {
  /** 稳定资产身份（可为空字符串表示仅由 storageKey 标识）。 */
  assetId: string;
  storageKey: string;
  mediaType: string;
};

/** 单个视频编辑 intent。 */
export type VideoEditIntent = {
  /** 稳定且唯一的 intent id。 */
  id: string;
  /** 有限、位于 `[0, duration]` 的起始时间（秒）。 */
  startSeconds: number;
  /** 区间终点的可选时间；缺省表示点 intent。 */
  endSeconds?: number;
  /** 非空受限提示词。 */
  prompt: string;
  annotationShapes: VideoEditAnnotationShape[];
  /** 可选稳定标记图身份；不含则仅保存 shapes。 */
  annotationPreview?: VideoEditAnnotationPreview;
  frameWidth: number;
  frameHeight: number;
};

/** intent 数量、shape/point、prompt、尺寸与序列化总大小上限（design D4）。 */
export const VIDEO_EDIT_LIMITS = {
  maxIntents: 32,
  maxShapesPerIntent: 64,
  maxPointsPerShape: 2048,
  maxPromptChars: 2000,
  minRangeSeconds: 0.05,
  maxFrameDimension: 8192,
  maxSerializedBytes: 256 * 1024
} as const;

/** 允许的标注色板（design D5：颜色从允许色板选择）。 */
export const VIDEO_EDIT_ALLOWED_COLORS = ["#ff8a1f", "#ff3b30", "#ffd23f", "#2f80ff", "#ffffff"] as const;

/** 允许的线宽（以内容坐标解释）。 */
export const VIDEO_EDIT_ALLOWED_STROKE_WIDTHS = [1, 2, 3] as const;

const ALLOWED_COLOR_SET = new Set<string>(VIDEO_EDIT_ALLOWED_COLORS);
const ALLOWED_STROKE_SET = new Set<number>(VIDEO_EDIT_ALLOWED_STROKE_WIDTHS);

/** 首帧/尾帧捕获的稳定 epsilon（design：避免越界或空白尾帧）。 */
export const VIDEO_FRAME_EPSILON_SECONDS = 0.05;

/** 浮点容差：`2.05 - 2` 等运算结果略小于 0.05，判定最小跨度时抵消。 */
const RANGE_EPSILON = 1e-9;

export type VideoEditValidationResult =
  | { ok: true; value: VideoEditIntent[] }
  | { ok: false; error: string };

/**
 * 把可能含 `endSeconds` 的 intent 归一为「点」或「区间」。
 * 区间要求 `endSeconds - startSeconds >= minRangeSeconds`。
 */
export function isVideoEditRange(intent: Pick<VideoEditIntent, "startSeconds" | "endSeconds">): boolean {
  return (
    typeof intent.endSeconds === "number" &&
    intent.endSeconds - intent.startSeconds >= VIDEO_EDIT_LIMITS.minRangeSeconds - RANGE_EPSILON
  );
}

/** 稳定排序键：`startSeconds` → `endSeconds`（点视为 start）→ `id`。 */
export function compareVideoEditIntents(a: VideoEditIntent, b: VideoEditIntent): number {
  if (a.startSeconds !== b.startSeconds) return a.startSeconds - b.startSeconds;
  const aEnd = a.endSeconds ?? a.startSeconds;
  const bEnd = b.endSeconds ?? b.startSeconds;
  if (aEnd !== bEnd) return aEnd - bEnd;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 按稳定顺序返回新数组（不改动入参顺序）。 */
export function sortVideoEditIntents(intents: readonly VideoEditIntent[]): VideoEditIntent[] {
  return [...intents].sort(compareVideoEditIntents);
}

/**
 * 单个 shape 的 sanitizer：丢弃未知字段，拒绝危险值。
 *
 * 返回 `null` 表示「shape 不合法，不可持久化」（未知字段不是失败，而是被丢弃）。
 */
export function sanitizeVideoAnnotationShape(input: unknown): VideoEditAnnotationShape | null {
  if (!isJsonObject(input)) return null;
  const id = typeof input.id === "string" && input.id !== "" ? input.id : null;
  if (!id) return null;
  const tool = input.tool === "pen" || input.tool === "rect" ? input.tool : null;
  if (!tool) return null;
  const color = typeof input.color === "string" && ALLOWED_COLOR_SET.has(input.color) ? input.color : null;
  if (!color) return null;
  const strokeWidth =
    typeof input.strokeWidth === "number" && Number.isFinite(input.strokeWidth) && ALLOWED_STROKE_SET.has(input.strokeWidth)
      ? input.strokeWidth
      : null;
  if (strokeWidth === null) return null;
  const rawPoints = Array.isArray(input.points) ? input.points : null;
  if (!rawPoints) return null;
  if (rawPoints.length > VIDEO_EDIT_LIMITS.maxPointsPerShape) return null;
  const points: VideoEditAnnotationPoint[] = [];
  for (const raw of rawPoints) {
    const point = sanitizeVideoAnnotationPoint(raw);
    if (!point) return null;
    points.push(point);
  }
  if (tool === "rect") {
    // rect 恰好两个点（起点、终点）；越界/退化矩形不可持久化。
    if (points.length !== 2) return null;
  } else if (points.length < 2) {
    return null;
  }
  return { id, tool, color, strokeWidth, points };
}

/** 归一化内容坐标点：分量必须是 `[0, 1]` 的有限数值。 */
export function sanitizeVideoAnnotationPoint(input: unknown): VideoEditAnnotationPoint | null {
  if (!isJsonObject(input)) return null;
  const { x, y } = input;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/**
 * preview sanitizer：只接受稳定媒体身份（design D6）。
 *
 * data URL / object URL / Blob / 临时签名 URL 一律返回 `null`（调用方据此拒绝整个 intent）。
 */
export function sanitizeVideoAnnotationPreview(input: unknown): VideoEditAnnotationPreview | null {
  if (!isJsonObject(input)) return null;
  const storageKey = input.storageKey;
  if (!isValidStorageKey(storageKey)) return null;
  const assetId = typeof input.assetId === "string" ? input.assetId : "";
  const mediaType = typeof input.mediaType === "string" && input.mediaType !== "" ? input.mediaType : "image/png";
  // 防御：仅稳定 storageKey，不允许任何 URL/Blob/data 表示。
  if (looksLikeDangerousString(assetId) || looksLikeDangerousString(mediaType)) return null;
  return { assetId, storageKey, mediaType };
}

/**
 * intent sanitizer（严格模式）：任何非法时间/尺寸/prompt/shape/preview 返回 `null`。
 *
 * `duration` 提供时校验时间上界；缺省则只要求有限非负。
 */
export function sanitizeVideoEditIntent(
  input: unknown,
  options: { duration?: number; maxSerializedBytes?: number } = {}
): VideoEditIntent | null {
  if (!isJsonObject(input)) return null;
  const id = typeof input.id === "string" && input.id !== "" && input.id.length <= 200 ? input.id : null;
  if (!id) return null;
  const startSeconds = input.startSeconds;
  if (!isFiniteNumber(startSeconds) || startSeconds < 0) return null;
  const maxTime = typeof options.duration === "number" && Number.isFinite(options.duration) && options.duration > 0
    ? options.duration
    : Number.POSITIVE_INFINITY;
  if (startSeconds > maxTime) return null;

  let endSeconds: number | undefined;
  if (input.endSeconds !== undefined && input.endSeconds !== null) {
    if (!isFiniteNumber(input.endSeconds) || input.endSeconds < 0) return null;
    if (input.endSeconds > maxTime) return null;
    if (input.endSeconds - startSeconds < VIDEO_EDIT_LIMITS.minRangeSeconds - RANGE_EPSILON) return null;
    endSeconds = input.endSeconds;
  }

  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (prompt === "" || prompt.length > VIDEO_EDIT_LIMITS.maxPromptChars) return null;

  const rawShapes = Array.isArray(input.annotationShapes) ? input.annotationShapes : [];
  if (rawShapes.length > VIDEO_EDIT_LIMITS.maxShapesPerIntent) return null;
  const annotationShapes: VideoEditAnnotationShape[] = [];
  for (const raw of rawShapes) {
    const shape = sanitizeVideoAnnotationShape(raw);
    if (!shape) return null;
    annotationShapes.push(shape);
  }

  const frameWidth = readPositiveDimension(input.frameWidth);
  const frameHeight = readPositiveDimension(input.frameHeight);
  if (frameWidth === null || frameHeight === null) return null;

  let annotationPreview: VideoEditAnnotationPreview | undefined;
  if (input.annotationPreview !== undefined && input.annotationPreview !== null) {
    const preview = sanitizeVideoAnnotationPreview(input.annotationPreview);
    // 有 shapes 才需要 preview；preview 存在但非法 → 不可持久化。
    if (!preview) return null;
    annotationPreview = preview;
  }

  const value: VideoEditIntent = {
    id,
    startSeconds,
    ...(endSeconds !== undefined ? { endSeconds } : {}),
    prompt,
    annotationShapes,
    ...(annotationPreview ? { annotationPreview } : {}),
    frameWidth,
    frameHeight
  };

  const maxBytes = options.maxSerializedBytes ?? VIDEO_EDIT_LIMITS.maxSerializedBytes;
  if (serializedByteLength(value) > maxBytes) return null;
  return value;
}

/**
 * 归一化整个 `videoEditIntents` 数组（canonical 边界）。
 *
 * - 非数组 → 空数组；
 * - 任何一条 intent 非法 → 整体失败（返回稳定错误），而不是静默丢弃后执行语义不同的任务；
 * - id 重复 → 失败；
 * - 数组顺序被稳定排序后返回。
 */
export function normalizeVideoEditIntents(
  input: unknown,
  options: { duration?: number } = {}
): VideoEditValidationResult {
  if (input === undefined || input === null) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, error: "videoEditIntents 必须是数组" };
  if (input.length > VIDEO_EDIT_LIMITS.maxIntents) {
    return { ok: false, error: `编辑意图数量超过 ${VIDEO_EDIT_LIMITS.maxIntents} 上限` };
  }
  const value: VideoEditIntent[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const intent = sanitizeVideoEditIntent(raw, options.duration !== undefined ? { duration: options.duration } : {});
    if (!intent) return { ok: false, error: "包含非法或超限的视频编辑意图" };
    if (seen.has(intent.id)) return { ok: false, error: `视频编辑意图 id 重复：${intent.id}` };
    seen.add(intent.id);
    value.push(intent);
  }
  return { ok: true, value: sortVideoEditIntents(value) };
}

/** 便捷校验（不构造值）：只关心是否合法。 */
export function validateVideoEditIntents(
  input: unknown,
  options: { duration?: number } = {}
): { ok: true } | { ok: false; error: string } {
  const result = normalizeVideoEditIntents(input, options);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/**
 * 从任意 nodeData 中读取 `videoEditIntents`；非法/超限返回空数组并附带稳定错误。
 *
 * 用于任务提交前的再次校验：调用方必须根据 `error` 拒绝提交，而不是继续。
 */
export function readVideoEditIntents(
  nodeData: { videoEditIntents?: unknown } | undefined,
  options: { duration?: number } = {}
): VideoEditValidationResult {
  if (!nodeData || nodeData.videoEditIntents === undefined) return { ok: true, value: [] };
  return normalizeVideoEditIntents(nodeData.videoEditIntents, options);
}

/** provider 编译输出中的稳定 image reference。 */
export type VideoEditImageReference = {
  intentId: string;
  storageKey: string;
  mediaType: string;
};

export type VideoEditCompileResult =
  | { ok: true; prompt: string; imageReferences: VideoEditImageReference[] }
  | { ok: false; error: string };

/**
 * 把 intents 编译为 provider prompt（design D8）。
 *
 * - 编译前再次 sanitize/validate 并稳定排序；
 * - 每个合法 intent 编译为带点/区间时间的 prompt 行；
 * - 只有带稳定 `annotationPreview` 的 intent 才产出 image reference；
 * - 缺 prompt / 越界 / 超限 / 临时媒体 → 以稳定错误失败（不静默跳过）。
 */
export function compileVideoEditProviderPrompt(input: {
  intents: unknown;
  basePrompt?: string;
  /** 视频总时长；提供时校验时间上界。 */
  duration?: number;
  /** image reference 起始编号（合并到其它参考素材时使用）。 */
  imageReferenceOffset?: number;
}): VideoEditCompileResult {
  const normalized = normalizeVideoEditIntents(input.intents, input.duration !== undefined ? { duration: input.duration } : {});
  if (!normalized.ok) return { ok: false, error: normalized.error };
  const intents = normalized.value;
  const base = (input.basePrompt ?? "").trim();
  if (intents.length === 0) return { ok: true, prompt: base, imageReferences: [] };

  const imageReferences: VideoEditImageReference[] = [];
  let imageIndex = input.imageReferenceOffset ?? 0;
  const lines = sortVideoEditIntents(intents).map((intent) => {
    const time = isVideoEditRange(intent)
      ? `${formatEditTime(intent.startSeconds)}-${formatEditTime(intent.endSeconds!)} 秒`
      : `${formatEditTime(intent.startSeconds)} 秒附近`;
    let imageReference = "";
    if (intent.annotationPreview && intent.annotationShapes.length > 0) {
      imageReferences.push({
        intentId: intent.id,
        storageKey: intent.annotationPreview.storageKey,
        mediaType: intent.annotationPreview.mediaType
      });
      imageReference = `，参考标记图 @image${++imageIndex}`;
    }
    return `- 视频 1 中 ${time}，对${describeAnnotationRegion(intent.annotationShapes)}执行：${intent.prompt}${imageReference}。`;
  });

  return {
    ok: true,
    prompt: ["编辑视频 1，除以下指定时间段外，其余内容保持不变。", ...lines, base ? `补充要求：${base}` : ""]
      .filter(Boolean)
      .join("\n"),
    imageReferences
  };
}

function formatEditTime(seconds: number): string {
  return Math.max(0, seconds).toFixed(2);
}

function describeAnnotationRegion(shapes: readonly VideoEditAnnotationShape[]): string {
  if (shapes.length === 0) return "画面";
  const points = shapes.flatMap((shape) => shape.points);
  if (points.length === 0) return "画面";
  const center = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  return center < 0.34 ? "画面左侧标记区域" : center > 0.66 ? "画面右侧标记区域" : "画面中央标记区域";
}

function readPositiveDimension(input: unknown): number | null {
  if (!isFiniteNumber(input) || input <= 0 || input > VIDEO_EDIT_LIMITS.maxFrameDimension) return null;
  return Math.floor(input);
}

/**
 * 序列化 UTF-8 字节长度。用 JSON.stringify 的字符长度近似再乘 3 只会低估，
 * 这里在无 TextEncoder 环境回退到保守的字符长度估算。
 */
function serializedByteLength(value: unknown): number {
  const text = JSON.stringify(value);
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** `data:` / `blob:` / 任意协议 URL / 协议相对地址都视为危险字符串。 */
function looksLikeDangerousString(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes("://") ||
    lower.startsWith("data:") ||
    lower.startsWith("blob:") ||
    lower.startsWith("//")
  );
}
