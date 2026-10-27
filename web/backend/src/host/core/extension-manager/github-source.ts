/**
 * 核心自带的 GitHub Release 市场来源（sourceId: `github-release`）。
 *
 * 与 local-file 同级：**不是**扩展插件，而是 Extension Manager 装配期注册的核心来源。
 * 这样做不违反 D3「来源插件只能来自内置根」——该规则防的是「市场装市场」的信任提升；
 * 核心自带来源随宿主发布，没有这个问题。来源仍只负责「找到并递交字节」：摘要、签名、
 * 预检与提交全部在 Manager（本文件返回的任何声明都不被信任，下载后逐项复核）。
 *
 * 候选发现：遍历本机配置 `extensions.marketplace.github.repos` 里的仓库，读取 Release 的
 * `.wxt` 资产；文件名约定 `<extensionId>-<version>.wxt`（`pnpm pack:extension` 的缺省输出
 * `artifacts/extensions/<id>-<version>.wxt` 正是这个格式），解析不出的资产跳过。
 *
 * 摘要：GitHub REST API 对 Release 资产提供 `digest`（`sha256:<hex>`）。API 未返回 digest 的
 * 资产**无法参与安装**——resolve 返回 null。Manager 无法复核摘要的来源宁可失败不可瞎装。
 *
 * 出网边界：`enabled` 缺省 false，未显式开启时不发起任何请求；`available()` 只看配置，
 * 不预检网络，失败原因在真正调用时给出。
 */
import type {
  ExtensionEngines,
  MarketplaceAvailability,
  MarketplaceDownload,
  MarketplaceExtensionInfo,
  MarketplaceListing,
  MarketplaceSearchPage,
  MarketplaceSearchQuery,
  MarketplaceSource,
  MarketplaceSourceDetails,
  MarketplaceVersionInfo,
  ReleaseRef
} from "@woohaa3/contracts";
import { compareSemver, maxSatisfying } from "@woohaa3/contracts";
import { ExtensionManagerError } from "./errors.js";

export const GITHUB_RELEASE_SOURCE_ID = "github-release";

const REQUEST_TIMEOUT_MS = 8_000;
const PER_PAGE = 30;
/** 一次 search / resolve 每个仓库最多翻多少页：防止几千个 Release 的仓库拖死请求。 */
const MAX_PAGES = 10;

/** extensionId 合法形状（与宿主其余各处的 kebab-case 约定一致）。 */
const EXTENSION_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** GitHub owner/repo：字母数字开头，允许连字符 / 下划线 / 点。 */
const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9._-]+$/;

export type GithubSourceConfig = {
  /** 出网总开关：未开启时来源不可用，绝不发请求。 */
  enabled: boolean;
  /** 形如 "owner/repo" 的仓库 slug 列表。 */
  repos: readonly string[];
  /** GitHub REST API 基址（GitHub Enterprise Server 可换）。 */
  apiBase: string;
  /** 访问令牌：私有仓库 / 提高限流用；空串为匿名。 */
  token: string;
};

export type GithubSourceOptions = {
  /** 按调用现取（设置热重载即刻生效）。 */
  config: () => GithubSourceConfig;
  /** 测试注入；缺省 globalThis.fetch（Node 24 原生支持）。 */
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
};

/** 版本段：核心三段 semver，不带预发布 / 构建后缀（后缀里的连字符无法与 extensionId 无歧义拆分）。 */
const ASSET_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * 解析 Release 资产文件名 `<extensionId>-<version>.wxt`。
 * 版本须是核心三段 semver（`1.2.3`；带预发布后缀的文件名无法无歧义拆分，一律拒绝），
 * extensionId 须是 kebab-case；任何不满足返回 null（该资产不参与市场）。
 */
export function parseAssetName(name: string): { extensionId: string; version: string } | null {
  if (!name.endsWith(".wxt")) return null;
  const base = name.slice(0, -4);
  // extensionId 自身可含连字符：版本段的起点取最后一个连字符。
  const lastDash = base.lastIndexOf("-");
  if (lastDash <= 0) return null;
  const extensionId = base.slice(0, lastDash);
  const version = base.slice(lastDash + 1);
  if (!EXTENSION_ID.test(extensionId) || !ASSET_VERSION.test(version)) return null;
  return { extensionId, version };
}

/** `extensions.marketplace.github.repos`：逗号分隔的 owner/repo 列表 → 去重后的 slug 数组。 */
export function parseRepoList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const seen = new Set<string>();
  for (const entry of raw.split(",").map((item) => item.trim())) {
    if (entry && REPO_SLUG.test(entry)) seen.add(entry);
  }
  return [...seen];
}

type GithubAsset = {
  readonly name: string;
  readonly size?: number;
  readonly digest?: string;
  /** 资产 API 地址（`{apiBase}/repos/.../releases/assets/<id>`）：私有仓库只能靠它下载。 */
  readonly url?: string;
  readonly browser_download_url: string;
};

type GithubRelease = {
  readonly tag_name?: string;
  readonly name?: string;
  readonly assets?: readonly GithubAsset[];
};

