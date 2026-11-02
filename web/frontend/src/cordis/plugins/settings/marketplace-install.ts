/**
 * 「从市场安装」状态（change: 2026-10-21-add-server-extension-marketplace，tasks 7.5 / design D7、D8）。
 *
 * - 来源选择（只列非 local-file 来源；只有一个时直接用它）、搜索、版本详情、安装（JSON 形态）；
 * - 搜索结果按「来源 + 查询词」缓存，切回看过的来源先出内容再后台刷新；刷新时间由界面展示，
 *   缓存本身不进 UI；
 * - keyId 未被本机信任时**不拦截安装**：只提示，失败语义仍由 Manager 的 `MARKETPLACE_SIGNATURE_INVALID`
 *   给出（不在前端预判，避免两处判定不一致）；
 * - 「信任此公钥」把公钥追加进本机 `extensions.marketplace.trustedKeys`（`<keyId>=<公钥>`），由调用方二次确认后才写。
 * 安装进度复用 P1 的任务视图：安装受理后把任务交给受管扩展控制器跟踪。
 */
import { compareSemver } from "@woohaa3/contracts";
import type { ExtensionInstallJobView, MarketplaceExtensionDetailView, MarketplaceListing, MarketplaceSigningKey } from "@woohaa3/contracts";
import type { MarketplaceRemote, MarketplaceSourceStatus } from "../../services/marketplace-remote.js";

export const TRUSTED_KEYS_SETTING = "extensions.marketplace.trustedKeys";

/** 同一来源 / 查询词的缓存有效期；超过后重新拉取（切回来源仍先展示旧内容再刷新）。 */
const CACHE_TTL_MS = 5 * 60_000;

export type MarketplaceInstallState = {
  sources: MarketplaceSourceStatus[];
  sourceId: string | null;
  query: string;
  searching: boolean;
  /** 后台刷新中：保留当前列表，只更新状态行。 */
  refreshing: boolean;
  /** 最近一次成功搜索的时间（ms）；界面据此显示「更新于 hh:mm」。 */
  fetchedAt: number | null;
  items: MarketplaceListing[];
  /** 当前来源不可用的原因（本地模式 / 未登录 / 服务端未启用）。 */
  unavailableReason: string | null;
  selected: { extensionId: string; loading: boolean; detail: MarketplaceExtensionDetailView | null; version: string | null } | null;
  installing: boolean;
  /** 正在安装的扩展 id（列表卡片据此只给对应卡片显示进度）。 */
  installingId: string | null;
  trusting: string | null;
  error: string | null;
  notice: string | null;
};

export type MarketplaceInstallController = {
  getState(): MarketplaceInstallState;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  /** 保留列表的后台刷新；界面据此显示「正在刷新…」。 */
  refresh(): Promise<void>;
  setSource(sourceId: string): Promise<void>;
  search(text: string): Promise<void>;
  select(extensionId: string): Promise<void>;
  chooseVersion(version: string): void;
  close(): void;
  install(): Promise<void>;
  /** 从列表直接按精确版本安装，不切换详情；失败原因与 install 相同。 */
  installListed(extensionId: string, version: string): Promise<void>;
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
  if (!entry?.keyId || /^[a-f0-9]{64}$/.test(entry.keyId)) return null;
  return detail.trustedKeyIds.includes(entry.keyId);
}

/** 把一个公钥追加进信任根原始值（逗号分隔，同 keyId 不重复）。 */
export function appendTrustedKey(raw: string, key: MarketplaceSigningKey): string {
  const entries = raw.split(",").map((item) => item.trim()).filter(Boolean);
  if (entries.some((item) => item.startsWith(`${key.keyId}=`))) return entries.join(",");
  return [...entries, `${key.keyId}=${key.publicKey}`].join(",");
}

type CachedSearch = {
  sources: MarketplaceSourceStatus[];
  sourceId: string | null;
  items: MarketplaceListing[];
  unavailableReason: string | null;
  fetchedAt: number;
};

