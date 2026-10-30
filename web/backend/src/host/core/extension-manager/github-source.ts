/**
 * 核心自带的 GitHub Release 市场来源（sourceId: github-release）。
 *
 * 与 local-file 同级：**不是**扩展插件，而是 Extension Manager 装配期注册的核心来源。
 * 这样做不违反 D3「来源插件只能来自内置根」——该规则防的是「市场装市场」的信任提升；
 * 核心自带来源随宿主发布，没有这个问题。来源仍只负责「找到并递交字节」：摘要、签名、
 * 预检与提交全部在 Manager（本文件返回的任何声明都不被信任，下载后逐项复核）。
 *
 * 候选发现：遍历本机配置 extensions.marketplace.github.repos 里的仓库，读取 Release 的
 * .wxt 资产；文件名约定 <extensionId>-<version>.wxt（pnpm pack:extension 的缺省输出
 * artifacts/extensions/<id>-<version>.wxt 正是这个格式），解析不出的资产跳过。
 *
 * 两条发现路径（产出同一份 GithubRelease[]，其余逻辑完全共用）：
 * - web（公共 GitHub、未配令牌时的缺省）：读 /{owner}/{repo}/releases?page=N 与
 *   /{owner}/{repo}/releases/expanded_assets/{tag}。**不消耗 REST API 限额**（匿名只有
 *   60 次/小时，很容易被限频）；资产行自带 sha256 摘要，摘要校验与 API 路径等价，
 *   下载走 releases/download/** 的 CDN 直链。
 * - api（配了令牌，或自建 GitHub / GitHub Enterprise Server）：私有仓库只能走 REST API。
 *
 * 摘要：GitHub 对 Release 资产给出 digest（sha256:<hex>）。拿不到 digest 的资产**无法参与
 * 安装**——resolve 返回 null。Manager 无法复核摘要的来源宁可失败不可瞎装。
 *
 * 出网边界：enabled 缺省 true（官方市场仓库随客户端内置），但只有真正搜索 / 解析时才发请求；
 * 关掉后来源不可用且绝不发请求。available() 只看配置，不预检网络，失败原因在真正调用时给出。
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
import { compareSemver, DEFAULT_GITHUB_MARKETPLACE_REPOS, maxSatisfying } from "@woohaa3/contracts";
import { ExtensionManagerError } from "./errors.js";

export const GITHUB_RELEASE_SOURCE_ID = "github-release";

/** 公共 GitHub REST API 基址；也是「走网页端点」的判定依据。 */
export const DEFAULT_GITHUB_API_BASE = "https://api.github.com";
/** 缺省市场仓库（公开仓，catalog.json + Release 资产）；定义在 contracts，与配置默认值同源。 */
export { DEFAULT_GITHUB_MARKETPLACE_REPOS };

const REQUEST_TIMEOUT_MS = 8_000;
const PER_PAGE = 30;
/** 网页每页固定条数：不足一页说明已经到底。 */
const WEB_PAGE_SIZE = 10;
/** 一次 search / resolve 每个仓库最多翻多少页：防止几千个 Release 的仓库拖死请求。 */
const MAX_PAGES = 10;
/**
 * 发现结果的本进程缓存时长：搜索 / 解析 / 下载会连续读同一批 Release。
 * 网页路径每个 Release 要单独取一次资产页，命中缓存能省掉整轮抓取，因此取 3 分钟。
 */
const CACHE_TTL_MS = 180_000;

/** extensionId 合法形状（与宿主其余各处的 kebab-case 约定一致）。 */
const EXTENSION_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** GitHub owner/repo：字母数字开头，允许连字符 / 下划线 / 点。 */
const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9._-]+$/;

/** 发现路径：web 走 github.com 网页端点（不吃 API 限额），api 走 REST（私有仓库 / GHES）。 */
export type GithubDiscovery = "web" | "api";

