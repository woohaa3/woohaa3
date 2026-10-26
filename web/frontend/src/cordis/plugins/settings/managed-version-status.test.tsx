/**
 * 受管扩展「已撤回」提示（change: 2026-10-21-add-server-extension-marketplace）。
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { InstalledExtensionView, ManagedVersionStatusView } from "@woohaa3/contracts";
import { ManagedVersionStatusNotice, shouldCheckVersionStatus, withdrawnText } from "./managed-version-status.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots = new Set<Root>();
afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.innerHTML = "";
});

const installed = (overrides: Partial<InstalledExtensionView> = {}): InstalledExtensionView => ({
  id: "demo",
  label: "Demo",
  description: "",
  directory: "/x",
  writable: false,
  managed: true,
  version: "1.0.0",
  sourceId: "woohaa-server",
  ...overrides
});
const status = (overrides: Partial<ManagedVersionStatusView> = {}): ManagedVersionStatusView => ({
  extensionId: "demo",
  version: "1.0.0",
  sourceId: "woohaa-server",
  status: "withdrawn",
  checkedAt: "t",
  ...overrides
});

async function render(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  await act(async () => {
    root.render(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

describe("ManagedVersionStatusNotice", () => {
  it("已撤回：显示原因与升级建议；只查询一次", async () => {
    const remote = { versionStatus: vi.fn(async () => status({ reason: "安全问题", latest: "1.2.0" })) };
    const container = await render(<ManagedVersionStatusNotice installed={installed()} remote={remote} />);
    expect(container.querySelector('[data-testid="managed-withdrawn-demo"]')?.textContent).toBe("该版本已被撤回：安全问题。已安装的副本仍在运行，可升级到 v1.2.0，或卸载。");
    expect(remote.versionStatus).toHaveBeenCalledTimes(1);
    expect(remote.versionStatus).toHaveBeenCalledWith("demo");
  });

  it("可用 / 未知 / 查询失败：不显示", async () => {
    for (const result of [status({ status: "available" }), status({ status: "unknown" }), null]) {
      const container = await render(<ManagedVersionStatusNotice installed={installed()} remote={{ versionStatus: async () => result }} />);
      expect(container.querySelector('[data-testid="managed-withdrawn-demo"]')).toBeNull();
    }
    const rejected = await render(<ManagedVersionStatusNotice installed={installed()} remote={{ versionStatus: async () => { throw new Error("x"); } }} />);
    expect(rejected.textContent).toBe("");
  });

  it("本地文件 / 内置扩展 / 无版本：不查询", async () => {
    const remote = { versionStatus: vi.fn(async () => status()) };
    for (const entry of [installed({ sourceId: "local-file" }), installed({ managed: false }), installed({ version: undefined })]) {
      await render(<ManagedVersionStatusNotice installed={entry} remote={remote} />);
    }
    expect(remote.versionStatus).not.toHaveBeenCalled();
    expect(shouldCheckVersionStatus(undefined)).toBe(false);
  });

  it("状态版本与已装版本不一致（已升级）时不显示", async () => {
    const container = await render(<ManagedVersionStatusNotice installed={installed({ version: "1.1.0" })} remote={{ versionStatus: async () => status({ version: "1.0.0" }) }} />);
    expect(container.querySelector('[data-testid="managed-withdrawn-demo"]')).toBeNull();
  });

  it("没有更高版本时建议卸载", () => {
    expect(withdrawnText(status())).toBe("该版本已被撤回，已不在市场的可用版本中。已安装的副本仍在运行，建议卸载或改用其他版本。");
  });
});
