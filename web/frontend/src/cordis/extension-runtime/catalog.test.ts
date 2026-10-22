/**
 * Extension release catalog loader 测试
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 4.1/4.7 / design D6）。
 *
 * 验证只从同源发布 HTML link 读取目录、严格解码/前缀校验、失败不缓存（可重试同一 pinned URL）、
 * 无 link 时降级为 null（无扩展能力）、dispose 重置。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { EXTENSION_SDK_ABI_VERSION } from "@woohaa3/contracts";
import { createExtensionReleaseCatalogLoader, readExtensionReleaseHref } from "./catalog.js";
import { setAppBasePathForTesting } from "../services/app-base-path.js";

const RELEASE_ID = "f".repeat(64);

function catalogBody(): unknown {
  return {
    schemaVersion: 1,
    releaseId: RELEASE_ID,
    hostSdkAbi: EXTENSION_SDK_ABI_VERSION,
    entries: [
      {
        metadata: {
          extensionId: "demo",
          version: "0.1.0",
          label: "Demo",
          description: "demo",
          activation: "browser-local",
          configScope: "browser-local",
          required: false,
          sdkAbi: EXTENSION_SDK_ABI_VERSION
        },
        artifactId: "a".repeat(64),
        entryURL: `/extensions/demo/${"a".repeat(64)}/entry-abc.js`,
        styleURLs: [],
        protocolVersion: 1,
        sdkAbi: EXTENSION_SDK_ABI_VERSION,
        reactMajor: 18,
        requiredSdkGroups: [],
        requiredSdkExports: []
      }
    ]
  };
}

/** 最小 document 替身，只实现 querySelector。 */
function fakeDocument(href: string | null): Document {
  return {
    querySelector(selector: string) {
      if (selector.includes("woohaa-extension-release")) {
        return href === null ? null : { getAttribute: () => href };
      }
      return null;
    }
  } as unknown as Document;
}

describe("readExtensionReleaseHref", () => {
  it("读取合法同源发布前缀 link", () => {
    expect(readExtensionReleaseHref(fakeDocument(`/extension-releases/${RELEASE_ID}.json`))).toBe(
      `/extension-releases/${RELEASE_ID}.json`
    );
  });

  it("缺失 / 非法 / 非发布前缀一律返回 null", () => {
    expect(readExtensionReleaseHref(fakeDocument(null))).toBeNull();
    expect(readExtensionReleaseHref(fakeDocument("https://evil.example/x.json"))).toBeNull();
    expect(readExtensionReleaseHref(fakeDocument("/other/place.json"))).toBeNull();
    expect(readExtensionReleaseHref(fakeDocument("/extension-releases/../secret.json"))).toBeNull();
  });

  it("挂载前缀写在 link 上时归一为逻辑发布地址（change: 2026-10-15-support-configurable-app-base-path）", () => {
    setAppBasePathForTesting("/dev/a627a79d40e4413372cb/");
    try {
      expect(
        readExtensionReleaseHref(fakeDocument(`/dev/a627a79d40e4413372cb/extension-releases/${RELEASE_ID}.json`))
      ).toBe(`/extension-releases/${RELEASE_ID}.json`);
      // 与本页挂载前缀无关的地址仍然拒绝（不放行越界路径）。
      expect(
        readExtensionReleaseHref(fakeDocument(`/dev/otherhash/extension-releases/${RELEASE_ID}.json`))
      ).toBeNull();
    } finally {
      setAppBasePathForTesting("/");
    }
  });
});

describe("createExtensionReleaseCatalogLoader", () => {
  it("无 link 时返回 null 并记录无目录（不抛错）", async () => {
    const loader = createExtensionReleaseCatalogLoader({ document: fakeDocument(null) });
    await expect(loader.load()).resolves.toBeNull();
    expect(loader.currentReleaseId()).toBeNull();
  });

  it("加载成功固定 release，后续调用复用同一 Promise（不重复 fetch）", async () => {
    let fetches = 0;
    const loader = createExtensionReleaseCatalogLoader({
      document: fakeDocument(`/extension-releases/${RELEASE_ID}.json`),
      fetch: (async () => {
        fetches += 1;
        return new Response(JSON.stringify(catalogBody()), { status: 200 });
      }) as typeof fetch
    });
    const first = await loader.load();
    const second = await loader.load();
    expect(first).toBe(second);
    expect(fetches).toBe(1);
    expect(loader.currentReleaseId()).toBe(RELEASE_ID);
  });

  it("link 已带挂载前缀时按原公开地址请求一次（不双前缀）", async () => {
    setAppBasePathForTesting("/dev/a627a79d40e4413372cb/");
    const urls: string[] = [];
    try {
      const loader = createExtensionReleaseCatalogLoader({
        document: fakeDocument(`/dev/a627a79d40e4413372cb/extension-releases/${RELEASE_ID}.json`),
        fetch: (async (url: string) => {
          urls.push(url);
          return new Response(JSON.stringify(catalogBody()), { status: 200 });
        }) as unknown as typeof fetch
      });
      const catalog = await loader.load();
      expect(catalog?.releaseId).toBe(RELEASE_ID);
      expect(urls).toEqual([`/dev/a627a79d40e4413372cb/extension-releases/${RELEASE_ID}.json`]);
    } finally {
      setAppBasePathForTesting("/");
    }
  });

  it("网络失败分类为可重试 network，且不缓存失败（重试重新请求同一 pinned URL）", async () => {
    const urls: string[] = [];
    let attempt = 0;
    const loader = createExtensionReleaseCatalogLoader({
      document: fakeDocument(`/extension-releases/${RELEASE_ID}.json`),
      fetch: (async (url: string) => {
        urls.push(url);
        attempt += 1;
        if (attempt === 1) throw new Error("offline");
        return new Response(JSON.stringify(catalogBody()), { status: 200 });
      }) as unknown as typeof fetch
    });
    await expect(loader.load()).rejects.toMatchObject({ code: "network", retryable: true });
    await expect(loader.load()).resolves.not.toBeNull();
    expect(urls).toEqual([
      `/extension-releases/${RELEASE_ID}.json`,
      `/extension-releases/${RELEASE_ID}.json`
    ]);
  });

  it("非法 JSON 归类为不可重试 invalid-catalog", async () => {
    const loader = createExtensionReleaseCatalogLoader({
      document: fakeDocument(`/extension-releases/${RELEASE_ID}.json`),
      fetch: (async () => new Response("{ not json", { status: 200 })) as unknown as typeof fetch
    });
    await expect(loader.load()).rejects.toMatchObject({ code: "invalid-catalog", retryable: false });
  });

  it("artifact 前缀越界拒绝", async () => {
    const body = catalogBody() as { entries: Array<{ entryURL: string }> };
    body.entries[0]!.entryURL = "/etc/passwd";
    const loader = createExtensionReleaseCatalogLoader({
      document: fakeDocument(`/extension-releases/${RELEASE_ID}.json`),
      fetch: (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
    });
    await expect(loader.load()).rejects.toMatchObject({ code: "invalid-catalog" });
  });

  it("dispose 清空固定 release", async () => {
    const loader = createExtensionReleaseCatalogLoader({
      document: fakeDocument(`/extension-releases/${RELEASE_ID}.json`),
      fetch: (async () => new Response(JSON.stringify(catalogBody()), { status: 200 })) as unknown as typeof fetch
    });
    await loader.load();
    loader.dispose();
    expect(loader.currentReleaseId()).toBeNull();
    // dispose 后可重新加载。
    await expect(loader.load()).resolves.not.toBeNull();
  });
});