export function createMarketplaceInstallController(options: MarketplaceInstallOptions): MarketplaceInstallController {
  const listeners = new Set<() => void>();
  let state: MarketplaceInstallState = {
    sources: [],
    sourceId: null,
    query: "",
    searching: false,
    refreshing: false,
    fetchedAt: null,
    items: [],
    unavailableReason: null,
    selected: null,
    installing: false,
    installingId: null,
    trusting: null,
    error: null,
    notice: null
  };
  let searchSeq = 0;
  const cache = new Map<string, CachedSearch>();
  const cacheKey = (sourceId: string | null, text: string) => `${sourceId ?? "auto"}::${text}`;
  const set = (patch: Partial<MarketplaceInstallState>) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const readCache = (sourceId: string | null, text: string): CachedSearch | undefined => {
    const key = cacheKey(sourceId, text);
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
      cache.delete(key);
      return undefined;
    }
    return entry;
  };

  const writeCache = (sourceId: string | null, text: string, entry: CachedSearch) => {
    cache.set(cacheKey(sourceId, text), entry);
  };

  /** 应用一份缓存：先出内容，再后台刷新（背景刷新失败时保留列表并显示错误）。 */
  const applyCache = (entry: CachedSearch, query: string) => {
    set({ ...entry, query, searching: false, refreshing: false, error: null });
  };

  const runSearch = async (text: string, sourceId: string | null, background = false) => {
    const seq = ++searchSeq;
    set(background ? { refreshing: true, query: text, error: null } : { searching: true, query: text, error: null });
    const result = await options.remote.search({ ...(text ? { text } : {}), ...(sourceId ? { sourceId } : {}) });
    if (seq !== searchSeq) return;
    if (!result.ok) {
      set({ searching: false, refreshing: false, error: result.error });
      return;
    }
    const sources = result.sources;
    const chosen = sourceId ?? (sources.find((source) => source.ok)?.sourceId ?? sources[0]?.sourceId ?? null);
    const status = sources.find((source) => source.sourceId === chosen);
    const unavailable = result.unavailable.find((entry) => entry.sourceId === chosen)?.reason ?? (status && !status.ok ? status.reason ?? "来源不可用" : null);
    // 第一次加载未指定来源时，按选中的来源重新过滤结果（多来源时 items 合并了全部）。
    if (!sourceId && chosen && sources.length > 1) {
      set({ sources, sourceId: chosen });
      await runSearch(text, chosen, background);
      return;
    }
    const entry: CachedSearch = {
      sources,
      sourceId: chosen,
      items: unavailable ? [] : [...result.items],
      unavailableReason: unavailable,
      fetchedAt: Date.now()
    };
    set({ searching: false, refreshing: false, ...entry });
    writeCache(chosen, text, entry);
    writeCache(null, text, entry);
  };

  const refreshDetail = async (extensionId: string, keepVersion: string | null) => {
    if (!state.sourceId) return;
    // 切换扩展时不要沿用上一份详情：加载期间只显示 id，避免标题与版本错位。
    set({
      selected: { extensionId, loading: true, detail: state.selected?.extensionId === extensionId ? state.selected.detail : null, version: keepVersion },
      error: null
    });
    const result = await options.remote.extension({ sourceId: state.sourceId, extensionId });
    if (state.selected?.extensionId !== extensionId) return;
    if (!result.ok) {
      set({ selected: { extensionId, loading: false, detail: null, version: null }, error: result.error });
      return;
    }
    const versions = result.detail.extension.versions;
    // 来源的版本顺序不保证；缺省选最高版本，不依赖数组末位。
    const latest = versions.reduce<string | null>((best, entry) => (best === null || compareSemver(entry.version, best) > 0 ? entry.version : best), null);
    const version = keepVersion && versions.some((entry) => entry.version === keepVersion) ? keepVersion : latest;
    set({ selected: { extensionId, loading: false, detail: result.detail, version } });
  };

  /** 安装按精确版本受理；不经过详情也能用（列表卡片的直接安装）。 */
  const startInstall = async (extensionId: string, version: string) => {
    if (!state.sourceId || state.installing) return;
    set({ installing: true, installingId: extensionId, error: null, notice: null });
    const result = await options.remote.install({ sourceId: state.sourceId, extensionId, range: version });
    if (!result.ok) {
      set({ installing: false, installingId: null, error: result.error });
      return;
    }
    options.onJob(result.jobId, result.job);
    // 受理即交给任务列表：进度与终态都在那里，不再额外写一句会过期的「已开始安装」。
    set({ installing: false, installingId: null });
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async load() {
      // 已经有选中的来源时沿用，不要因为「自动」缓存把用户切回第一个来源。
      const sourceId = state.sourceId;
      const hit = (sourceId ? readCache(sourceId, "") : undefined) ?? readCache(null, "");
      if (hit) {
        applyCache(hit, "");
        void runSearch("", sourceId, true);
        return;
      }
      await runSearch("", sourceId, false);
    },
    async refresh() {
      await runSearch(state.query, state.sourceId, true);
    },
    async setSource(sourceId) {
      set({ sourceId, selected: null, items: [], fetchedAt: null, error: null });
      const hit = readCache(sourceId, state.query);
      if (hit) {
        applyCache(hit, state.query);
        void runSearch(state.query, sourceId, true);
        return;
      }
      await runSearch(state.query, sourceId, false);
    },
    async search(text) {
      const hit = readCache(state.sourceId, text);
      if (hit) {
        applyCache(hit, text);
        void runSearch(text, state.sourceId, true);
        return;
      }
      await runSearch(text, state.sourceId, false);
    },
    select: (extensionId) => refreshDetail(extensionId, null),
    chooseVersion(version) {
      if (state.selected) set({ selected: { ...state.selected, version } });
    },
    close() {
      set({ selected: null, notice: null });
    },
    async install() {
      const selected = state.selected;
      if (!selected?.version) return;
      await startInstall(selected.extensionId, selected.version);
    },
    installListed: (extensionId, version) => startInstall(extensionId, version),
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
