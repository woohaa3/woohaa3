/**
 * 设置行：逐项保存的退出保护上报与保存后的基线/密钥清理
 * （change: 2026-10-17-move-settings-into-canvas-dialog，任务 3.3/3.4 / design D4）。
 *
 * 只验证行对 edit-session 的可见事实：未保存输入 = dirty、保存中 = pending、成功后基线重置、
 * 密钥输入立即清空；不采集渲染或截图。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SettingsEntryView, SettingsSnapshot } from "@woohaa3/contracts";
import { createBackendSettingsStore, type BackendSettingsRemote } from "./backend-settings-store.js";
import { createSettingsEditSession } from "./edit-session.js";
import { SettingRow } from "./setting-row.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots = new Set<Root>();
afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.innerHTML = "";
});

const urlEntry = (overrides: Partial<SettingsEntryView> = {}): SettingsEntryView => ({
  key: "canvas.syncUpstream.url",
  kind: "url",
  label: "远端同步地址",
  description: "",
  protocols: ["ws:", "wss:"],
  reload: "hot",
  secret: false,
  source: null,
  lockedBy: null,
  value: null,
  configured: false,
  pendingRestart: false,
  ...overrides
});

const snapshot = (entry: SettingsEntryView): SettingsSnapshot => ({
  settings: [entry],
  plugins: [],
  installedExtensions: [],
  files: { config: "c", secrets: "s" }
});

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function mountRow(
  entry: SettingsEntryView,
  write: BackendSettingsRemote["write"],
  editSession = createSettingsEditSession(),
  test?: BackendSettingsRemote["test"]
) {
  const store = createBackendSettingsStore({
    fetchSnapshot: async () => ({ ok: true, snapshot: snapshot(entry) }),
    write,
    ...(test ? { test } : {})
  });
  await store.load();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  await act(async () => {
    root.render(<SettingRow entry={entry} store={store} editSession={editSession} />);
  });
  return { container, editSession };
}

describe("设置行的退出保护上报", () => {
  it("未保存输入 = dirty；保存中 = pending；成功后重设基线并退出 dirty", async () => {
    let release!: (value: { ok: true; snapshot: SettingsSnapshot }) => void;
    const write = vi.fn(
      () =>
        new Promise<{ ok: true; snapshot: SettingsSnapshot }>((resolve) => {
          release = resolve;
        })
    );
    const { container, editSession } = await mountRow(urlEntry(), write);
    expect(editSession.getSnapshot()).toEqual({ dirty: false, pending: false, hasChanges: false });

    const input = container.querySelector<HTMLInputElement>('[data-testid="setting-input-canvas.syncUpstream.url"]')!;
    typeInto(input, "ws://relay.local");
    expect(editSession.getSnapshot()).toMatchObject({ dirty: true, pending: false });

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="setting-save-canvas.syncUpstream.url"]')!.click());
    expect(editSession.getSnapshot()).toMatchObject({ dirty: true, pending: true });

    await act(async () => {
      release({
        ok: true,
        snapshot: snapshot(urlEntry({ value: "ws://relay.local", source: "file", configured: true }))
      });
    });
    // 成功：基线更新，输入不再算未保存；pending 也退出。
    expect(editSession.getSnapshot()).toEqual({ dirty: false, pending: false, hasChanges: false });
  });

  it("保存失败保留输入与 dirty，并允许重试", async () => {
    const write = vi.fn(async () => ({
      ok: false as const,
      code: "config-invalid",
      error: "协议必须是 ws: / wss:",
      issues: [{ key: "canvas.syncUpstream.url", layer: "file" as const, message: "协议必须是 ws: / wss:" }]
    }));
    const { container, editSession } = await mountRow(urlEntry(), write);
    typeInto(container.querySelector<HTMLInputElement>('[data-testid="setting-input-canvas.syncUpstream.url"]')!, "http://relay");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="setting-save-canvas.syncUpstream.url"]')!.click()
    );
    expect(editSession.getSnapshot()).toMatchObject({ dirty: true, pending: false });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("协议必须是 ws: / wss:");
  });

  it("密钥行只把「有输入」算 dirty，保存成功后立即清空", async () => {
    const secret = urlEntry({ key: "canvas.syncUpstream.token", kind: "string", secret: true, configured: true, source: "secrets" });
    const write = vi.fn(async () => ({
      ok: true as const,
      snapshot: snapshot({ ...secret, configured: true, source: "secrets" as const })
    }));
    const { container, editSession } = await mountRow(secret, write);
    const input = container.querySelector<HTMLInputElement>('[data-testid="setting-input-canvas.syncUpstream.token"]')!;
    expect(input.value).toBe("");
    expect(editSession.getSnapshot().dirty).toBe(false);
    typeInto(input, "alice");
    expect(editSession.getSnapshot().dirty).toBe(true);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="setting-save-canvas.syncUpstream.token"]')!.click()
    );
    expect(container.querySelector<HTMLInputElement>('[data-testid="setting-input-canvas.syncUpstream.token"]')!.value).toBe("");
    expect(editSession.getSnapshot()).toEqual({ dirty: false, pending: false, hasChanges: false });
    // 敏感值不写入任何浏览器存储。
    expect(globalThis.localStorage?.length ?? 0).toBe(0);
  });

  it("提供商密钥行提供测试按钮；保存前固定测试，测试不通过时可点击仍然保存", async () => {
    const providerSecret = urlEntry({
      key: "providers.deepseek.apiKey",
      kind: "string",
      secret: true,
      configured: false,
      source: null
    });
    const write = vi.fn(async () => ({
      ok: true as const,
      snapshot: snapshot({ ...providerSecret, configured: true, source: "secrets" as const })
    }));
    const test = vi.fn(async () => ({ ok: false as const, error: "DeepSeek Key 无效" }));
    const { container } = await mountRow(providerSecret, write, createSettingsEditSession(), test);

    const input = container.querySelector<HTMLInputElement>('[data-testid="setting-input-providers.deepseek.apiKey"]')!;
    typeInto(input, "sk-bad");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="setting-test-providers.deepseek.apiKey"]')!.click();
    });
    expect(test).toHaveBeenCalledWith({ "providers.deepseek.apiKey": "sk-bad" });
    expect(write).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("DeepSeek Key 无效");
    expect(container.querySelector('[data-testid="setting-save-anyway-providers.deepseek.apiKey"]')).not.toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="setting-save-providers.deepseek.apiKey"]')!.click();
    });
    expect(write).not.toHaveBeenCalled();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="setting-save-anyway-providers.deepseek.apiKey"]')!.click();
    });
    expect(write).toHaveBeenCalledWith({ "providers.deepseek.apiKey": "sk-bad" });
  });
});
