/**
 * Extension artifact loader 行为测试
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 4.7 / design D7）。
 *
 * 用可注入 importer/style-loader/clock 验证：兼容性先检查、并发去重、失败不缓存用户态、
 * CSS 时序、ABI 拒绝、descriptor identity、timeout 不安装迟到结果。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import {
  EXTENSION_SDK_ABI_VERSION,
  HOST_REACT_MAJOR,
  type ExtensionBrowserReleaseEntry,
  type ExtensionSdkGroup
} from "@woohaa3/contracts";
import {
  createExtensionArtifactLoader,
  DEFAULT_EXTENSION_LOAD_TIMEOUT_MS,
  ExtensionLoadError
} from "./loader.js";
import {
  createExtensionRuntimeProvider,
  type ExtensionRuntimeProvider
} from "./runtime-provider.js";
import type { ExtensionSdkGroupModule } from "./sdk-groups.js";

function makeEntry(overrides: Partial<ExtensionBrowserReleaseEntry> = {}): ExtensionBrowserReleaseEntry {
  return {
    metadata: {
      extensionId: "demo",
      version: "0.1.0",
      label: "Demo",
      description: "demo extension",
      activation: "browser-local",
      configScope: "browser-local",
      required: false,
      sdkAbi: EXTENSION_SDK_ABI_VERSION
    },
    artifactId: "a".repeat(64),
    entryURL: "/extensions/demo/aaaaaaaa/entry.js",
    styleURLs: ["/extensions/demo/aaaaaaaa/entry.css"],
    protocolVersion: 1,
    sdkAbi: EXTENSION_SDK_ABI_VERSION,
    reactMajor: HOST_REACT_MAJOR,
    requiredSdkGroups: ["core"],
    requiredSdkExports: ["defineExtensionPlugin"],
    ...overrides
  };
}

/** 只含一个具名导出的最小 provider（不触达宿主真实 adapter）。 */
function makeProvider(): ExtensionRuntimeProvider {
  const core: ExtensionSdkGroupModule = { group: "core", namedExports: { defineExtensionPlugin: () => undefined } };
  return createExtensionRuntimeProvider({
    groupLoaders: {
      core: async () => core,
      ui: async () => ({ group: "ui" as ExtensionSdkGroup, namedExports: {} }),
      model: async () => ({ group: "model" as ExtensionSdkGroup, namedExports: {} }),
      authoring: async () => ({ group: "authoring" as ExtensionSdkGroup, namedExports: {} })
    }
  });
}

function thinModule(extensionId: string): unknown {
  return {
    loadExtension: async () => ({
      descriptor: {
        extensionId,
        configScope: "browser-local" as const,
        activation: "browser-local" as const,
        plugin: () => () => undefined
      }
    })
  };
}

