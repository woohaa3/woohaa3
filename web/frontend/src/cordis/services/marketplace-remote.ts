/**
 * 扩展市场 remote（change: 2026-10-21-add-server-extension-marketplace，tasks 7.5 / design D8）。
 *
 * 浏览器只经本机宿主访问市场（服务端零 CORS，令牌不出宿主）：
 * - `GET  /api/extensions/marketplace/search?q=&sourceId=` → 列表 + 来源可用性；
 * - `GET  /api/extensions/marketplace/extension?sourceId=&extensionId=` → 版本 + 本机是否信任 keyId；
 * - `POST /api/extensions/install`（JSON `{ sourceId, extensionId, range }`）→ 202 `{ jobId, job }`。
 *
 * 「信任此公钥」写本机设置 `extensions.marketplace.trustedKeys`（经设置 remote，不在这里）。
 */
import type { ExtensionInstallJobView, ManagedVersionStatusView, MarketplaceExtensionDetailView, MarketplaceListing } from "@woohaa3/contracts";
import { getAppPublicFetch } from "./app-base-path.js";

export const MARKETPLACE_SEARCH_PATH = "/api/extensions/marketplace/search";
export const MARKETPLACE_EXTENSION_PATH = "/api/extensions/marketplace/extension";
export const MARKETPLACE_INSTALL_PATH = "/api/extensions/install";

export type MarketplaceRemoteError = { ok: false; code: string; error: string };
export type MarketplaceSourceStatus = { sourceId: string; label: string; ok: boolean; reason?: string };
export type MarketplaceSearchResult =
  | { ok: true; items: MarketplaceListing[]; nextCursor?: string; sources: MarketplaceSourceStatus[]; unavailable: Array<{ sourceId: string; reason: string }> }
  | MarketplaceRemoteError;
export type MarketplaceDetailResult = { ok: true; detail: MarketplaceExtensionDetailView } | MarketplaceRemoteError;
export type MarketplaceInstallResult = { ok: true; jobId: string; job?: ExtensionInstallJobView } | MarketplaceRemoteError;

export type MarketplaceRemote = {
  search(input: { text?: string; sourceId?: string }): Promise<MarketplaceSearchResult>;
  extension(input: { sourceId: string; extensionId: string }): Promise<MarketplaceDetailResult>;
  install(input: { sourceId: string; extensionId: string; range: string; acceptUntrusted?: boolean }): Promise<MarketplaceInstallResult>;
  /** 受管扩展当前版本在来源侧的状态（已撤回提示）；任何失败返回 null（不显示）。 */
  versionStatus(extensionId: string): Promise<ManagedVersionStatusView | null>;
};

const UNAVAILABLE: MarketplaceRemoteError = { ok: false, code: "unavailable", error: "无法连接本机服务" };

async function failure(response: Response, fallback: string): Promise<MarketplaceRemoteError> {
  const body = (await response.json().catch(() => null)) as { code?: unknown; message?: unknown } | null;
  return {
    ok: false,
    code: typeof body?.code === "string" ? body.code : response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : "unavailable",
    error: typeof body?.message === "string" && body.message ? body.message : fallback
  };
}

export function createMarketplaceRemote(options: { fetchImpl?: typeof globalThis.fetch } = {}): MarketplaceRemote {
  const fetchImpl = options.fetchImpl ?? getAppPublicFetch();
  return {
    async search(input) {
      const query = new URLSearchParams();
      if (input.text) query.set("q", input.text);
      if (input.sourceId) query.set("sourceId", input.sourceId);
      try {
        const response = await fetchImpl(`${MARKETPLACE_SEARCH_PATH}?${query.toString()}`, { method: "GET" });
        if (!response.ok) return failure(response, "搜索失败");
        const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body || !Array.isArray(body.items)) return { ok: false, code: "malformed", error: "宿主响应无法识别" };
        return {
          ok: true,
          items: body.items as MarketplaceListing[],
          ...(typeof body.nextCursor === "string" ? { nextCursor: body.nextCursor } : {}),
          sources: Array.isArray(body.sources) ? (body.sources as MarketplaceSourceStatus[]) : [],
          unavailable: Array.isArray(body.unavailable) ? (body.unavailable as Array<{ sourceId: string; reason: string }>) : []
        };
      } catch {
        return UNAVAILABLE;
      }
    },
    async extension(input) {
      const query = new URLSearchParams({ sourceId: input.sourceId, extensionId: input.extensionId });
      try {
        const response = await fetchImpl(`${MARKETPLACE_EXTENSION_PATH}?${query.toString()}`, { method: "GET" });
        if (!response.ok) return failure(response, "读取版本信息失败");
        const body = (await response.json().catch(() => null)) as MarketplaceExtensionDetailView | null;
        if (!body || !body.extension || !Array.isArray(body.extension.versions)) return { ok: false, code: "malformed", error: "宿主响应无法识别" };
        return { ok: true, detail: body };
      } catch {
        return UNAVAILABLE;
      }
    },
    async versionStatus(extensionId) {
      try {
        const response = await fetchImpl(`/api/extensions/${encodeURIComponent(extensionId)}/version-status`, { method: "GET" });
        if (!response.ok) return null;
        const body = (await response.json().catch(() => null)) as ManagedVersionStatusView | null;
        return body && typeof body.status === "string" ? body : null;
      } catch {
        return null;
      }
    },
    async install(input) {
      try {
        const response = await fetchImpl(MARKETPLACE_INSTALL_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input)
        });
        const body = (await response.clone().json().catch(() => null)) as { jobId?: unknown; job?: ExtensionInstallJobView } | null;
        if (typeof body?.jobId === "string" && (response.ok || response.status === 422)) {
          return { ok: true, jobId: body.jobId, ...(body.job && typeof body.job === "object" ? { job: body.job } : {}) };
        }
        return failure(response, "安装请求失败");
      } catch {
        return UNAVAILABLE;
      }
    }
  };
}