/** GitHub Release 市场来源：文件名解析 / semver 选择 / digest 缺失 / 分页 / 下载（mock fetch，不打真实 GitHub）。 */
import { describe, expect, it } from "vitest";
import type { MarketplaceSearchPage } from "@woohaa3/contracts";
import { createGithubReleaseSource, GITHUB_RELEASE_SOURCE_ID, githubSourceHostEngines, parseAssetName, parseGithubCatalog, parseRepoList, type GithubSourceConfig } from "./github-source.js";

const signal = new AbortController().signal;
const sha = (n: number) => `sha256:${String(n).padStart(64, "0")}`;

describe("parseAssetName", () => {
  it("解析 <extensionId>-<version>.wxt", () => {
    expect(parseAssetName("demo-ext-1.2.3.wxt")).toEqual({ extensionId: "demo-ext", version: "1.2.3" });
    expect(parseAssetName("a-0.0.1.wxt")).toEqual({ extensionId: "a", version: "0.0.1" });
    expect(parseAssetName("multi-word-id-10.20.30.wxt")).toEqual({ extensionId: "multi-word-id", version: "10.20.30" });
  });

  it("非法文件名返回 null（跳过资产）", () => {
    expect(parseAssetName("demo-1.2.3.zip")).toBeNull();
    expect(parseAssetName("demo-v1.2.3.wxt")).toBeNull();
    expect(parseAssetName("demo-1.2.wxt")).toBeNull();
    expect(parseAssetName("1.2.3.wxt")).toBeNull();
    expect(parseAssetName("Demo-Ext-1.2.3.wxt")).toBeNull();
    expect(parseAssetName("demo-1.2.3.4.wxt")).toBeNull();
    expect(parseAssetName("-1.2.3.wxt")).toBeNull();
    // 预发布后缀与 extensionId 的连字符无法无歧义拆分：一律拒绝。
    expect(parseAssetName("demo-1.0.0-beta.1.wxt")).toBeNull();
    expect(parseAssetName("demo-1.0.0+build.2.wxt")).toBeNull();
  });
});

describe("parseRepoList", () => {
  it("逗号分隔 owner/repo，去重、去空白、过滤非法 slug", () => {
    expect(parseRepoList("a/b, c/d , a/b")).toEqual(["a/b", "c/d"]);
    expect(parseRepoList("org.team/my.repo.v2")).toEqual(["org.team/my.repo.v2"]);
    expect(parseRepoList("not-a-slug")).toEqual([]);
    expect(parseRepoList("")).toEqual([]);
    expect(parseRepoList(undefined)).toEqual([]);
    expect(parseRepoList(42)).toEqual([]);
  });
});

describe("parseGithubCatalog", () => {
  it("只收认识的字段；非法 id / 非对象条目忽略", () => {
    expect(
      parseGithubCatalog({
        extensions: {
          demo: { name: " Demo ", description: " 描述 ", icon: "media", hotReload: true },
          "Bad_Id": { name: "x" },
          broken: "nope",
          empty: {}
        }
      })
    ).toEqual({ demo: { name: "Demo", description: "描述", icon: "media", hotReload: true } });
  });

  it("不是目录形状时返回空表", () => {
    expect(parseGithubCatalog(null)).toEqual({});
    expect(parseGithubCatalog([])).toEqual({});
    expect(parseGithubCatalog({ extensions: [] })).toEqual({});
  });
});

type FetchLog = { url: string; init?: RequestInit }[];

function mockFetch(routes: Array<{ match: (url: string) => boolean; respond: (url: string) => { status: number; body?: unknown } | Response }>, log: FetchLog = []) {
  return {
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      log.push({ url, init });
      for (const route of routes) {
        if (!route.match(url)) continue;
        const result = route.respond(url);
        if (result instanceof Response) return result;
        return new Response(result.body === undefined ? "" : JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
      }
      return new Response("no route", { status: 500 });
    }) as typeof globalThis.fetch,
    log
  };
}

