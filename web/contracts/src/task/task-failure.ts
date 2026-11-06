/**
 * 任务失败文案映射（change: 2026-11-06-guard-video-generation-inputs）。
 *
 * Provider / 网关的参数错误通常是一段英文原文（甚至整个 JSON 响应体）：
 * `aspectRatio is required`、`duration maximum value is 12 seconds, and duration must be
 * greater than 4 seconds`、`resolution is required`。任务终态把这段原文直接塞进节点错误，
 * 用户既看不出缺哪个字段，也不知道允许范围。
 *
 * 这里把**可识别的参数错误**翻译成含字段名与允许范围的中文；识别为参数错误但无法
 * 细分时也只给稳定兜底文案，不把上游原始响应搬进界面。非参数错误保留原消息（仍由
 * `stripSecrets` 做凭据裁剪）。
 */

export type TaskFailureInput = {
  message: string;
  /** 上游 HTTP 状态码；400/422 通常意味着请求参数不合法。 */
  status?: number;
  /** 上游错误码（如 `invalid_request_error`）。 */
  code?: string;
};

const PARAMETER_LABELS: Readonly<Record<string, string>> = {
  aspectRatio: "宽高比",
  aspect_ratio: "宽高比",
  ratio: "宽高比",
  resolution: "分辨率",
  size: "尺寸",
  duration: "时长",
  durationSeconds: "时长",
  seconds: "时长",
  prompt: "提示词",
  model: "模型",
  mode: "生成模式"
};

/** 参数错误的通用兜底：不包含任何上游原始文本。 */
export const PARAMETER_ERROR_FALLBACK =
  "生成参数不符合模型要求，请检查提示词、宽高比、分辨率和时长后重试";

/**
 * 把上游失败消息映射成可行动文案。
 *
 * 只认少量稳定模式：`X is required`、`X must be greater than N`、
 * `X maximum value is N`、`X must be one of ...`。其余消息原样返回（调用方已做凭据裁剪）。
 */
export function describeTaskFailure(input: TaskFailureInput): string {
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (message === "") return PARAMETER_ERROR_FALLBACK;

  const parsed = readParameterFailure(message);
  if (parsed !== null) return parsed;

  if (isParameterStatus(input.status) || looksLikeParameterCode(input.code)) {
    return PARAMETER_ERROR_FALLBACK;
  }
  return message;
}

/**
 * 从一段可能包裹 JSON 的上游文本中提取参数错误；无法识别为参数错误时返回 null。
 */
export function readParameterFailure(raw: string): string | null {
  const text = extractMessage(raw);
  if (text === "") return null;

  const missing = collectMissingFields(text);
  if (missing.length > 0) {
    return missing
      .map((field) => `缺少必填参数「${labelOf(field)}」（${field}），请在执行面板补齐后重试`)
      .join("；");
  }

  const range = readDurationRange(text);
  if (range !== null) {
    const label = labelOf(range.field);
    const lower = range.minimum !== undefined ? `大于 ${range.minimum} 秒` : undefined;
    const upper = range.maximum !== undefined ? `不超过 ${range.maximum} 秒` : undefined;
    const bound = [lower, upper].filter((entry): entry is string => entry !== undefined).join("且");
    if (bound !== "") return `${label}需${bound}，请调整后再提交`;
  }

  const oneOf = readAllowedValues(text);
  if (oneOf !== null) {
    return `${labelOf(oneOf.field)}只支持 ${oneOf.allowed.join("、")}，请从允许范围内选择`;
  }

  return null;
}

function collectMissingFields(text: string): string[] {
  const fields: string[] = [];
  const patterns = [
    /\b([A-Za-z_][A-Za-z0-9_.]*)\s+(?:is|are)\s+required\b/gi,
    /\bmissing\s+(?:required\s+)?(?:parameter|field)\s*[:=]?\s*["'`]?([A-Za-z_][A-Za-z0-9_.]*)/gi,
    /\brequired\s+(?:parameter|field|property)\s*[:=]?\s*["'`]?([A-Za-z_][A-Za-z0-9_.]*)/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1] !== undefined) fields.push(match[1]);
    }
  }
  return [...new Set(fields)];
}

function readDurationRange(text: string): { field: string; minimum?: number; maximum?: number } | null {
  const maximum = /\b([A-Za-z_][A-Za-z0-9_.]*)?\s*maximum value is\s*(\d+(?:\.\d+)?)\s*(?:seconds?|s)?\b/i.exec(text);
  const minimum =
    /\b([A-Za-z_][A-Za-z0-9_.]*)?\s*must be (?:greater than|above|at least)\s*(\d+(?:\.\d+)?)\s*(?:seconds?|s)?\b/i.exec(text)
    ?? /\b([A-Za-z_][A-Za-z0-9_.]*)?\s*minimum value is\s*(\d+(?:\.\d+)?)\s*(?:seconds?|s)?\b/i.exec(text);
  if (maximum === null && minimum === null) return null;
  const field = maximum?.[1] || minimum?.[1] || "duration";
  return {
    field,
    ...(minimum?.[2] !== undefined ? { minimum: Number(minimum[2]) } : {}),
    ...(maximum?.[2] !== undefined ? { maximum: Number(maximum[2]) } : {})
  };
}

function readAllowedValues(text: string): { field: string; allowed: string[] } | null {
  const match =
    /\b([A-Za-z_][A-Za-z0-9_.]*)\s+(?:must be one of|should be one of|allowed values?(?: are|:))\s*([^\n]+)/i.exec(text);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  const allowed = match[2]
    .replace(/\b(?:but|got)\b.*$/i, "")
    .split(/[,，、]|\bor\b|\band\b/i)
    .map((entry) => entry.trim().replace(/^[[("'`]+|[\])"'`.,;]+$/g, ""))
    .filter((entry) => entry !== "");
  return allowed.length > 0 ? { field: match[1], allowed } : null;
}

/** 如果上游把整个 JSON 响应体当消息传回，只取里面的 `message`/`error` 文本。 */
function extractMessage(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith("{")) return text;
  try {
    const parsed: unknown = JSON.parse(text);
    const nested = readNestedMessage(parsed);
    if (nested !== null) return nested;
  } catch {
    // 不是合法 JSON：按原文处理。
  }
  return text;
}

function readNestedMessage(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim() !== "") return record.message;
  if (record.error !== undefined) {
    const nested = readNestedMessage(record.error);
    if (nested !== null) return nested;
  }
  return null;
}

function labelOf(field: string): string {
  return PARAMETER_LABELS[field] ?? field;
}

function isParameterStatus(status: number | undefined): boolean {
  return status === 400 || status === 422;
}

function looksLikeParameterCode(code: string | undefined): boolean {
  if (code === undefined) return false;
  return /invalid[_ -]?request|invalid[_ -]?param|parameter|validation/i.test(code);
}
