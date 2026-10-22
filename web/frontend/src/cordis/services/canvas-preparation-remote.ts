/**
 * 首次打开准备 remote adapter
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 5.1、5.5）。
 *
 * 唯一浏览器出口：
 * ```
 * GET  /api/canvas-sources                       活动来源目录（受认证）
 * GET  /api/canvas-sources/:sourceId/canvases    来源作品分页（受认证）
 * POST /api/canvases/:canvasId/prepare           幂等触发迁移
 * GET  /api/canvases/:canvasId/preparation       无副作用状态
 * ```
 *
 * 所有响应经共享 decoder 校验；失败带稳定 code，绝不回显服务端内部信息。未认证（401）返回
 * `UNAUTHENTICATED`，由上层决定是否隐藏入口。
 *
 * 四条路由由画布服务的统一入口把关：本地单实例不启用访问控制，受控部署由同源会话身份与
 * 资源策略判定。
 */
import {
  decodeCanvasSourceListPage,
  isCanvasSourceCatalogEntry,
  isPreparationState
} from "@woohaa3/contracts";
import { getAppPublicFetch } from "./app-base-path.js";
import { CANVAS_API_BASE_PATH, CANVAS_SOURCES_BASE_PATH } from "./paths.js";
import type {
  CanvasPreparationRemote
} from "../contract/canvas-preparation.js";

export type CanvasPreparationRemoteOptions = {
  sourcesBasePath?: string;
  canvasesBasePath?: string;
  fetchImpl?: typeof globalThis.fetch;
};

function failureCode(status: number, parsed: unknown): string {
  const code = (parsed as { code?: unknown } | null)?.code;
  return typeof code === "string" && code !== "" ? code : `http-${status}`;
}

function failureMessage(status: number, parsed: unknown, fallback: string): string {
  const message = (parsed as { message?: unknown } | null)?.message;
  return typeof message === "string" && message !== "" ? message : `${fallback}（HTTP ${status}）`;
}

export function createCanvasPreparationRemote(options: CanvasPreparationRemoteOptions = {}): CanvasPreparationRemote {
  const sourcesBasePath = (options.sourcesBasePath ?? CANVAS_SOURCES_BASE_PATH).replace(/\/$/, "");
  const canvasesBasePath = (options.canvasesBasePath ?? CANVAS_API_BASE_PATH).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? getAppPublicFetch();

  async function request(
    method: string,
    url: string,
    body?: unknown
  ): Promise<{ ok: true; status: number; json: unknown } | { ok: false; status: number; code: string; error: string; json: unknown }> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
    } catch {
      return { ok: false, status: 0, code: "unavailable", error: "无法连接画布服务", json: null };
    }
    const parsed = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, status: response.status, code: failureCode(response.status, parsed), error: failureMessage(response.status, parsed, "请求失败"), json: parsed };
    }
    return { ok: true, status: response.status, json: parsed };
  }

  return {
    async listSources() {
      const result = await request("GET", sourcesBasePath);
      if (!result.ok) return result;
      const sources = (result.json as { sources?: unknown } | null)?.sources;
      if (!Array.isArray(sources) || !sources.every(isCanvasSourceCatalogEntry)) {
        return { ok: false, code: "malformed-response", error: "来源目录响应形态非法" };
      }
      return { ok: true, sources };
    },

    async listAccessible(input) {
      const params = new URLSearchParams();
      if (input.cursor) params.set("cursor", input.cursor);
      if (input.limit !== undefined) params.set("limit", String(input.limit));
      const suffix = params.toString();
      const result = await request(
        "GET",
        `${sourcesBasePath}/${encodeURIComponent(input.sourceId)}/canvases${suffix ? `?${suffix}` : ""}`
      );
      if (!result.ok) return result;
      const decoded = decodeCanvasSourceListPage(result.json);
      if (!decoded.ok) return { ok: false, code: "malformed-response", error: decoded.error };
      return { ok: true, page: decoded.page };
    },

    async status(canvasId) {
      const result = await request("GET", `${canvasesBasePath}/${encodeURIComponent(canvasId)}/preparation`);
      // 410 DELETED 仍带合法 state 体；其它错误映射为失败。
      if (!result.ok) {
        if (result.status === 410) {
          const state = (result.json as { state?: unknown } | null)?.state;
          if (state && isPreparationState(result.json)) return { ok: true, state: result.json as never };
        }
        return { ok: false, code: result.code, error: result.error, ...(result.status === 409 ? { conflict: true } : {}) };
      }
      if (!isPreparationState(result.json)) {
        return { ok: false, code: "malformed-response", error: "准备态响应形态非法" };
      }
      return { ok: true, state: result.json };
    },

    async prepare(input) {
      const result = await request(
        "POST",
        `${canvasesBasePath}/${encodeURIComponent(input.canvasId)}/prepare`,
        input.sourceId ? { sourceId: input.sourceId } : {}
      );
      if (!result.ok) return { ok: false, code: result.code, error: result.error, status: result.status };
      if (!isPreparationState(result.json)) {
        return { ok: false, code: "malformed-response", error: "准备响应形态非法", status: result.status };
      }
      return { ok: true, state: result.json };
    }
  };
}