const config = (overrides: Partial<GithubSourceConfig> = {}): GithubSourceConfig => ({
  enabled: true,
  repos: ["acme/extensions"],
  apiBase: "https://api.github.com",
  token: "",
  ...overrides
});

const release = (tag: string, assets: Array<{ name: string; size?: number; digest?: string; url?: string; apiUrl?: string }>, publishedAt?: string) => ({
  tag_name: tag,
  name: `Release ${tag}`,
  ...(publishedAt ? { published_at: publishedAt } : {}),
  assets: assets.map((asset) => ({
    name: asset.name,
    size: asset.size ?? 100,
    digest: asset.digest,
    ...(asset.apiUrl ? { url: asset.apiUrl } : {}),
    browser_download_url: asset.url ?? `https://github.com/acme/extensions/releases/download/${tag}/${asset.name}`
  }))
});

describe("available", () => {
  it("enabled 且 repos 非空才可用；原因用中文给出", () => {
    const source = createGithubReleaseSource({ config: () => config() });
    expect(source.available()).toEqual({ ok: true });
    expect(createGithubReleaseSource({ config: () => config({ enabled: false }) }).available()).toEqual({ ok: false, reason: expect.stringContaining("未启用") });
    expect(createGithubReleaseSource({ config: () => config({ repos: [] }) }).available()).toEqual({ ok: false, reason: expect.stringContaining("未配置 GitHub 仓库列表") });
  });
});

