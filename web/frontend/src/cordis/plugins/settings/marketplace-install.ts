/**
 * 「从市场安装」状态（change: 2026-10-21-add-server-extension-marketplace，tasks 7.5 / design D7、D8）。
 *
 * - 来源选择（只列非 local-file 来源；只有一个时直接用它）、搜索、版本详情、安装（JSON 形态）；
 * - keyId 未被本机信任时**不拦截安装**：只提示，失败语义仍由 Manager 的 `MARKETPLACE_SIGNATURE_INVALID`
 *   给出（不在前端预判，避免两处判定不一致）；
 * - 「信任此公钥」把公钥追加进本机 `extensions.marketplace.trustedKeys`（`<keyId>=<公钥>`），由调用方二次确认后才写。
 * 安装进度复用 P1 的任务视图：安装受理后把任务交给受管扩展控制器跟踪。
 */
import type { ExtensionInstallJobView, MarketplaceExtensionDetailView, MarketplaceListing, MarketplaceSigningKey } from "@woohaa3/contracts";
import type { MarketplaceRemote, MarketplaceSourceStatus } from "../../services/marketplace-remote.js";

export const TRUSTED_KEYS_SETTING = "extensions.marketplace.trustedKeys";

export type MarketplaceInstallState = {
  sources: MarketplaceSourceStatus[];
  sourceId: string | null;
  query: string;
  searching: boolean;
  items: MarketplaceListing[];
  /** 当前来源不可用的原因（本地模式 / 未登录 / 服务端未启用）。 */
  unavailableReason: string | null;
  selected: { extensionId: string; loading: boolean; detail: MarketplaceExtensionDetailView | null; version: string | null } | null;
  installing: boolean;
  trusting: string | null;
  error: string | null;
  notice: string | null;
};

export type MarketplaceInstallController = {
  getState(): MarketplaceInstallState;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  setSource(sourceId: string): Promise<void>;
  search(text: string): Promise<void>;
  select(extensionId: string): Promise<void>;
  chooseVersion(version: string): void;
  close(): void;
  install(): Promise<void>;
  /** 调用前须由 UI 二次确认。 */
  trustKey(key: MarketplaceSigningKey): Promise<void>;
};

export type MarketplaceInstallOptions = {
  remote: MarketplaceRemote;
  /** 安装受理后交给受管扩展控制器跟踪进度。 */
  onJob: (jobId: string, job?: ExtensionInstallJobView) => void;
  /** 读取当前本机信任根原始值。 */
  readTrustedKeys: () => string;
  /** 写本机设置（成功后调用方会重取快照）。 */
  writeSetting: (key: string, value: string) => Promise<{ ok: true } | { ok: false; error: string }>;
};

/** 版本的 keyId 是否被本机信任（以宿主投影的 `trustedKeyIds` 为准）。 */
export function versionTrusted(detail: MarketplaceExtensionDetailView, version: string | null): boolean | null {
  const entry = detail.extension.versions.find((item) => item.version === version);
  if (!entry?.keyId) return null;
  return detail.trustedKeyIds.includes(entry.keyId);
}

/** 把一个公钥追加进信任根原始值（逗号分隔，同 keyId 不重复）。 */
export function appendTrustedKey(raw: string, key: MarketplaceSigningKey): string {
  const entries = raw.split(",").map((item) => item.trim()).filter(Boolean);
  if (entries.some((item) => item.startsWith(`${key.keyId}=`))) return entries.join(",");
  return [...entries, `${key.keyId}=${key.publicKey}`].join(",");
}

export function createMarketplaceInstallController(options: MarketplaceInstallOptions): MarketplaceInstallController {
  const listeners = new Set<() => void>();
  let state: MarketplaceInstallState = {
    sources: [],
    sourceId: null,
    query: "",
    searching: false,
    items: [],
    unavailableReason: null,
    selected: null,
    installing: false,
    trusting: null,
    error: null,
    notice: null
  };
  let searchSeq = 0;
  const set = (patch: Partial<MarketplaceInstallState>) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const runSearch = async (text: string, sourceId: string | null) => {
    const seq = ++searchSeq;
    set({ searching: true, query: text, error: null });
    const result = await options.remote.search({ ...(text ? { text } : {}), ...(sourceId ? { sourceId } : {}) });
    if (seq !== searchSeq) return;
    if (!result.ok) {
      set({ searching: false, error: result.error });
      return;
    }
    const sources = result.sources;
    const chosen = sourceId ?? (sources.find((source) => source.ok)?.sourceId ?? sources[0]?.sourceId ?? null);
    const status = sources.find((source) => source.sourceId === chosen);
    const unavailable = result.unavailable.find((entry) => entry.sourceId === chosen)?.reason ?? (status && !status.ok ? status.reason ?? "来源不可用" : null);
    // 第一次加载未指定来源时，按选中的来源重新过滤结果（多来源时 items 合并了全部）。
    if (!sourceId && chosen && sources.length > 1) {
      set({ sources, sourceId: chosen });
      await runSearch(text, chosen);
      return;
    }
    set({ searching: false, sources, sourceId: chosen, items: unavailable ? [] : result.items, unavailableReason: unavailable });
  };

  const refreshDetail = async (extensionId: string, keepVersion: string | null) => {
    if (!state.sourceId) return;
    set({ selected: { extensionId, loading: true, detail: state.selected?.detail ?? null, version: keepVersion }, error: null });
    const result = await options.remote.extension({ sourceId: state.sourceId, extensionId });
    if (state.selected?.extensionId !== extensionId) return;
    if (!result.ok) {
      set({ selected: { extensionId, loading: false, detail: null, version: null }, error: result.error });
      return;
    }
    const versions = result.detail.extension.versions;
    const version = keepVersion && versions.some((entry) => entry.version === keepVersion) ? keepVersion : versions.at(-1)?.version ?? null;
    set({ selected: { extensionId, loading: false, detail: result.detail, version } });
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load: () => runSearch("", null),
    async setSource(sourceId) {
      set({ sourceId, selected: null, items: [] });
      await runSearch(state.query, sourceId);
    },
    search: (text) => runSearch(text, state.sourceId),
    select: (extensionId) => refreshDetail(extensionId, null),
    chooseVersion(version) {
      if (state.selected) set({ selected: { ...state.selected, version } });
    },
    close() {
      set({ selected: null, notice: null });
    },
    async install() {
      const selected = state.selected;
      if (!selected?.version || !state.sourceId || state.installing) return;
      set({ installing: true, error: null, notice: null });
      // range 缺省为所选精确版本（D8）。
      const result = await options.remote.install({ sourceId: state.sourceId, extensionId: selected.extensionId, range: selected.version });
      if (!result.ok) {
        set({ installing: false, error: result.error });
        return;
      }
      options.onJob(result.jobId, result.job);
      // 受理即交给任务列表：进度与终态都在那里，不再额外写一句会过期的「已开始安装」。
      set({ installing: false });
    },
    async trustKey(key) {
      if (state.trusting) return;
      set({ trusting: key.keyId, error: null });
      const next = appendTrustedKey(options.readTrustedKeys(), key);
      const result = await options.writeSetting(TRUSTED_KEYS_SETTING, next);
      if (!result.ok) {
        set({ trusting: null, error: result.error });
        return;
      }
      set({ trusting: null, notice: `已信任公钥 ${key.keyId}` });
      if (state.selected) await refreshDetail(state.selected.extensionId, state.selected.version);
    }
  };
}