export type GithubSourceConfig = {
  /** 出网总开关：关闭时来源不可用，绝不发请求。 */
  enabled: boolean;
  /** 形如 "owner/repo" 的仓库 slug 列表。 */
  repos: readonly string[];
  /** GitHub REST API 基址（GitHub Enterprise Server 可换）。 */
  apiBase: string;
  /** 访问令牌：私有仓库 / 强制走 API；空串为匿名。 */
  token: string;
  /** 发现路径；缺省由 resolveDiscovery 按 apiBase / token 推导。 */
  discovery?: GithubDiscovery;
};

export type GithubSourceOptions = {
  /** 按调用现取（设置热重载即刻生效）。 */
  config: () => GithubSourceConfig;
  /** 测试注入；缺省 globalThis.fetch（Node 24 原生支持）。 */
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** 单个仓库的发现结果缓存时长；缺省 60s。测试可设为 0 关闭缓存。 */
  cacheTtlMs?: number;
};

/** 版本段：核心三段 semver，不带预发布 / 构建后缀（后缀里的连字符无法与 extensionId 无歧义拆分）。 */
const ASSET_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** 解析 Release 资产文件名 <extensionId>-<version>.wxt；任何不满足返回 null（不参与市场）。 */
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

/** extensions.marketplace.github.repos：逗号分隔的 owner/repo 列表 → 去重后的 slug 数组。 */
export function parseRepoList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const seen = new Set<string>();
  for (const entry of raw.split(",").map((item) => item.trim())) {
    if (entry && REPO_SLUG.test(entry)) seen.add(entry);
  }
  return [...seen];
}

/**
 * 由 REST API 基址推导网页基址：https://api.github.com → https://github.com；
 * 自建实例 https://<host>/api/v3 → https://<host>。
 */
export function webBaseOf(apiBase: string): string {
  const trimmed = apiBase.trim().replace(/\/+$/, "");
  if (trimmed === DEFAULT_GITHUB_API_BASE) return "https://github.com";
  const match = /^(https?:\/\/[^/]+)(?:\/.*)?$/.exec(trimmed);
  return match ? match[1]! : trimmed;
}

/**
 * 缺省发现路径：公共 GitHub 且没有令牌 → 网页端点（不吃 API 限额、匿名可用）；
 * 有令牌或换过 API 基址 → REST。私有仓库只有 REST 能带 Bearer。
 */
export function resolveDiscovery(config: Pick<GithubSourceConfig, "apiBase" | "token">): GithubDiscovery {
  if (config.token) return "api";
  return config.apiBase.trim().replace(/\/+$/, "") === DEFAULT_GITHUB_API_BASE ? "web" : "api";
}

export type GithubAsset = {
  readonly name: string;
  /**
   * 包大小（字节）。网页路径只能读到页面上四舍五入到 0.1 MiB 的人类可读文本，
   * 所以这里是**近似值**（实测偏差 < 0.1%）：只用于展示与进度，硬上限由下载时的
   * 实际字节数（writePackage）判定。
   */
  readonly size?: number;
  readonly digest?: string;
  /** 资产 API 地址：私有仓库只能靠它下载。 */
  readonly url?: string;
  readonly browser_download_url: string;
};

export type GithubRelease = {
  readonly tag_name?: string;
  readonly name?: string;
  /** 发布时间（ISO 8601）；缺失时不展示「更新于」。 */
  readonly published_at?: string;
  readonly assets?: readonly GithubAsset[];
};

/** 网页发现：/{repo}/releases?page=N 里的一条 Release（tag + 标题）。 */
export type GithubReleaseSummary = { readonly tag: string; readonly name?: string };

/**
 * 市场仓根目录的 catalog.json：给 GitHub Release 补人可读的名称 / 描述 / 图标 / 生效方式。
 * 全部可选；缺失、无权限或形状不对时退回 Release 自身的信息，不影响搜索与安装。
 */
export type GithubCatalogEntry = {
  readonly name?: string;
  readonly description?: string;
  readonly icon?: string;
  readonly hotReload?: boolean;
};

/** 目录文件名（仓库根）。 */
const CATALOG_FILE = "catalog.json";

