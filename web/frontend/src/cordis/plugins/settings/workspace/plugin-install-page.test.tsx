/**
 * 「添加扩展」页：来源分段、可用性、兜底提示，以及「详情整页替换列表」。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MarketplaceExtensionDetailView, SettingsSnapshot } from "@woohaa3/contracts";
import type { MarketplaceInstallState } from "../marketplace-install.js";
import { PluginInstallPage } from "./plugin-install-page.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots = new Set<Root>();
afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.innerHTML = "";
});

const snapshot = (): SettingsSnapshot => ({
  settings: [],
  plugins: [],
  installedExtensions: [],
  files: { config: "c", secrets: "s" },
  extensionInstallations: { revision: 1, jobs: [], restartSupported: true }
});

/** 稳定快照：useSyncExternalStore 的 getSnapshot 每次返回新对象会无限重渲染。 */
const MARKET_STATE: MarketplaceInstallState = {
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

const INSTALL_STATE = { jobs: [], error: null, submitting: false, restart: { status: "idle", message: null }, unquarantining: [], riskPrompt: null };
const INSTALL_CONTROLLER = {
  getState: () => INSTALL_STATE,
  subscribe: () => () => undefined,
  busy: () => false,
  installFile: async () => undefined,
  cancel: async () => undefined
};

function marketplaceStub(state: MarketplaceInstallState): never {
  return {
    getState: () => state,
    subscribe: () => () => undefined,
    load: async () => undefined,
    refresh: async () => undefined,
    setSource: async () => undefined,
    search: async () => undefined,
    select: async () => undefined,
    chooseVersion: () => undefined,
    close: vi.fn(),
    install: async () => undefined,
    installListed: async () => undefined,
    trustKey: async () => undefined
  } as never;
}

const EMPTY_PENDING: readonly string[] = [];

function managedWith(marketplace: never | null): never {
  return {
    controller: INSTALL_CONTROLLER,
    pendingReopen: { get: () => EMPTY_PENDING, subscribe: () => () => undefined },
    ...(marketplace ? { marketplace } : {})
  } as never;
}

function render(props: Partial<Parameters<typeof PluginInstallPage>[0]> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  const onSelectMode = vi.fn();
  act(() =>
    root.render(
      <PluginInstallPage
        mode="market"
        onSelectMode={onSelectMode}
        snapshot={snapshot()}
        canManage
        marketAvailable
        fileAvailable
        {...props}
      />
    )
  );
  return { container, onSelectMode };
}

const query = (container: Element, testId: string) => container.querySelector(`[data-testid="${testId}"]`);

describe("添加扩展页", () => {
  it("两种来源都在时用分段切换，选择结果回给上层", () => {
    const { container, onSelectMode } = render();
    const page = query(container, "plugin-install-page")!;
    expect(page).not.toBeNull();
    expect(query(container, "plugin-install-mode")).not.toBeNull();
    // 标题交给面包屑，页面里不再重复一次「添加扩展」。
    expect(container.textContent).not.toContain("添加扩展");
    expect(page.getAttribute("data-view")).toBe("list");
    const fileTab = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("从文件安装"));
    expect(fileTab).toBeDefined();
    act(() => fileTab!.click());
    expect(onSelectMode).toHaveBeenCalledWith("file");
  });

  it("只有一种来源时不渲染分段控件", () => {
    const { container } = render({ fileAvailable: false });
    expect(query(container, "plugin-install-mode")).toBeNull();
    expect(query(container, "plugin-install-page")).not.toBeNull();
  });

  it("宿主没有受管安装能力时说明原因，而不是空白", () => {
    const { container } = render({ marketAvailable: false, fileAvailable: false });
    expect(query(container, "plugin-install-unavailable")).not.toBeNull();
    expect(container.textContent).toContain("没有开启受管扩展安装");
  });

  it("文件安装模式渲染拖放面板", () => {
    const { container } = render({ mode: "file", marketAvailable: false, managed: managedWith(null) });
    expect(query(container, "managed-install")).not.toBeNull();
    expect(query(container, "managed-install-file")).not.toBeNull();
  });
});

describe("安装详情整页替换", () => {
  const detail: MarketplaceExtensionDetailView = {
    sourceId: "woohaa-server",
    extension: {
      extensionId: "photocraft",
      label: "PhotoCraft 图片编辑",
      versions: [{ version: "0.1.1", packageDigest: "sha256:a", size: 2048, keyId: "k1" }]
    },
    trustedKeyIds: [],
    signingKeys: []
  };
  const selected: MarketplaceInstallState = {
    ...MARKET_STATE,
    selected: { extensionId: "photocraft", loading: false, detail, version: "0.1.1" }
  };

  it("详情打开时整页换成详情：来源切换让位，且不再自带「返回列表」", () => {
    const { container } = render({ managed: managedWith(marketplaceStub(selected)) });
    const page = query(container, "plugin-install-page")!;
    expect(page.getAttribute("data-view")).toBe("detail");
    expect(query(container, "plugin-install-mode")).toBeNull();
    expect(query(container, "marketplace-detail")).not.toBeNull();
    expect(container.textContent).toContain("PhotoCraft 图片编辑");
    // 返回由面包屑承担，详情里不再叠一个返回按钮。
    expect(container.textContent).not.toContain("返回列表");
  });

  it("列表状态保留来源切换与结果", () => {
    const { container } = render({ managed: managedWith(marketplaceStub(MARKET_STATE)) });
    expect(query(container, "plugin-install-page")!.getAttribute("data-view")).toBe("list");
    expect(query(container, "plugin-install-mode")).not.toBeNull();
  });
});
