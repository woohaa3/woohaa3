/**
 * Canvas Catalog remote adapter
 * （change: 2026-09-29-add-multi-canvas-workspace，任务 2.2）。
 *
 * 唯一浏览器目录 HTTP 出口：`GET /api/canvases`（分页）、`GET /api/canvases/:id`（摘要）、
 * `POST /api/canvases`（创建）。所有响应经共享 decoder 校验；失败携带稳定 code，绝不回显
 * 服务端内部信息。
 *
 * 三个路由由画布服务的统一入口把关：本地单实例不启用访问控制，受控部署由同源会话身份与
 * 资源策略判定。
 */
import {
  decodeCanvasCreateResult,
  decodeCanvasDetailSummary,
  decodeCanvasListPage
} from "@woohaa3/contracts";
import { getAppPublicFetch } from "./app-base-path.js";
import { CANVAS_API_BASE_PATH } from "./paths.js";
import type {
  CanvasCatalogCreateResult,
  CanvasCatalogListResult,
  CanvasCatalogRemote,
  CanvasCatalogSummaryResult
} from "../contract/canvas-catalog.js";

export type CanvasCatalogRemoteOptions = {
  basePath?: string;
  fetchImpl?: typeof globalThis.fetch;
};

const READ_RETRY_DELAYS_MS = [300, 700, 1500, 2500];
const TRANSIENT_HTTP_STATUSES = new Set([502, 503, 504]);

function failureCode(status: number, parsed: unknown): string {
  const code = (parsed as { code?: unknown } | null)?.code;
  return typeof code === "string" && code !== "" ? code : `http-${status}`;
}

function failureMessage(status: number, parsed: unknown, fallback: string): string {
  const message = (parsed as { message?: unknown } | null)?.message;
  return typeof message === "string" && message !== "" ? message : `${fallback}（HTTP ${status}）`;
}

export function createCanvasCatalogRemote(options: CanvasCatalogRemoteOptions = {}): CanvasCatalogRemote {
  const basePath = (options.basePath ?? CANVAS_API_BASE_PATH).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? getAppPublicFetch();

  async function request(method: string, suffix: string, body?: unknown): Promise<
    { ok: true; json: unknown } | { ok: false; code: string; error: string }
  > {
    // 宿主热重载有短暂断连窗口；只重试读取，创建请求保留原本的一次提交语义。
    for (let attempt = 0; ; attempt += 1) {
      const delay = method === "GET" ? READ_RETRY_DELAYS_MS[attempt] : undefined;
      let response: Response;
      try {
        response = await fetchImpl(`${basePath}${suffix}`, {
          method,
          headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        });
      } catch {
        if (delay !== undefined) {
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        return { ok: false, code: "unavailable", error: "无法连接画布目录服务" };
      }
      const parsed = await response.json().catch(() => null);
      if (!response.ok) {
        if (delay !== undefined && TRANSIENT_HTTP_STATUSES.has(response.status)) {
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        return { ok: false, code: failureCode(response.status, parsed), error: failureMessage(response.status, parsed, "画布目录请求失败") };
      }
      return { ok: true, json: parsed };
    }
  }

  return {
    async list(input): Promise<CanvasCatalogListResult> {
      const params = new URLSearchParams({ offset: String(input.offset), limit: String(input.limit) });
      const result = await request("GET", `?${params.toString()}`);
      if (!result.ok) return result;
      const decoded = decodeCanvasListPage(result.json);
      if (!decoded.ok) return { ok: false, code: "malformed-response", error: decoded.error };
      return {
        ok: true,
        entries: decoded.page.items,
        total: decoded.page.total,
        offset: decoded.page.offset,
        limit: decoded.page.limit
      };
    },

    async get(canvasId): Promise<CanvasCatalogSummaryResult> {
      const result = await request("GET", `/${encodeURIComponent(canvasId)}`);
      if (!result.ok) return result;
      const decoded = decodeCanvasDetailSummary(result.json);
      if (!decoded.ok) return { ok: false, code: "malformed-response", error: decoded.error };
      return { ok: true, summary: decoded.summary };
    },

    async create(input): Promise<CanvasCatalogCreateResult> {
      const payload: Record<string, string> = {};
      if (input.canvasId) payload.canvasId = input.canvasId;
      if (input.title) payload.title = input.title;
      const result = await request("POST", "", payload);
      if (!result.ok) return result;
      const decoded = decodeCanvasCreateResult(result.json);
      if (!decoded.ok) return { ok: false, code: "malformed-response", error: decoded.error };
      return { ok: true, ...decoded.result };
    }
  };
}