describe("Extension artifact loader", () => {
  it("兼容性检查在请求之前拒绝（ABI / protocol / React major）", async () => {
    let imported = 0;
    const loader = createExtensionArtifactLoader({
      runtimeProvider: makeProvider(),
      importer: async () => {
        imported += 1;
        return thinModule("demo");
      },
      prepareStyles: async () => undefined
    });
    await expect(loader.load(makeEntry({ protocolVersion: 2 as never }))).rejects.toMatchObject({ code: "abi" });
    await expect(loader.load(makeEntry({ sdkAbi: 99 }))).rejects.toMatchObject({ code: "abi" });
    await expect(loader.load(makeEntry({ reactMajor: 17 }))).rejects.toMatchObject({ code: "abi" });
    expect(imported).toBe(0);
  });

  it("成功加载返回无副作用 descriptor 工厂并缓存 module", async () => {
    let imported = 0;
    const loader = createExtensionArtifactLoader({
      runtimeProvider: makeProvider(),
      importer: async () => {
        imported += 1;
        return thinModule("demo");
      },
      prepareStyles: async () => undefined
    });
    const first = await loader.load(makeEntry());
    expect(first.createDescriptor().extensionId).toBe("demo");
    expect(loader.cachedEntryURLs()).toContain("/extensions/demo/aaaaaaaa/entry.js");
    // 第二次复用缓存，不再 import。
    await loader.load(makeEntry());
    expect(imported).toBe(1);
  });

  it("descriptor identity / configScope / activation 不符时拒绝", async () => {
    const loader = createExtensionArtifactLoader({
      runtimeProvider: makeProvider(),
      importer: async () => ({
        loadExtension: async () => ({
          descriptor: { extensionId: "other", plugin: () => () => undefined }
        })
      }),
      prepareStyles: async () => undefined
    });
    await expect(loader.load(makeEntry())).rejects.toMatchObject({ code: "descriptor" });

    const scopeMismatch = createExtensionArtifactLoader({
      runtimeProvider: makeProvider(),
      importer: async () => ({
        loadExtension: async () => ({
          descriptor: {
            extensionId: "demo",
            configScope: "site" as const,
            plugin: () => () => undefined
          }
        })
      }),
      prepareStyles: async () => undefined
    });
    await expect(scopeMismatch.load(makeEntry())).rejects.toMatchObject({ code: "descriptor" });
  });

  it("薄入口缺少 loadExtension 时归类为 evaluation", async () => {
    const loader = createExtensionArtifactLoader({
      runtimeProvider: makeProvider(),
      importer: async () => ({ default: {} }),
      prepareStyles: async () => undefined
    });
    await expect(loader.load(makeEntry())).rejects.toMatchObject({ code: "evaluation" });
  });

  it("求值失败移除缓存以便显式重试", async () => {
    let attempt = 0;
    const loader = createExtensionArtifactLoader({
      runtimeProvider: makeProvider(),
      importer: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("boom");
        return thinModule("demo");
      },
      prepareStyles: async () => undefined
    });
    await expect(loader.load(makeEntry())).rejects.toBeInstanceOf(ExtensionLoadError);
    expect(loader.cachedEntryURLs()).toEqual([]);
    const recovered = await loader.load(makeEntry());
    expect(recovered.extensionId).toBe("demo");
    expect(attempt).toBe(2);
  });

  /**
   * 浏览器会把失败的 module fetch 按 URL 缓存在本 document 的 module map 里（Chromium 实测：
   * 同一 URL 再 import 不再发请求）。宿主的资源处理器按 pathname 取 artifact，因此重试必须换
   * URL 变体——否则「显式重试」在宿主短暂 5xx 之后永远恢复不了，只能刷新页面。
   */
  it("重试用 URL 变体真正重新请求（浏览器缓存失败导入）", async () => {
    const urls: string[] = [];
    const loader = createExtensionArtifactLoader({
      runtimeProvider: makeProvider(),
      importer: async (url: string) => {
        urls.push(url);
        if (urls.length === 1) throw new TypeError("Failed to fetch dynamically imported module");
        return thinModule("demo");
      },
      prepareStyles: async () => undefined
    });
    await expect(loader.load(makeEntry())).rejects.toBeInstanceOf(ExtensionLoadError);
    await expect(loader.load(makeEntry())).resolves.toMatchObject({ extensionId: "demo" });
    expect(urls).toEqual([
      "/extensions/demo/aaaaaaaa/entry.js",
      "/extensions/demo/aaaaaaaa/entry.js?woohaa-retry=1"
    ]);
    // 缓存键仍是 canonical entry URL（成功之后复用，不再请求）。
    expect(loader.cachedEntryURLs()).toEqual(["/extensions/demo/aaaaaaaa/entry.js"]);
    await expect(loader.load(makeEntry())).resolves.toMatchObject({ extensionId: "demo" });
    expect(urls).toHaveLength(2);
  });

  it("CSS 失败归类为可重试 css 错误并移除缓存", async () => {
    let styles = 0;
    const loader = createExtensionArtifactLoader({
      runtimeProvider: makeProvider(),
      importer: async () => thinModule("demo"),
      prepareStyles: async () => {
        styles += 1;
        if (styles === 1) throw new Error("css down");
      }
    });
    const error = await loader.load(makeEntry()).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ExtensionLoadError);
    expect((error as ExtensionLoadError).code).toBe("css");
    expect((error as ExtensionLoadError).retryable).toBe(true);
    // 重试成功。
    await expect(loader.load(makeEntry())).resolves.toMatchObject({ extensionId: "demo" });
  });

  it("required export 缺失在实现求值前拒绝", async () => {
    const loader = createExtensionArtifactLoader({
      runtimeProvider: makeProvider(),
      importer: async () => thinModule("demo"),
      prepareStyles: async () => undefined
    });
    await expect(
      loader.load(makeEntry({ requiredSdkExports: ["NotARealExport"] }))
    ).rejects.toMatchObject({ code: "abi" });
  });

  it("timeout 使本次任务失效（迟到 module 不进入返回）", async () => {
    const pending: Array<(value: unknown) => void> = [];
    const loader = createExtensionArtifactLoader({
      runtimeProvider: makeProvider(),
      timeoutMs: 5,
      importer: () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
      prepareStyles: async () => undefined
    });
    const outcome = await loader.load(makeEntry()).catch((value: unknown) => value);
    expect((outcome as ExtensionLoadError).code).toBe("timeout");
    // 迟到 resolve 不改变已失败的结论；也不应抛未处理拒绝。
    pending[0]?.(thinModule("demo"));
  });

  it("缺省超时与契约一致（15s）", () => {
    expect(DEFAULT_EXTENSION_LOAD_TIMEOUT_MS).toBe(15_000);
  });
});