describe("search", () => {
  it("把 .wxt 资产映射为 listing：label=仓库@tag，description=release 名，latest 取最高 semver", async () => {
    const { fetchImpl } = mockFetch([
      { match: (url) => url.includes("/repos/acme/extensions/releases"), respond: () => ({ status: 200, body: [release("v1.0.0", [{ name: "demo-1.0.0.wxt", digest: sha(1) }]), release("v1.1.0", [{ name: "demo-1.1.0.wxt", digest: sha(2) }, { name: "other-0.0.1.wxt", digest: sha(3) }])] }) }
    ]);
    const source = createGithubReleaseSource({ config: () => config(), fetchImpl });
    const page: MarketplaceSearchPage = await source.search({}, signal);
    expect(page.items).toEqual([
      { extensionId: "demo", label: "acme/extensions@v1.0.0", description: "Release v1.0.0", latest: "1.1.0", size: 100 },
      { extensionId: "other", label: "acme/extensions@v1.1.0", description: "Release v1.1.0", latest: "0.0.1", size: 100 }
    ]);
  });

  it("分页：满页继续翻，直到取空（per_page=30）", async () => {
    const full = Array.from({ length: 30 }, (_, index) => release(`v0.0.${index + 1}`, [{ name: `demo-0.0.${index + 1}.wxt`, digest: sha(index + 1) }]));
    const half = [release("v1.0.0", [{ name: "demo-1.0.0.wxt", digest: sha(99) }])];
    const pages = new Map([[1, full], [2, half]]);
    const { fetchImpl, log } = mockFetch([
      { match: (url) => url.includes("/repos/acme/extensions/releases"), respond: (url) => ({ status: 200, body: pages.get(Number(new URL(url).searchParams.get("page"))) ?? [] }) }
    ]);
    const source = createGithubReleaseSource({ config: () => config(), fetchImpl });
    const page = await source.search({}, signal);
    expect(page.items[0]!.latest).toBe("1.0.0");
    const releasePages = log.filter((entry) => entry.url.includes("/releases")).map((entry) => new URL(entry.url).searchParams.get("page"));
    expect(releasePages).toEqual(["1", "2"]);
  });

  it("搜索词按 extensionId 子串过滤（大小写不敏感）", async () => {
    const { fetchImpl } = mockFetch([
      { match: (url) => url.includes("/releases"), respond: () => ({ status: 200, body: [release("v1", [{ name: "image-tools-1.0.0.wxt", digest: sha(1) }, { name: "other-1.0.0.wxt", digest: sha(2) }])] }) }
    ]);
    const source = createGithubReleaseSource({ config: () => config(), fetchImpl });
    const page = await source.search({ text: "Image" }, signal);
    expect(page.items.map((item) => item.extensionId)).toEqual(["image-tools"]);
  });

  it("catalog.json 补充名称 / 描述 / 图标 / 生效方式；大小与时间取最新 Release", async () => {
    const { fetchImpl } = mockFetch([
      {
        match: (url) => url.includes("/contents/catalog.json"),
        respond: () => ({
          status: 200,
          body: { extensions: { demo: { name: "Demo 扩展", description: "目录里的描述", icon: "media", hotReload: true } } }
        })
      },
      {
        match: (url) => url.includes("/releases"),
        respond: () => ({
          status: 200,
          body: [
            release("v1.0.0", [{ name: "demo-1.0.0.wxt", size: 111, digest: sha(1) }], "2026-10-01T00:00:00Z"),
            release("v1.1.0", [{ name: "demo-1.1.0.wxt", size: 222, digest: sha(2) }], "2026-10-20T00:00:00Z")
          ]
        })
      }
    ]);
    const source = createGithubReleaseSource({ config: () => config(), fetchImpl });
    const page = await source.search({}, signal);
    expect(page.items).toEqual([
      {
        extensionId: "demo",
        label: "Demo 扩展",
        latest: "1.1.0",
        description: "目录里的描述",
        icon: "media",
        hotReload: true,
        size: 222,
        publishedAt: "2026-10-20T00:00:00Z"
      }
    ]);
    const info = await source.getExtension("demo", signal);
    expect(info?.label).toBe("Demo 扩展");
    expect(info?.versions.find((entry) => entry.version === "1.1.0")?.publishedAt).toBe("2026-10-20T00:00:00Z");
  });

  it("目录缺失或无权限时退回 Release 自身的展示字段", async () => {
    const { fetchImpl } = mockFetch([
      { match: (url) => url.includes("/contents/catalog.json"), respond: () => ({ status: 404, body: { message: "Not Found" } }) },
      { match: (url) => url.includes("/releases"), respond: () => ({ status: 200, body: [release("v1", [{ name: "demo-1.0.0.wxt", digest: sha(1) }])] }) }
    ]);
    const source = createGithubReleaseSource({ config: () => config(), fetchImpl });
    const page = await source.search({}, signal);
    expect(page.items[0]).toMatchObject({ label: "acme/extensions@v1", description: "Release v1", latest: "1.0.0" });
    expect(page.items[0]?.icon).toBeUndefined();
    expect(page.items[0]?.hotReload).toBeUndefined();
  });

  it("解析失败的资产直接跳过，不影响其余资产", async () => {
    const { fetchImpl } = mockFetch([
      { match: (url) => url.includes("/releases"), respond: () => ({ status: 200, body: [release("v1", [{ name: "README.md" }, { name: "weird name.wxt" }, { name: "good-1.0.0.wxt", digest: sha(1) }])] }) }
    ]);
    const source = createGithubReleaseSource({ config: () => config(), fetchImpl });
    const page = await source.search({}, signal);
    expect(page.items.map((item) => item.extensionId)).toEqual(["good"]);
  });
});

