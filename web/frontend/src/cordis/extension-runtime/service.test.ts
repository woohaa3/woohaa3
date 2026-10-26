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

describe("repin（change: 2026-10-21-harden-extension-fault-isolation）", () => {
  const NEXT_ID = "d".repeat(64);
  const nextCatalog = (): ExtensionReleaseCatalog => ({ ...catalog(), releaseId: NEXT_ID, entries: [releaseEntry("demo"), releaseEntry("added")] });

  it("成功后替换运行时目录、清空诊断并返回新 releaseId", async () => {
    let mode: "ok" | "fail" = "fail";
    const service = createExtensionRuntimeService({
      catalogLoader: {
        load: async () => catalog(),
        repin: async () => nextCatalog(),
        currentReleaseId: () => RELEASE_ID,
        dispose() {}
      } as never,
      artifactLoader: artifactLoader(() => mode)
    });
    await service.ensureCatalog();
    await expect(service.loadDescriptor("demo")).rejects.toBeTruthy();
    expect(service.diagnostics()).toHaveLength(1);
    await expect(service.repin(`/extension-releases/${NEXT_ID}.json`)).resolves.toBe(NEXT_ID);
    expect(service.current()?.releaseId).toBe(NEXT_ID);
    expect(service.metadata().map((entry) => entry.extensionId)).toEqual(["demo", "added"]);
    expect(service.diagnostics()).toEqual([]);
    mode = "ok";
    await expect(service.loadDescriptor("added")).resolves.toMatchObject({ extensionId: "added" });
  });

  it("新目录加载失败：抛出且保留原目录与诊断", async () => {
    const service = createExtensionRuntimeService({
      catalogLoader: {
        load: async () => catalog(),
        repin: async () => { throw new ExtensionLoadError("network", "发布目录请求失败", true); },
        currentReleaseId: () => RELEASE_ID,
        dispose() {}
      } as never,
      artifactLoader: artifactLoader(() => "ok")
    });
    await service.ensureCatalog();
    await expect(service.repin(`/extension-releases/${NEXT_ID}.json`)).rejects.toMatchObject({ code: "network" });
    expect(service.current()?.releaseId).toBe(RELEASE_ID);
  });

  it("dispose 后拒绝 repin", async () => {
    const service = createExtensionRuntimeService({
      catalogLoader: { load: async () => catalog(), repin: async () => nextCatalog(), currentReleaseId: () => RELEASE_ID, dispose() {} } as never
    });
    service.dispose();
    await expect(service.repin(`/extension-releases/${NEXT_ID}.json`)).rejects.toMatchObject({ code: "evaluation" });
  });
});

describe("adoptRelease 热登记（change: 2026-10-21-add-extension-marketplace-point，6.3）", () => {
  const NEXT_ID = "f".repeat(64);
  const upgraded = (): ExtensionBrowserReleaseEntry => ({ ...releaseEntry("demo"), artifactId: "c".repeat(64), entryURL: `/extensions/demo/${"c".repeat(64)}/entry.js` });
  const pointer = { releaseId: NEXT_ID, href: `/extension-releases/${NEXT_ID}.json` };

  function service(next: ExtensionReleaseCatalog, loads: string[] = []) {
    const loader = artifactLoader(() => "ok");
    return createExtensionRuntimeService({
      catalogLoader: { load: async () => catalog(), peek: async () => next, repin: async () => next, currentReleaseId: () => RELEASE_ID, dispose() {} } as never,
      artifactLoader: { ...loader, load: async (entry) => { loads.push(entry.entryURL); return loader.load(entry); } }
    });
  }

  it("只追加新增条目：固定的 releaseId 不变，旧条目保持原 artifact，升级记为待重开", async () => {
    const loads: string[] = [];
    const svc = service({ ...catalog(), releaseId: NEXT_ID, entries: [upgraded(), releaseEntry("added")] }, loads);
    await svc.ensureCatalog();
    const delta = await svc.adoptRelease(pointer);
    expect(delta).toEqual({ added: ["added"], upgraded: ["demo"], removed: [] });
    expect(svc.current()?.releaseId).toBe(RELEASE_ID);
    expect(svc.entry("demo")?.artifactId).toBe("b".repeat(64));
    expect(svc.staleExtensionIds()).toEqual(["demo"]);
    await svc.loadDescriptor("added");
    // 只为新增条目发请求，不碰被升级的旧条目。
    expect(loads).toEqual([`/extensions/added/${"b".repeat(64)}/entry.js`]);
  });

  it("同一 releaseId 幂等；卸载的条目保留在当前页面并提示重开", async () => {
    const svc = service({ ...catalog(), releaseId: NEXT_ID, entries: [] });
    await svc.ensureCatalog();
    expect(await svc.adoptRelease(pointer)).toEqual({ added: [], upgraded: [], removed: ["demo"] });
    expect(svc.entry("demo")).toBeDefined();
    expect(svc.staleExtensionIds()).toEqual(["demo"]);
    expect(await svc.adoptRelease(pointer)).toBeNull();
  });

  it("指针与目录 releaseId 不一致或读取失败：拒绝且运行时目录不变", async () => {
    const svc = service({ ...catalog(), releaseId: "9".repeat(64), entries: [releaseEntry("demo"), releaseEntry("added")] });
    await svc.ensureCatalog();
    await expect(svc.adoptRelease(pointer)).rejects.toMatchObject({ code: "invalid-catalog" });
    expect(svc.entry("added")).toBeUndefined();
  });

  it("目录尚未固定：不发请求，首次加载即用新目录", async () => {
    let peeked = false;
    const svc = createExtensionRuntimeService({
      catalogLoader: { load: async () => catalog(), peek: async () => { peeked = true; return catalog(); }, currentReleaseId: () => null, dispose() {} } as never,
      artifactLoader: artifactLoader(() => "ok")
    });
    await expect(svc.adoptRelease(pointer)).resolves.toBeNull();
    expect(peeked).toBe(false);
  });
});
