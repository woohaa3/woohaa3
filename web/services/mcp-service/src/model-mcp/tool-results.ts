/**
 * Model Canvas MCP HTTP：工具结果渲染与错误
 * （自 `mcp-http.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R11）。
 */

export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Preserve the complete payload in text as well: several native clients omit
 * structuredContent when forwarding MCP results to the model.
 */
export function jsonResult(value: unknown) {
  const structured = isStructuredObject(value) ? value : undefined;
  return {
    content: [{ type: "text" as const, text: summarizeForContent(value) }, { type: "text" as const, text: JSON.stringify(value) ?? "null" }],
    ...(structured ? { structuredContent: structured } : {})
  };
}

/**
 * 模型规模统计的稳定单行摘要（change: 2026-10-18-align-model-statistics-with-agent）。
 *
 * 文本 content 是多数 Agent 客户端真正读到的内容；把与聚焦面板同源的数字写进摘要，
 * 模型就不必（也不应）再按 API 成本表自行推算。
 */
export function formatModelStatistics(value: unknown): string | null {
  if (!isStructuredObject(value)) return null;
  const statistics = value.statistics;
  if (!isStructuredObject(statistics)) return null;
  const read = (key: string): number | null => {
    const field = statistics[key];
    return typeof field === "number" && Number.isFinite(field) ? field : null;
  };
  const objects = read("objects");
  const vertices = read("vertices");
  const triangles = read("triangles");
  if (objects === null || vertices === null || triangles === null) return null;
  const parts = [`对象 ${objectCount(objects)}`, `点数 ${objectCount(vertices)}`, `面数 ${objectCount(triangles)}`];
  const groups = read("groups");
  const materials = read("materials");
  const animations = read("animations");
  if (groups !== null && groups > 0) parts.push(`分组 ${objectCount(groups)}`);
  if (materials !== null && materials > 0) parts.push(`材质 ${objectCount(materials)}`);
  if (animations !== null && animations > 0) parts.push(`动画 ${objectCount(animations)}`);
  return parts.join(" / ");
}

/** 千分位整数（与聚焦面板 `formatCount` 同一呈现）。 */
function objectCount(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

/** 由机器结果派生简短人类可读摘要（不序列化完整 payload）。 */
export function summarizeForContent(value: unknown): string {
  if (!isStructuredObject(value)) return "ok";
  if (value.ok === false) {
    return typeof value.message === "string" && value.message !== "" ? value.message : (typeof value.code === "string" ? value.code : "error");
  }
  const parts = ["ok"];
  if (value.source === "candidate") parts.push("候选脚本");
  if (value.source === "current") parts.push("当前脚本");
  for (const key of ["canvasId", "nodeId", "nodeType", "requestId", "commandId", "runId", "jobId"] as const) {
    const field = value[key];
    if (typeof field === "string" && field !== "") parts.push(`${key}=${field}`);
  }
  if (typeof value.revision === "number") parts.push(`revision=${value.revision}`);
  if (value.duplicate === true) parts.push("duplicate");
  if (value.idempotent === true) parts.push("idempotent");
  const statistics = formatModelStatistics(value);
  if (statistics) parts.push(statistics);
  return parts.join(" ");
}

export function isStructuredObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toolError(message: unknown, code = "unavailable") {
  // Runtime ports can return malformed failures despite their static types.
  // An undefined text property disappears in JSON and breaks every MCP client.
  const text = typeof message === "string" && message.trim() !== ""
    ? message
    : isStructuredObject(message) && typeof message.message === "string"
      ? message.message
      : `工具执行失败（${code}）：上游未提供错误说明`;
  const error = { error: text, code };
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { ok: false, ...error } as Record<string, unknown>,
    isError: true
  };
}

export function normalizePath(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}