describe("resolve", () => {
  it("按 semver range 选最高满足版本；engines 填宿主宽松声明", async () => {
    const { fetchImpl } = mockFetch([
      { match: (url) => url.includes("/releases"), respond: () => ({ status: 200, body: [release("v1", [{ name: "demo-1.0.0.wxt", digest: sha(1) }]), release("v2", [{ name: "demo-1.2.0.wxt", digest: sha(2) }]), release("v3", [{ name: "demo-1.9.0.wxt", digest: sha(3) }]), release("v4", [{ name: "demo-2.0.0.wxt", digest: sha(4) }])] }) }
    ]);
    const source = createGithubReleaseSource({ config: () => config(), fetchImpl });
    const ref = await source.resolve("demo", "^1.0.0", signal);
    expect(ref).toEqual({
      sourceId: GITHUB_RELEASE_SOURCE_ID,
      extensionId: "demo",
      version: "1.9.0",
      engines: githubSourceHostEngines(),
      packageDigest: sha(3),
      size: 100
    });
  });

  it("资产缺 digest（API 未返回）时 resolve 返回 null——宁可失败不可瞎装", async () => {
    const { fetchImpl } = mockFetch([
      { match: (url) => url.includes("/releases"), respond: () => ({ status: 200, body: [release("v1", [{ name: "demo-1.0.0.wxt" }])] }) }
    ]);
    const source = createGithubReleaseSource({ config: () => config(), fetchImpl });
    expect(await source.resolve("demo", "*", signal)).toBeNull();
  });

  it("digest 格式非法（非 sha256:<64hex>）同样拒绝", async () => {
    const { fetchImpl } = mockFetch([
      { match: (url) => url.includes("/releases"), respond: () => ({ status: 200, body: [release("v1", [{ name: "demo-1.0.0.wxt", digest: "md5:abc" }])] }) }
    ]);
    const source = createGithubReleaseSource({ config: () => config(), fetchImpl });
    expect(await source.resolve("demo", "*", signal)).toBeNull();
  });

  it("多个仓库都有匹配时取版本最高的那个", async () => {
    const { fetchImpl, log } = mockFetch([
      { match: (url) => url.includes("/repos/acme/extensions/releases"), respond: () => ({ status: 200, body: [release("v1", [{ name: "demo-1.5.0.wxt", digest: sha(1) }])] }) },
      { match: (url) => url.includes("/repos/acme/legacy/releases"), respond: () => ({ status: 200, body: [release("v1", [{ name: "demo-1.2.0.wxt", digest: sha(2) }])] }) }
    ]);
    const source = createGithubReleaseSource({ config: () => config({ repos: ["acme/extensions", "acme/legacy"] }), fetchImpl });
    const ref = await source.resolve("demo", "*", signal);
    expect(ref?.version).toBe("1.5.0");
    expect(ref?.packageDigest).toBe(sha(1));
    expect(log.map((entry) => entry.url.split("/releases")[0].split("/repos/")[1])).toEqual(["acme/extensions", "acme/legacy"]);
  });

  it("没有满足 range 的版本返回 null", async () => {
    const { fetchImpl } = mockFetch([
      { match: (url) => url.includes("/releases"), respond: () => ({ status: 200, body: [release("v1", [{ name: "demo-1.0.0.wxt", digest: sha(1) }])] }) }
    ]);
    const source = createGithubReleaseSource({ config: () => config(), fetchImpl });
    expect(await source.resolve("demo", "^2.0.0", signal)).toBeNull();
  });
});

