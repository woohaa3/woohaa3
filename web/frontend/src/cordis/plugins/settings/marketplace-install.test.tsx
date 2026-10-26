/**
 * 「从市场安装」（change: 2026-10-21-add-server-extension-marketplace，tasks 7.5）。
 *
 * 覆盖：来源唯一时直接进入、来源不可用说明、搜索与版本详情、按精确版本安装（JSON 形态）并交给任务列表、
 * keyId 未信任时提示但不拦截、「信任此公钥」二次确认后写本机信任根（追加不覆盖）、宿主未启用时不出现。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MarketplaceExtensionDetailView, SettingsSnapshot } from "@woohaa3/contracts";
import type { MarketplaceRemote } from "../../services/marketplace-remote.js";
import { appendTrustedKey, createMarketplaceInstallController, TRUSTED_KEYS_SETTING, versionTrusted } from "./marketplace-install.js";
import { MarketplaceInstallPanel } from "./marketplace-install-ui.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots = new Set<Root>();
afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.innerHTML = "";
});

const ENGINES = { hostAbi: "^1.0.0", sdkAbi: "^1.0.0", protocolVersion: 1 };

function detail(trusted: string[]): MarketplaceExtensionDetailView {
  return {
    sourceId: "woohaa-server",
    extension: {
      extensionId: "demo",
      label: "Demo",
      versions: [
        { version: "1.0.0", packageDigest: "sha256:a", size: 2048, keyId: "k1", engines: ENGINES },
        { version: "1.1.0", packageDigest: "sha256:b", size: 4096, keyId: "k2", engines: ENGINES, dependencies: { base: "^1" } }
      ]
    },
    trustedKeyIds: trusted,
    signingKeys: [
      { keyId: "k1", publicKey: "PUB1", trusted: trusted.includes("k1") },
      { keyId: "k2", label: "团队", publicKey: "PUB2", trusted: trusted.includes("k2") }
    ]
  };
}

function fakeRemote(overrides: Partial<MarketplaceRemote> = {}, trustedRef = { current: ["k1"] }): MarketplaceRemote & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { search: [], extension: [], install: [] };
  return {
    calls,
    search: vi.fn(async (input) => {
      calls.search!.push(input);
      return {
        ok: true as const,
        items: [{ extensionId: "demo", label: "Demo", latest: "1.1.0", description: "示例" }],
        sources: [{ sourceId: "woohaa-server", label: "团队市场", ok: true }],
        unavailable: []
      };
    }),
    extension: vi.fn(async (input) => {
      calls.extension!.push(input);
      return { ok: true as const, detail: detail(trustedRef.current) };
    }),
    install: vi.fn(async (input) => {
      calls.install!.push(input);
      return { ok: true as const, jobId: "job-1" };
    }),
    ...overrides
  } as MarketplaceRemote & { calls: Record<string, unknown[]> };
}

const snapshot = (enabled = true): SettingsSnapshot =>
  ({
    settings: [{ key: TRUSTED_KEYS_SETTING, value: "k1=PUB1" }],
    plugins: [],
    files: { config: "", secrets: "" },
    ...(enabled ? { extensionInstallations: { revision: 0, jobs: [], restartSupported: true, allowUnsignedLocal: false } } : {})
  }) as unknown as SettingsSnapshot;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function render(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  act(() => root.render(element));
  return container;
}

const click = (el: Element | null) => act(() => (el as HTMLElement).click());

describe("marketplace install controller", () => {
  it("唯一来源直接进入并列出结果；选扩展默认最新版本", async () => {
    const remote = fakeRemote();
    const controller = createMarketplaceInstallController({ remote, onJob: () => undefined, readTrustedKeys: () => "", writeSetting: async () => ({ ok: true }) });
    await controller.load();
    expect(controller.getState()).toMatchObject({ sourceId: "woohaa-server", items: [{ extensionId: "demo" }], unavailableReason: null });
    await controller.select("demo");
    expect(controller.getState().selected?.version).toBe("1.1.0");
    expect(versionTrusted(controller.getState().selected!.detail!, "1.1.0")).toBe(false);
    expect(versionTrusted(controller.getState().selected!.detail!, "1.0.0")).toBe(true);
  });

  it("来源不可用：给出原因、不列结果", async () => {
    const remote = fakeRemote({
      search: async () => ({ ok: true, items: [], sources: [{ sourceId: "woohaa-server", label: "团队市场", ok: false, reason: "本地模式：未配置服务端地址" }], unavailable: [{ sourceId: "woohaa-server", reason: "本地模式：未配置服务端地址" }] })
    });
    const controller = createMarketplaceInstallController({ remote, onJob: () => undefined, readTrustedKeys: () => "", writeSetting: async () => ({ ok: true }) });
    await controller.load();
    expect(controller.getState()).toMatchObject({ unavailableReason: "本地模式：未配置服务端地址", items: [] });
  });

  it("安装：按所选精确版本发 JSON 安装请求，任务交给受管任务列表；失败显示原因", async () => {
    const onJob = vi.fn();
    const remote = fakeRemote();
    const controller = createMarketplaceInstallController({ remote, onJob, readTrustedKeys: () => "", writeSetting: async () => ({ ok: true }) });
    await controller.load();
    await controller.select("demo");
    controller.chooseVersion("1.0.0");
    await controller.install();
    expect(remote.calls.install).toEqual([{ sourceId: "woohaa-server", extensionId: "demo", range: "1.0.0" }]);
    expect(onJob).toHaveBeenCalledWith("job-1", undefined);

    const failing = createMarketplaceInstallController({
      remote: fakeRemote({ install: async () => ({ ok: false, code: "forbidden", error: "需要站点管理员授权" }) }),
      onJob,
      readTrustedKeys: () => "",
      writeSetting: async () => ({ ok: true })
    });
    await failing.load();
    await failing.select("demo");
    await failing.install();
    expect(failing.getState().error).toBe("需要站点管理员授权");
  });

  it("信任公钥：追加到本机信任根（不覆盖、不重复）后刷新详情", async () => {
    const trustedRef = { current: ["k1"] };
    const writes: Array<[string, string]> = [];
    const remote = fakeRemote({}, trustedRef);
    const controller = createMarketplaceInstallController({
      remote,
      onJob: () => undefined,
      readTrustedKeys: () => "k1=PUB1",
      writeSetting: async (key, value) => {
        writes.push([key, value]);
        trustedRef.current = ["k1", "k2"];
        return { ok: true };
      }
    });
    await controller.load();
    await controller.select("demo");
    await controller.trustKey({ keyId: "k2", publicKey: "PUB2" });
    expect(writes).toEqual([[TRUSTED_KEYS_SETTING, "k1=PUB1,k2=PUB2"]]);
    expect(controller.getState().selected?.detail?.trustedKeyIds).toEqual(["k1", "k2"]);
    expect(appendTrustedKey("k1=PUB1, k2=PUB2", { keyId: "k2", publicKey: "OTHER" })).toBe("k1=PUB1,k2=PUB2");
    expect(appendTrustedKey("", { keyId: "k3", publicKey: "P3" })).toBe("k3=P3");
  });
});

describe("MarketplaceInstallPanel", () => {
  it("宿主未启用受管安装或无管理权限时不出现", () => {
    const controller = createMarketplaceInstallController({ remote: fakeRemote(), onJob: () => undefined, readTrustedKeys: () => "", writeSetting: async () => ({ ok: true }) });
    expect(render(<MarketplaceInstallPanel controller={controller} snapshot={snapshot(false)} canManage />).querySelector('[data-testid="marketplace-install"]')).toBeNull();
    expect(render(<MarketplaceInstallPanel controller={controller} snapshot={snapshot()} canManage={false} />).querySelector('[data-testid="marketplace-install"]')).toBeNull();
  });

  it("未信任公钥：提示但安装按钮可点；「信任此公钥」需二次确认才写入", async () => {
    const writes: string[] = [];
    const remote = fakeRemote();
    const controller = createMarketplaceInstallController({
      remote,
      onJob: () => undefined,
      readTrustedKeys: () => "k1=PUB1",
      writeSetting: async (_key, value) => {
        writes.push(value);
        return { ok: true };
      }
    });
    const container = render(<MarketplaceInstallPanel controller={controller} snapshot={snapshot()} canManage />);
    click(container.querySelector('[data-testid="marketplace-install-toggle"]'));
    await flush();
    expect(container.querySelector('[data-testid="marketplace-item-demo"]')?.textContent).toContain("v1.1.0");
    click(container.querySelector('[data-testid="marketplace-item-demo"] button'));
    await flush();
    expect(container.querySelector('[data-testid="marketplace-version-meta"]')?.textContent).toContain("4 KB");
    expect(container.querySelector('[data-testid="marketplace-untrusted"]')?.textContent).toContain("安装会失败");
    const submit = container.querySelector('[data-testid="marketplace-install-submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);

    click(container.querySelector('[data-testid="marketplace-trust"]'));
    expect(container.querySelector('[data-testid="marketplace-trust-confirm"]')?.textContent).toContain("k2");
    expect(writes).toEqual([]);
    click(container.querySelector('[data-testid="marketplace-trust-confirm-yes"]'));
    await flush();
    expect(writes).toEqual(["k1=PUB1,k2=PUB2"]);

    click(submit);
    await flush();
    expect(remote.calls.install).toEqual([{ sourceId: "woohaa-server", extensionId: "demo", range: "1.1.0" }]);
    expect(container.querySelector('[data-testid="marketplace-notice"]')?.textContent).toContain("demo@1.1.0");
  });
});