/** 宽松解析目录：只收认识的字段；任何不合法条目直接忽略。 */
export function parseGithubCatalog(raw: unknown): Record<string, GithubCatalogEntry> {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isObject(raw) || !isObject(raw.extensions)) return {};
  const out: Record<string, GithubCatalogEntry> = {};
  for (const [extensionId, value] of Object.entries(raw.extensions)) {
    if (!EXTENSION_ID.test(extensionId) || !isObject(value)) continue;
    const entry: { name?: string; description?: string; icon?: string; hotReload?: boolean } = {};
    if (typeof value.name === "string" && value.name.trim()) entry.name = value.name.trim();
    if (typeof value.description === "string" && value.description.trim()) entry.description = value.description.trim();
    if (typeof value.icon === "string" && value.icon.trim()) entry.icon = value.icon.trim();
    if (typeof value.hotReload === "boolean") entry.hotReload = value.hotReload;
    if (Object.keys(entry).length > 0) out[extensionId] = entry;
  }
  return out;
}

/**
 * 解析 /{repo}/releases?page=N 的 HTML：每个 Release 一条，取 tag 与标题。
 *
 * GitHub 把每条 Release 渲染成以 <h2 class="sr-only" id="hd-…">标题</h2> 开头的一段，
 * 段内有 /releases/tag/<tag> 链接；按这个标题分块比匹配整段结构稳。
 * 只认能同时取到 tag 的块，其余忽略。
 */