describe("getExtension（版本详情）", () => {
  it("列出全部版本（含缺 digest 的，标记不可安装原因）", async () => {
    const { fetchImpl } = mockFetch([
      { match: (url) => url.includes("/releases"), respond: () => ({ status: 200, body: [release("v1", [{ name: "demo-1.0.0.wxt", digest: sha(1) }, { name: "demo-1.1.0.wxt" }])] }) }
    ]);
    const source = createGithubReleaseSource({ config: () => config(), fetchImpl });
    const info = await source.getExtension("demo", signal);
    expect(info?.extensionId).toBe("demo");
    expect(info?.versions.map((entry) => entry.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(info?.versions[1]?.packageDigest).toBe(sha(1));
    expect(info?.versions[0]).toMatchObject({ state: "yanked", yankReason: expect.stringContaining("摘要") });
  });

  it("扩展不存在返回 null", async () => {
    const { fetchImpl } = mockFetch([
      { match: (url) => url.includes("/releases"), respond: () => ({ status: 200, body: [release("v1", [{ name: "demo-1.0.0.wxt", digest: sha(1) }])] }) }
    ]);
    const source = createGithubReleaseSource({ config: () => config(), fetchImpl });
    expect(await source.getExtension("missing", signal)).toBeNull();
  });
});

describe("download", () => {
  const ref = {
    sourceId: GITHUB_RELEASE_SOURCE_ID,
    extensionId: "demo",
    version: "1.0.0",
    engines: githubSourceHostEngines(),
    packageDigest: sha(7),
    size: 11
  };

  it("按约定文件名定位资产，流式返回 browser_download_url 的字节；size 以资产声明为准", async () => {
    const bytes = new TextEncoder().encode("hello wxt!!");
    const assetSize = 12345;
    const { fetchImpl, log } = mockFetch([
      { match: (url) => url.includes("/repos/acme/extensions/releases"), respond: () => ({ status: 200, body: [release("v1", [{ name: "demo-1.0.0.wxt", size: assetSize, digest: sha(7), url: "https://github.com/acme/extensions/releases/download/v1/demo-1.0.0.wxt" }])] }) },
      { match: (url) => url.startsWith("https://github.com/acme/extensions/releases/download/"), respond: () => new Response(bytes, { status: 200 }) }
    ]);
    const source = createGithubReleaseSource({ config: () => config(), fetchImpl });
    const download = await source.download(ref, signal);
    expect(download.size).toBe(assetSize);
    const chunks: Uint8Array[] = [];
    const reader = download.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const received = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      received.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(received).toEqual(bytes);
    // 未配置令牌：下载请求没有 Authorization 头。
    expect((log.at(-1)!.init!.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("配置 token 时 API 与下载请求都带 Authorization", async () => {
    const { fetchImpl, log } = mockFetch([
      { match: (url) => url.includes("/repos/acme/extensions/releases"), respond: () => ({ status: 200, body: [release("v1", [{ name: "demo-1.0.0.wxt", digest: sha(7), url: "https://github.com/acme/extensions/releases/download/v1/demo-1.0.0.wxt" }])] }) },
      { match: (url) => url.startsWith("https://github.com/acme/extensions/releases/download/"), respond: () => new Response("x", { status: 200 }) }
    ]);
    const source = createGithubReleaseSource({ config: () => config({ token: "ghp_test" }), fetchImpl });
    await source.download(ref, signal);
    expect((log[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer ghp_test");
    expect((log[1]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer ghp_test");
  });

  it("配置 token 且资产带 API 地址时走资产 API（私有仓库），并声明 octet-stream", async () => {
    const apiUrl = "https://api.github.com/repos/acme/extensions/releases/assets/42";
    const bytes = new TextEncoder().encode("private bytes");
    const { fetchImpl, log } = mockFetch([
      // 资产 API 路径也包含 /releases，所以精确匹配必须排在列表路由之前。
      { match: (url) => url === apiUrl, respond: () => new Response(bytes, { status: 200 }) },
      { match: (url) => url.includes("/repos/acme/extensions/releases"), respond: () => ({ status: 200, body: [release("v1", [{ name: "demo-1.0.0.wxt", digest: sha(7), apiUrl }])] }) }
    ]);
    const source = createGithubReleaseSource({ config: () => config({ token: "github_pat_test" }), fetchImpl });
    const download = await source.download(ref, signal);
    const chunks: Uint8Array[] = [];
    const reader = download.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(new Uint8Array(chunks[0]!)).toEqual(bytes);
    // 网页直链对私有仓库带 Bearer 只会 404，所以必须落到资产 API 上。
    expect(log.at(-1)!.url).toBe(apiUrl);
    const headers = log.at(-1)!.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer github_pat_test");
    expect(headers.Accept).toBe("application/octet-stream");
  });

  it("配置 token 但资产没有 API 地址时退回网页直链（不额外带 Accept）", async () => {
    const { fetchImpl, log } = mockFetch([
      { match: (url) => url.includes("/repos/acme/extensions/releases"), respond: () => ({ status: 200, body: [release("v1", [{ name: "demo-1.0.0.wxt", digest: sha(7) }])] }) },
      { match: (url) => url.startsWith("https://github.com/acme/extensions/releases/download/"), respond: () => new Response("x", { status: 200 }) }
    ]);
    const source = createGithubReleaseSource({ config: () => config({ token: "ghp_test" }), fetchImpl });
    await source.download(ref, signal);
    expect(log.at(-1)!.url).toContain("/releases/download/");
    expect((log.at(-1)!.init!.headers as Record<string, string>).Accept).toBeUndefined();
  });

  it("资产已删除 / 摘要不符 → MARKETPLACE_SOURCE_NOT_FOUND", async () => {
    const { fetchImpl } = mockFetch([
      { match: (url) => url.includes("/releases"), respond: () => ({ status: 200, body: [release("v1", [{ name: "demo-1.0.0.wxt", digest: sha(99) }])] }) }
    ]);
    const source = createGithubReleaseSource({ config: () => config(), fetchImpl });
    await expect(source.download(ref, signal)).rejects.toMatchObject({ code: "MARKETPLACE_SOURCE_NOT_FOUND" });
  });

  it("下载 HTTP 失败 → MARKETPLACE_DOWNLOAD_FAILED", async () => {
    const { fetchImpl } = mockFetch([
      { match: (url) => url.includes("api.github.com/repos"), respond: () => ({ status: 200, body: [release("v1", [{ name: "demo-1.0.0.wxt", digest: sha(7) }])] }) },
      { match: (url) => url.startsWith("https://github.com/"), respond: () => new Response("gone", { status: 404 }) }
    ]);
    const source = createGithubReleaseSource({ config: () => config(), fetchImpl });
    await expect(source.download(ref, signal)).rejects.toMatchObject({ code: "MARKETPLACE_DOWNLOAD_FAILED" });
  });
});

describe("网络失败与限流", () => {
  it("仓库 404 → 稳定中文原因", async () => {
    const { fetchImpl } = mockFetch([
      { match: (url) => url.includes("/releases"), respond: () => ({ status: 404, body: { message: "Not Found" } }) }
    ]);
    const source = createGithubReleaseSource({ config: () => config(), fetchImpl });
    await expect(source.search({}, signal)).rejects.toMatchObject({ code: "MARKETPLACE_SOURCE_UNAVAILABLE", message: expect.stringContaining("仓库不存在") });
  });

  it("401/403（含限流）→ 提示可配置令牌", async () => {
    const { fetchImpl } = mockFetch([
      { match: (url) => url.includes("/releases"), respond: () => ({ status: 403, body: { message: "rate limited" } }) }
    ]);
    const source = createGithubReleaseSource({ config: () => config(), fetchImpl });
    await expect(source.search({}, signal)).rejects.toMatchObject({ message: expect.stringContaining("令牌无效或已达限流") });
  });

  it("网络不可达 → MARKETPLACE_SOURCE_UNAVAILABLE", async () => {
    const source = createGithubReleaseSource({
      config: () => config(),
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof globalThis.fetch
    });
    await expect(source.search({}, signal)).rejects.toMatchObject({ code: "MARKETPLACE_SOURCE_UNAVAILABLE" });
  });

  it("配置了 githubApiBase 时走自定义基址（GitHub Enterprise Server）", async () => {
    const { fetchImpl, log } = mockFetch([
      { match: (url) => url.includes("/repos/acme/extensions/releases"), respond: () => ({ status: 200, body: [] }) }
    ]);
    const source = createGithubReleaseSource({ config: () => config({ apiBase: "https://github.example.com/api/v3" }), fetchImpl });
    await source.search({}, signal);
    expect(log[0]!.url.startsWith("https://github.example.com/api/v3/repos/acme/extensions/releases")).toBe(true);
  });
});
