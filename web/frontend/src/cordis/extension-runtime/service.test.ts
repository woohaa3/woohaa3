/**
 * Extension App 级运行时服务测试
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 4.7/5.7 / design D6/D7）。
 *
 * 用注入 catalog/artifact loader 验证：目录缺失降级为“无扩展能力”、同一 release 固定、
 * 加载诊断（loading→registered / load-failed）、显式重试、以及 dispose 后拒绝。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { EXTENSION_SDK_ABI_VERSION, HOST_REACT_MAJOR, type ExtensionBrowserReleaseEntry } from "@woohaa3/contracts";
import { createExtensionRuntimeService } from "./service.js";
import { ExtensionLoadError, type ExtensionArtifactLoader } from "./loader.js";
import type { ExtensionReleaseCatalog } from "@woohaa3/contracts";

const RELEASE_ID = "e".repeat(64);

function releaseEntry(extensionId: string): ExtensionBrowserReleaseEntry {
  return {
    metadata: {
      extensionId,
      version: "0.1.0",
      label: extensionId,
      description: extensionId,
      activation: "browser-local",
      configScope: "browser-local",
      required: false,
      sdkAbi: EXTENSION_SDK_ABI_VERSION
    },
    artifactId: "b".repeat(64),
    entryURL: `/extensions/${extensionId}/${"b".repeat(64)}/entry.js`,
    styleURLs: [],
    protocolVersion: 1,
    sdkAbi: EXTENSION_SDK_ABI_VERSION,
    reactMajor: HOST_REACT_MAJOR,
    requiredSdkGroups: [],
    requiredSdkExports: []
  };
}

function catalog(): ExtensionReleaseCatalog {
  return {
    schemaVersion: 1,
    releaseId: RELEASE_ID,
    hostSdkAbi: EXTENSION_SDK_ABI_VERSION,
    entries: [releaseEntry("demo")]
  };
}

/** 可编程 artifact loader 替身。 */
function artifactLoader(behavior: (extensionId: string) => "ok" | "fail"): ExtensionArtifactLoader {
  return {
    async load(entry) {
      if (behavior(entry.metadata.extensionId) === "fail") {
        throw new ExtensionLoadError("network", "资源请求失败", true);
      }
      return {
        extensionId: entry.metadata.extensionId,
        artifactId: entry.artifactId,
        createDescriptor: () => ({
          extensionId: entry.metadata.extensionId,
          configScope: entry.metadata.configScope,
          activation: entry.metadata.activation,
          plugin: () => () => undefined
        }),
        createSettingsPlugin: () => undefined
      };
    },
    cachedEntryURLs: () => [],
    dispose() {
      /* noop */
    }
  };
}

describe("createExtensionRuntimeService", () => {
  it("目录缺失时返回 null（无扩展能力）且 metadata 为空", async () => {
    const service = createExtensionRuntimeService({
      catalogLoader: { load: async () => null, currentReleaseId: () => null, dispose() {} } as never
    });
    await expect(service.ensureCatalog()).resolves.toBeNull();
    expect(service.metadata()).toEqual([]);
    expect(service.current()).toBeNull();
  });

  it("固定同一 release，加载成功记录 registered 诊断", async () => {
    const service = createExtensionRuntimeService({
      catalogLoader: { load: async () => catalog(), currentReleaseId: () => RELEASE_ID, dispose() {} } as never,
      artifactLoader: artifactLoader(() => "ok")
    });
    const runtime = await service.ensureCatalog();
    expect(runtime?.releaseId).toBe(RELEASE_ID);
    expect(service.metadata().map((entry) => entry.extensionId)).toEqual(["demo"]);
    const descriptor = await service.loadDescriptor("demo");
    expect(descriptor.extensionId).toBe("demo");
    const diagnostic = service.diagnostics().find((row) => row.extensionId === "demo");
    expect(diagnostic?.status).toBe("registered");
    expect(diagnostic?.releaseId).toBe(RELEASE_ID);
  });

  it("加载失败记录 load-failed，retry 清除后再次加载成功", async () => {
    let mode: "ok" | "fail" = "fail";
    const service = createExtensionRuntimeService({
      catalogLoader: { load: async () => catalog(), currentReleaseId: () => RELEASE_ID, dispose() {} } as never,
      artifactLoader: artifactLoader(() => mode)
    });
    await service.ensureCatalog();
    await expect(service.loadDescriptor("demo")).rejects.toMatchObject({ code: "network" });
    expect(service.diagnostics().find((row) => row.extensionId === "demo")?.status).toBe("load-failed");
    expect(service.diagnostics().find((row) => row.extensionId === "demo")?.errorCode).toBe("network");

    service.retry("demo");
    expect(service.diagnostics()).toEqual([]);
    mode = "ok";
    await expect(service.loadDescriptor("demo")).resolves.toMatchObject({ extensionId: "demo" });
  });

  it("未知扩展 ID 无法加载（invalid-artifact）", async () => {
    const service = createExtensionRuntimeService({
      catalogLoader: { load: async () => catalog(), currentReleaseId: () => RELEASE_ID, dispose() {} } as never,
      artifactLoader: artifactLoader(() => "ok")
    });
    await service.ensureCatalog();
    await expect(service.loadDescriptor("missing")).rejects.toMatchObject({ code: "invalid-artifact" });
  });

  it("dispose 后 metadata 清空且后续 ensureCatalog 拒绝", async () => {
    const service = createExtensionRuntimeService({
      catalogLoader: { load: async () => catalog(), currentReleaseId: () => RELEASE_ID, dispose() {} } as never,
      artifactLoader: artifactLoader(() => "ok")
    });
    await service.ensureCatalog();
    service.dispose();
    expect(service.metadata()).toEqual([]);
    await expect(service.ensureCatalog()).rejects.toMatchObject({ code: "evaluation" });
  });
});
