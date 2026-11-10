/**
 * LiteLLM 系**音频**模型的请求字段映射（共享实现）。
 *
 * 面板侧统一用语义键（`outputFormat`，与图片 / 视频同一套词汇），上游
 * `/v1/audio/speech` 要的是 `response_format`。音频没有版本化档位（音色 / 格式 / 语速
 * 由模型卡片给出），所以这里只有翻译，没有家族表。
 *
 * 只发上游认识的字段：把 `outputFormat` 原样透传过去，LiteLLM 会当成未知参数继续往下游
 * 送；`prompt` 是协议同级字段，不走 parameters。
 *
 * **只管语音合成**：音乐生成是另一条上游路由，参数集合不同（见 `musicRequestFields`）。
 */
const MIN_SPEED = 0.25;
const MAX_SPEED = 4;

export function audioRequestFields(
  parameters: Record<string, unknown>
): Record<string, string | number> {
  const fields: Record<string, string | number> = {};

  const voice = readText(parameters.voice);
  if (voice !== undefined) fields.voice = voice;

  // `response_format` / `format` 是旧面板与其它 Provider 的历史键，继续认。
  const format = readText(
    parameters.outputFormat ??
      parameters.response_format ??
      parameters.responseFormat ??
      parameters.format
  );
  if (format !== undefined) fields.response_format = format.toLowerCase();

  const speed = Number(parameters.speed);
  if (parameters.speed !== undefined && Number.isFinite(speed)) {
    // 面板已经按卡片收窄；这里再夹一次，避免批处理/重跑把越界值直接送给上游。
    fields.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
  }

  return fields;
}

/**
 * **音乐生成**的请求字段映射。
 *
 * `/v1/audio/music` 只认 `prompt`（协议同级）与 `lyrics`，不认音色、语速与 response_format。
 * 这些字段即使被提交上来也不能转发：上游会忽略它们或直接报参数错误，而真正的问题是
 * 「这些参数根本不属于这条路由」。
 */
export function musicRequestFields(
  parameters: Record<string, unknown>
): Record<string, string> {
  const fields: Record<string, string> = {};
  const lyrics = readText(parameters.lyrics);
  if (lyrics !== undefined) fields.lyrics = lyrics;
  return fields;
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
