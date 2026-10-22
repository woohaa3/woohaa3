/**
 * grsai 统一生成接口的响应解读（纯函数）。
 *
 * 提交：`{id, status:"running"}`；查询：`{id, status, progress, results:[{url}], error}`；
 * 状态取值为 `running | succeeded | failed | violation`，结果地址 2 小时后失效。
 */

export type GrsaiResultView =
  | { state: "pending"; phase: "queued" | "running"; progress?: number }
  | { state: "completed"; urls: string[] }
  | { state: "failed"; error: string };

/** 提交/查询里可能带失败信息：`{status:"failed",error}` 或 `{error}`。 */
export function grsaiErrorMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const status = typeof payload.status === "string" ? payload.status.trim().toLowerCase() : "";
  const error = payload.error;
  const direct = typeof error === "string" ? error.trim() : "";
  if (direct) return direct.slice(0, 400);
  if (isRecord(error)) {
    const message = typeof error.message === "string" ? error.message.trim() : "";
    if (message) return message.slice(0, 400);
    return JSON.stringify(error).slice(0, 400);
  }
  if (status === "failed" || status === "violation") return `grsai 任务结束于 ${status}`;
  const msg = typeof payload.msg === "string" ? payload.msg.trim() : "";
  if (msg && payload.code !== undefined && payload.code !== 0 && payload.code !== "0") return msg.slice(0, 400);
  return undefined;
}

export function grsaiTaskId(payload: unknown): string {
  if (!isRecord(payload)) return "";
  const id = payload.id;
  if (typeof id === "string" && id.trim()) return id.trim();
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return "";
}

export function interpretGrsaiResult(payload: unknown): GrsaiResultView {
  const record = isRecord(payload) ? payload : {};
  const status = typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
  const progress = progressOf(record.progress);
  switch (status) {
    case "succeeded":
    case "success":
    case "completed":
    case "complete":
    case "done": {
      const urls = collectUrls(record.results ?? record);
      if (urls.length === 0) return { state: "failed", error: "grsai 没有返回输出地址" };
      return { state: "completed", urls };
    }
    case "failed":
    case "failure":
    case "error":
    case "violation":
    case "cancelled":
    case "canceled":
      return { state: "failed", error: grsaiErrorMessage(record) ?? `grsai 任务结束于 ${status}` };
    case "pending":
    case "queued":
    case "created":
    case "waiting":
      return { state: "pending", phase: "queued", ...(progress !== undefined ? { progress } : {}) };
    case "running":
    case "processing":
    case "in_progress":
    default: {
      // 状态缺失但已经有输出：按完成处理，避免任务在轮询里空转。
      if (!status) {
        const urls = collectUrls(record.results ?? record);
        if (urls.length > 0) return { state: "completed", urls };
      }
      return { state: "pending", phase: "running", ...(progress !== undefined ? { progress } : {}) };
    }
  }
}

function progressOf(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(number) || number < 0) return undefined;
  return number <= 1 ? Math.round(number * 100) : Math.round(number);
}

/** 结果地址可能在 `results[{url}]`、`url`、`urls[]` 或 `images[]`。 */
export function collectUrls(value: unknown): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      if (/^https?:\/\//i.test(node) && !seen.has(node)) {
        seen.add(node);
        urls.push(node);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isRecord(node)) return;
    for (const key of ["url", "urls", "image", "images", "result", "results", "output", "data"]) {
      if (key in node) visit(node[key]);
    }
  };
  visit(value);
  return urls;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