const isSha256Digest = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);

const assetSize = (asset: GithubAsset, fallback: number): number =>
  typeof asset.size === "number" && Number.isFinite(asset.size) ? asset.size : fallback;

/**
 * 宿主 engines 的宽松声明（`scripts/lib/extension-descriptor.mjs` `HOST_ENGINES` 的镜像，
 * 两侧一致性由该脚本的测试约束）。GitHub 来源拿不到包内 `extension.json` 的 engines 声明，
 * resolve 填它只是让流水线走到预检；包内真实声明由预检复核，宽松前置不会放行不兼容的包。
 */
export function githubSourceHostEngines(): ExtensionEngines {
  return { hostAbi: "1.0.0", sdkAbi: "1.0.0", protocolVersion: 1 };
}

/**
 * GitHub Release 来源。配置经 `config()` 按调用现取，`available()` 只读配置不预检网络；
 * 搜索 / 解析 / 下载在真正失败时给出稳定中文原因（不把 GitHub 返回体带进错误信息）。
 */
export function createGithubReleaseSource(options: GithubSourceOptions): MarketplaceSource & Required<Pick<MarketplaceSourceDetails, "getExtension">> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const availability = (): MarketplaceAvailability => {
    const config = options.config();
    if (!config.enabled) return { ok: false, reason: "未启用 GitHub 扩展来源（extensions.marketplace.github.enabled）" };
    if (config.repos.length === 0) return { ok: false, reason: "未配置 GitHub 仓库列表" };
    return { ok: true };
  };

  /** GET `{apiBase}/repos/{owner}/{repo}/releases?page=N`；非 2xx / 网络失败抛稳定中文错误。 */
  const fetchReleases = async (repo: string, page: number, signal?: AbortSignal): Promise<GithubRelease[]> => {
    const config = options.config();
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (config.token) headers.Authorization = `Bearer ${config.token}`;
    let response: Response;
    try {
      response = await fetchImpl(`${config.apiBase}/repos/${repo}/releases?per_page=${PER_PAGE}&page=${page}`, {
        method: "GET",
        headers,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new ExtensionManagerError("MARKETPLACE_SOURCE_UNAVAILABLE", timedOut ? `访问 GitHub 超时（${repo}）` : `无法连接 GitHub（${repo}）`);
    }
    if (response.status === 401 || response.status === 403) {
      // 403 兼作限流信号（匿名 60 次/小时）。
      throw new ExtensionManagerError("MARKETPLACE_SOURCE_UNAVAILABLE", `GitHub 拒绝访问 ${repo}（令牌无效或已达限流，可配置 extensions.marketplace.github.token）`);
    }
    if (response.status === 404) {
      throw new ExtensionManagerError("MARKETPLACE_SOURCE_UNAVAILABLE", `GitHub 仓库不存在或无权访问：${repo}`);
    }
    if (!response.ok) {
      throw new ExtensionManagerError("MARKETPLACE_SOURCE_UNAVAILABLE", `读取 ${repo} 的 Release 失败（HTTP ${response.status}）`);
    }
    const body = (await response.json().catch(() => null)) as unknown;
    return Array.isArray(body) ? (body as GithubRelease[]) : [];
  };

  /** 逐页拉取一个仓库的 Release，直到取空或到 MAX_PAGES 上限。 */
  const collectReleases = async (repo: string, signal?: AbortSignal): Promise<GithubRelease[]> => {
    const all: GithubRelease[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = await fetchReleases(repo, page, signal);
      all.push(...batch);
      if (batch.length < PER_PAGE) break;
    }
    return all;
  };

  /** 资产 → ReleaseRef；无有效 sha256 digest 的资产不可装（Manager 必须能复核摘要）。 */
  const assetToRef = (asset: GithubAsset, extensionId: string, version: string): ReleaseRef | null => {
    if (!isSha256Digest(asset.digest)) return null;
    return {
      sourceId: GITHUB_RELEASE_SOURCE_ID,
      extensionId,
      version,
      engines: githubSourceHostEngines(),
      packageDigest: asset.digest,
      size: assetSize(asset, 0)
    };
  };

  return {
    sourceId: GITHUB_RELEASE_SOURCE_ID,
    label: "GitHub Release",

    available: availability,

    async search(query: MarketplaceSearchQuery, signal: AbortSignal): Promise<MarketplaceSearchPage> {
      const config = options.config();
      const text = query.text?.trim().toLowerCase() ?? "";
      // 同一扩展可能出现在多个仓库 / 多个 Release：合并后 latest 取最高 semver。
      const byExtension = new Map<string, MarketplaceListing>();
      for (const repo of config.repos) {
        const releases = await collectReleases(repo, signal);
        for (const release of releases) {
          for (const asset of release.assets ?? []) {
            const parsed = parseAssetName(asset.name ?? "");
            if (!parsed) continue;
            const existing = byExtension.get(parsed.extensionId);
            if (existing) {
              if (compareSemver(parsed.version, existing.latest) > 0) {
                byExtension.set(parsed.extensionId, { ...existing, latest: parsed.version });
              }
              continue;
            }
            if (text && !parsed.extensionId.toLowerCase().includes(text)) continue;
            const label = `${repo}@${release.tag_name ?? parsed.version}`;
            const description = release.name ?? undefined;
            byExtension.set(parsed.extensionId, { extensionId: parsed.extensionId, label, latest: parsed.version, ...(description ? { description } : {}) });
          }
        }
      }
      // GitHub 的分页按仓库独立：多仓库合并没有统一的下一页游标，这里一次取全（页数有上限）。
      return { items: [...byExtension.values()] };
    },

    async resolve(extensionId: string, range: string, signal: AbortSignal): Promise<ReleaseRef | null> {
      const config = options.config();
      let best: ReleaseRef | null = null;
      for (const repo of config.repos) {
        const releases = await collectReleases(repo, signal);
        const candidates: ReleaseRef[] = [];
        for (const release of releases) {
          for (const asset of release.assets ?? []) {
            const parsed = parseAssetName(asset.name ?? "");
            if (!parsed || parsed.extensionId !== extensionId) continue;
            const ref = assetToRef(asset, extensionId, parsed.version);
            if (ref) candidates.push(ref);
          }
        }
        const chosen = maxSatisfying(candidates.map((entry) => entry.version), range);
        if (!chosen) continue;
        const ref = candidates.find((entry) => entry.version === chosen)!;
        if (!best || compareSemver(ref.version, best.version) > 0) best = ref;
      }
      return best;
    },

    /**
     * 版本详情（设置面「查看版本」与已撤回提示）。无 digest 的资产也列出但标记不可安装；
     * keyId 不填：GitHub 来源不发布公钥，信任只看本机 extensions.marketplace.trustedKeys。
     */
    async getExtension(extensionId: string, signal: AbortSignal, _includeVersions?: readonly string[]): Promise<MarketplaceExtensionInfo | null> {
      const config = options.config();
      const versions: MarketplaceVersionInfo[] = [];
      const labels = new Map<string, string>();
      for (const repo of config.repos) {
        const releases = await collectReleases(repo, signal);
        for (const release of releases) {
          for (const asset of release.assets ?? []) {
            const parsed = parseAssetName(asset.name ?? "");
            if (!parsed || parsed.extensionId !== extensionId) continue;
            if (!labels.has(repo)) labels.set(repo, release.name ?? release.tag_name ?? repo);
            const digest = isSha256Digest(asset.digest) ? asset.digest : "";
            versions.push({
              version: parsed.version,
              packageDigest: digest,
              size: assetSize(asset, 0),
              ...(digest ? {} : { state: "yanked", yankReason: "GitHub 未提供该资产的 sha256 摘要，无法安装" })
            });
          }
        }
      }
      if (versions.length === 0) return null;
      return {
        extensionId,
        label: [...labels.values()][0] ?? extensionId,
        versions: versions.sort((a, b) => compareSemver(b.version, a.version))
      };
    },

    async download(ref: ReleaseRef, signal: AbortSignal): Promise<MarketplaceDownload> {
      const config = options.config();
      // ReleaseRef 不带资产 URL（契约只有 digest/size）：按约定文件名在配置的仓库里定位资产。
      const name = `${ref.extensionId}-${ref.version}.wxt`;
      let asset: GithubAsset | null = null;
      for (const repo of config.repos) {
        const releases = await collectReleases(repo, signal);
        for (const release of releases) {
          const found = (release.assets ?? []).find((entry) => entry.name === name && entry.digest === ref.packageDigest);
          if (found) {
            asset = found;
            break;
          }
        }
        if (asset) break;
      }
      if (!asset) {
        throw new ExtensionManagerError("MARKETPLACE_SOURCE_NOT_FOUND", `GitHub 来源没有找到 ${name}（可能已删除或摘要不符）`);
      }
      // `browser_download_url` 是网页地址：私有仓库带 Bearer 也只会 404，必须改走资产 API。
      // 公开仓库无令牌时仍用网页直链——它由 CDN 提供，不消耗 API 限额。
      const viaApi = Boolean(config.token) && typeof asset.url === "string" && asset.url.startsWith(config.apiBase);
      const url = viaApi ? asset.url! : asset.browser_download_url;
      const size = assetSize(asset, ref.size);
      const headers: Record<string, string> = {};
      if (config.token) headers.Authorization = `Bearer ${config.token}`;
      // 资产 API 默认返回 JSON 元数据；只有显式声明 octet-stream 才给字节。
      if (viaApi) headers.Accept = "application/octet-stream";
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers,
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        throw new ExtensionManagerError("MARKETPLACE_DOWNLOAD_FAILED", timedOut ? "下载扩展包超时" : "下载扩展包失败");
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new ExtensionManagerError("MARKETPLACE_DOWNLOAD_FAILED", `下载扩展包失败（HTTP ${response.status}）`);
      }
      return { stream: response.body as ReadableStream<Uint8Array>, size };
    }
  };
}