export function parseReleasesPage(html: string): GithubReleaseSummary[] {
  const out: GithubReleaseSummary[] = [];
  const seen = new Set<string>();
  for (const block of html.split(/<h2 class="sr-only" id="hd-/).slice(1)) {
    const tag = /href="[^"]*\/releases\/tag\/([^"]+)"/.exec(block)?.[1];
    if (!tag) continue;
    const decoded = safeDecode(tag);
    if (!decoded || seen.has(decoded)) continue;
    seen.add(decoded);
    const titleEnd = block.indexOf("</h2>");
    const rawTitle = titleEnd > 0 ? block.slice(block.indexOf(">") + 1, titleEnd) : "";
    const name = decodeHtmlEntities(rawTitle).trim();
    out.push(name ? { tag: decoded, name } : { tag: decoded });
  }
  if (out.length > 0) return out;
  // 回退：GitHub 改标题块结构时，仍能从资产片段链接还原 tag（拿不到标题）。
  for (const match of html.matchAll(/\/releases\/expanded_assets\/([^"?#\s]+)/g)) {
    const decoded = safeDecode(match[1]!);
    if (!decoded || seen.has(decoded)) continue;
    seen.add(decoded);
    out.push({ tag: decoded });
  }
  return out;
}

/** 人类可读大小（18.4 MB）→ 近似字节数；无法解析时 undefined。 */
export function parseSizeText(text: string): number | undefined {
  const match = /^\s*([\d.]+)\s*(B|KB|MB|GB|TB)\s*$/i.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const unit = (match[2] ?? "B").toUpperCase();
  const factor = unit === "B" ? 1 : unit === "KB" ? 1024 : unit === "MB" ? 1024 ** 2 : unit === "GB" ? 1024 ** 3 : 1024 ** 4;
  return Math.round(value * factor);
}

/**
 * 解析 /{repo}/releases/expanded_assets/{tag} 的 HTML：资产名 / sha256 摘要 / 大小 / 下载地址。
 * 资产行是 Box-row 列表项，摘要以 sha256:<hex> 文本出现（与 REST 的 digest 是同一个值）。
 */
export function parseExpandedAssets(html: string, input: { webBase: string; repo: string; tag: string }): GithubAsset[] {
  const out: GithubAsset[] = [];
  const rows = html.match(/<li[^>]*class="[^"]*Box-row[^"]*"[\s\S]*?<\/li>/g) ?? [];
  for (const row of rows) {
    const href = /href="([^"]*\/releases\/download\/[^"]+)"/.exec(row)?.[1];
    if (!href) continue;
    const path = href.slice(href.indexOf("/releases/download/") + "/releases/download/".length);
    const segment = path.slice(path.lastIndexOf("/") + 1);
    const name = safeDecode(segment);
    if (!name) continue;
    const digest = row.match(/sha256:[0-9a-f]{64}/)?.[0];
    // 大小在独立的 span 里：>18.4 MB<
    const sizeText = /<span[^>]*>\s*([\d.]+\s*(?:B|KB|MB|GB|TB))\s*<\/span>/i.exec(row)?.[1];
    const size = sizeText ? parseSizeText(sizeText) : undefined;
    const absolute = href.startsWith("/") ? input.webBase + href : input.webBase + "/" + href;
    out.push({
      name,
      ...(size === undefined ? {} : { size }),
      ...(digest ? { digest } : {}),
      browser_download_url: absolute
    });
  }
  return out;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '\"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * 资产页上第一条资产的上传时间（ISO 8601）。网页 Releases 列表不渲染发布时间，
 * 资产上传时间是最接近「这个版本什么时候发的」的可用信号；取不到就不展示。
 */
export function parseAssetUploadedAt(html: string): string | undefined {
  const value = /<relative-time datetime="([^"]+)"/.exec(html)?.[1];
  if (!value) return undefined;
  const normalized = value.replace(" ", "T").replace(/ UTC$/, "Z");
  return Number.isNaN(Date.parse(normalized)) ? undefined : normalized;
}

const isSha256Digest = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);

const assetSize = (asset: GithubAsset, fallback: number): number =>
  typeof asset.size === "number" && Number.isFinite(asset.size) ? asset.size : fallback;

/**
 * 宿主 engines 的宽松声明（scripts/lib/extension-descriptor.mjs 的 HOST_ENGINES 镜像，
 * 两侧一致性由该脚本的测试约束）。GitHub 来源拿不到包内 extension.json 的 engines 声明，
 * resolve 填它只是让流水线走到预检；包内真实声明由预检复核，宽松前置不会放行不兼容的包。
 */
export function githubSourceHostEngines(): ExtensionEngines {
  return { hostAbi: "1.0.0", sdkAbi: "1.0.0", protocolVersion: 1 };
}

/**
 * GitHub Release 来源。配置经 config() 按调用现取，available() 只读配置不预检网络；
 * 搜索 / 解析 / 下载在真正失败时给出稳定中文原因（不把 GitHub 返回体带进错误信息）。
 */
export function createGithubReleaseSource(options: GithubSourceOptions): MarketplaceSource & Required<Pick<MarketplaceSourceDetails, "getExtension">> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
  /** 每个仓库最近一次发现结果；search / resolve / download 连续读同一批 Release。 */
  const cache = new Map<string, { at: number; releases: GithubRelease[] }>();

  const availability = (): MarketplaceAvailability => {
    const config = options.config();
    if (!config.enabled) return { ok: false, reason: "未启用 GitHub 扩展来源（extensions.marketplace.github.enabled）" };
    if (config.repos.length === 0) return { ok: false, reason: "未配置 GitHub 仓库列表" };
    return { ok: true };
  };

  const withTimeout = (signal?: AbortSignal) =>
    signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

  /** 统一的网络失败翻译：限流 / 不存在 / 其它都给出可照做的中文原因。 */
  const failure = (repo: string, status: number | null, timedOut: boolean, viaWeb: boolean): ExtensionManagerError => {
    if (timedOut) return new ExtensionManagerError("MARKETPLACE_SOURCE_UNAVAILABLE", "访问 GitHub 超时（" + repo + "）");
    if (status === null) return new ExtensionManagerError("MARKETPLACE_SOURCE_UNAVAILABLE", "无法连接 GitHub（" + repo + "）");
    if (status === 401 || status === 403 || status === 429) {
      const reason = viaWeb
        ? "GitHub 拒绝了网页请求 " + repo + "（可能被限流，稍后重试）"
        : "GitHub 拒绝访问 " + repo + "（令牌无效或已达限流，可配置 extensions.marketplace.github.token）";
      return new ExtensionManagerError("MARKETPLACE_SOURCE_UNAVAILABLE", reason);
    }
    if (status === 404) {
      return new ExtensionManagerError("MARKETPLACE_SOURCE_UNAVAILABLE", "GitHub 仓库不存在或无权访问：" + repo);
    }
    return new ExtensionManagerError("MARKETPLACE_SOURCE_UNAVAILABLE", "读取 " + repo + " 的 Release 失败（HTTP " + status + "）");
  };

  const request = async (url: string, headers: Record<string, string>, repo: string, viaWeb: boolean, signal?: AbortSignal): Promise<Response> => {
    let response: Response;
    try {
      response = await fetchImpl(url, { method: "GET", headers, signal: withTimeout(signal) });
    } catch (error) {
      throw failure(repo, null, error instanceof Error && error.name === "TimeoutError", viaWeb);
    }
    if (!response.ok) throw failure(repo, response.status, false, viaWeb);
    return response;
  };

  /** REST：GET {apiBase}/repos/{owner}/{repo}/releases?page=N。 */
  const fetchReleasesApi = async (repo: string, page: number, signal?: AbortSignal): Promise<GithubRelease[]> => {
    const config = options.config();
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (config.token) headers.Authorization = "Bearer " + config.token;
    const url = config.apiBase + "/repos/" + repo + "/releases?per_page=" + PER_PAGE + "&page=" + page;
    const response = await request(url, headers, repo, false, signal);
    const body = (await response.json().catch(() => null)) as unknown;
    return Array.isArray(body) ? (body as GithubRelease[]) : [];
  };

  /** 网页：读取 {webBase}/{repo}/releases?page=N 上的 tag 列表。 */
  const fetchReleasesWeb = async (repo: string, page: number, signal?: AbortSignal): Promise<GithubReleaseSummary[]> => {
    const config = options.config();
    const url = webBaseOf(config.apiBase) + "/" + repo + "/releases?page=" + page;
    const response = await request(url, { Accept: "text/html" }, repo, true, signal);
    return parseReleasesPage(await response.text());
  };

  /** 网页：读取一条 Release 的资产列表（名称 / 摘要 / 大小）与上传时间。失败只影响该 Release。 */
  const fetchAssetsWeb = async (
    repo: string,
    tag: string,
    signal?: AbortSignal
  ): Promise<{ assets: GithubAsset[]; publishedAt?: string }> => {
    const config = options.config();
    const webBase = webBaseOf(config.apiBase);
    const url = webBase + "/" + repo + "/releases/expanded_assets/" + encodeURIComponent(tag);
    const response = await request(url, { Accept: "text/html" }, repo, true, signal);
    const html = await response.text();
    const publishedAt = parseAssetUploadedAt(html);
    return {
      assets: parseExpandedAssets(html, { webBase, repo, tag }),
      ...(publishedAt ? { publishedAt } : {})
    };
  };

  /** 网页发现：分页取 tag，再逐条补齐资产（同一页的资产页并发读取）。 */
  const collectReleasesWeb = async (repo: string, signal?: AbortSignal): Promise<GithubRelease[]> => {
    const releases: GithubRelease[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = await fetchReleasesWeb(repo, page, signal);
      const fresh = batch.filter((entry) => !seen.has(entry.tag));
      if (fresh.length === 0) break;
      for (const entry of fresh) seen.add(entry.tag);
      const pages = await Promise.all(
        fresh.map((entry): Promise<{ assets: GithubAsset[]; publishedAt?: string }> =>
          fetchAssetsWeb(repo, entry.tag, signal).catch(() => ({ assets: [] as GithubAsset[] }))
        )
      );
      fresh.forEach((entry, index) => {
        const page = pages[index]!;
        releases.push({
          tag_name: entry.tag,
          ...(entry.name ? { name: entry.name } : {}),
          ...(page.publishedAt ? { published_at: page.publishedAt } : {}),
          assets: page.assets
        });
      });
      if (batch.length < WEB_PAGE_SIZE) break;
    }
    return releases;
  };

  /** 逐页拉取一个仓库的 Release，直到取空或到 MAX_PAGES 上限；结果按仓库缓存一小段时间。 */
  const collectReleases = async (repo: string, discovery: GithubDiscovery, signal?: AbortSignal): Promise<GithubRelease[]> => {
    const config = options.config();
    const key = discovery + "|" + config.apiBase + "|" + repo;
    const hit = cache.get(key);
    if (hit && cacheTtlMs > 0 && Date.now() - hit.at < cacheTtlMs) return hit.releases;
    let releases: GithubRelease[];
    if (discovery === "web") {
      releases = await collectReleasesWeb(repo, signal);
    } else {
      releases = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const batch = await fetchReleasesApi(repo, page, signal);
        releases.push(...batch);
        if (batch.length < PER_PAGE) break;
      }
    }
    if (cacheTtlMs > 0) cache.set(key, { at: Date.now(), releases });
    return releases;
  };

  /**
   * 读取仓库根目录的 catalog.json（可选）。失败一律按「没有目录」处理：
   * 搜索仍按 Release 给出候选，只是卡片退回 仓库@tag 与发行说明。
   * 网页路径走 {webBase}/{repo}/raw/HEAD/catalog.json（重定向到 raw CDN，不吃 API 限额）。
   */
  const fetchCatalog = async (repo: string, discovery: GithubDiscovery, signal?: AbortSignal): Promise<Record<string, GithubCatalogEntry>> => {
    const config = options.config();
    const headers: Record<string, string> = { Accept: discovery === "web" ? "text/plain" : "application/vnd.github.raw+json" };
    if (config.token) headers.Authorization = "Bearer " + config.token;
    const url =
      discovery === "web"
        ? webBaseOf(config.apiBase) + "/" + repo + "/raw/HEAD/" + CATALOG_FILE
        : config.apiBase + "/repos/" + repo + "/contents/" + CATALOG_FILE;
    try {
      const response = await fetchImpl(url, { method: "GET", headers, signal: withTimeout(signal) });
      if (!response.ok) return {};
      const body = await response.json().catch(() => null);
      return parseGithubCatalog(body);
    } catch {
      return {};
    }
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
      const discovery = config.discovery ?? resolveDiscovery(config);
      const text = query.text?.trim().toLowerCase() ?? "";
      // 同一扩展可能出现在多个仓库 / 多个 Release：合并后 latest 取最高 semver。
      // catalog.json 与 Release 并行读取：目录只补展示字段，候选仍完全由 Release 决定。
      const byExtension = new Map<string, { listing: MarketplaceListing; size?: number; publishedAt?: string }>();
      for (const repo of config.repos) {
        const [releases, catalog] = await Promise.all([collectReleases(repo, discovery, signal), fetchCatalog(repo, discovery, signal)]);
        for (const release of releases) {
          for (const asset of release.assets ?? []) {
            const parsed = parseAssetName(asset.name ?? "");
            if (!parsed) continue;
            const entry = catalog[parsed.extensionId];
            const existing = byExtension.get(parsed.extensionId);
            if (existing) {
              if (compareSemver(parsed.version, existing.listing.latest) > 0) {
                byExtension.set(parsed.extensionId, {
                  listing: { ...existing.listing, latest: parsed.version },
                  size: assetSize(asset, 0),
                  ...(release.published_at ? { publishedAt: release.published_at } : {})
                });
              }
              continue;
            }
            if (text && !parsed.extensionId.toLowerCase().includes(text) && !(entry?.name ?? "").toLowerCase().includes(text)) continue;
            const label = entry?.name ?? repo + "@" + (release.tag_name ?? parsed.version);
            const description = entry?.description ?? release.name;
            byExtension.set(parsed.extensionId, {
              listing: {
                extensionId: parsed.extensionId,
                label,
                latest: parsed.version,
                ...(description ? { description } : {}),
                ...(entry?.icon ? { icon: entry.icon } : {}),
                ...(entry?.hotReload !== undefined ? { hotReload: entry.hotReload } : {})
              },
              size: assetSize(asset, 0),
              ...(release.published_at ? { publishedAt: release.published_at } : {})
            });
          }
        }
      }
      // GitHub 的分页按仓库独立：多仓库合并没有统一的下一页游标，这里一次取全（页数有上限）。
      return {
        items: [...byExtension.values()].map(({ listing, size, publishedAt }) => ({
          ...listing,
          ...(size !== undefined ? { size } : {}),
          ...(publishedAt ? { publishedAt } : {})
        }))
      };
    },

    async resolve(extensionId: string, range: string, signal: AbortSignal): Promise<ReleaseRef | null> {
      const config = options.config();
      const discovery = config.discovery ?? resolveDiscovery(config);
      let best: ReleaseRef | null = null;
      for (const repo of config.repos) {
        const releases = await collectReleases(repo, discovery, signal);
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
      const discovery = config.discovery ?? resolveDiscovery(config);
      const versions: MarketplaceVersionInfo[] = [];
      const labels = new Map<string, string>();
      let catalogName: string | undefined;
      for (const repo of config.repos) {
        const [releases, catalog] = await Promise.all([collectReleases(repo, discovery, signal), fetchCatalog(repo, discovery, signal)]);
        catalogName ??= catalog[extensionId]?.name;
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
              ...(release.published_at ? { publishedAt: release.published_at } : {}),
              ...(digest ? {} : { state: "yanked", yankReason: "GitHub 未提供该资产的 sha256 摘要，无法安装" })
            });
          }
        }
      }
      if (versions.length === 0) return null;
      return {
        extensionId,
        label: catalogName ?? [...labels.values()][0] ?? extensionId,
        versions: versions.sort((a, b) => compareSemver(b.version, a.version))
      };
    },

    async download(ref: ReleaseRef, signal: AbortSignal): Promise<MarketplaceDownload> {
      const config = options.config();
      const discovery = config.discovery ?? resolveDiscovery(config);
      // ReleaseRef 不带资产 URL（契约只有 digest/size）：按约定文件名在配置的仓库里定位资产。
      const name = ref.extensionId + "-" + ref.version + ".wxt";
      let asset: GithubAsset | null = null;
      for (const repo of config.repos) {
        const releases = await collectReleases(repo, discovery, signal);
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
        throw new ExtensionManagerError("MARKETPLACE_SOURCE_NOT_FOUND", "GitHub 来源没有找到 " + name + "（可能已删除或摘要不符）");
      }
      // browser_download_url 是网页地址：私有仓库带 Bearer 也只会 404，必须改走资产 API。
      // 公开仓库无令牌时仍用网页直链——它由 CDN 提供，不消耗 API 限额。
      const viaApi = Boolean(config.token) && typeof asset.url === "string" && asset.url.startsWith(config.apiBase);
      const url = viaApi ? asset.url! : asset.browser_download_url;
      const size = assetSize(asset, ref.size);
      const headers: Record<string, string> = {};
      if (config.token) headers.Authorization = "Bearer " + config.token;
      // 资产 API 默认返回 JSON 元数据；只有显式声明 octet-stream 才给字节。
      if (viaApi) headers.Accept = "application/octet-stream";
      let response: Response;
      try {
        response = await fetchImpl(url, { method: "GET", headers, signal: withTimeout(signal) });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        throw new ExtensionManagerError("MARKETPLACE_DOWNLOAD_FAILED", timedOut ? "下载扩展包超时" : "下载扩展包失败");
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new ExtensionManagerError("MARKETPLACE_DOWNLOAD_FAILED", "下载扩展包失败（HTTP " + response.status + "）");
      }
      return { stream: response.body as ReadableStream<Uint8Array>, size };
    }
  };
}
