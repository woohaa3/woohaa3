/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { SettingsEntryView, SettingsSnapshot } from "@woohaa3/contracts";
import { createBackendSettingsStore } from "./backend-settings-store.js";
import { ProviderSettingsCards } from "./provider-settings-cards.js";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const entry = (key: string, overrides: Partial<SettingsEntryView> = {}): SettingsEntryView => ({
  key: `providers.test.${key}`, kind: "string", label: key, description: "", reload: "hot", secret: false,
  source: "file", lockedBy: null, value: "", configured: true, pendingRestart: false, group: "Test", ...overrides,
});
async function fixture(extra: SettingsEntryView[] = []) {
  const snapshot: SettingsSnapshot = { settings: [
    entry("apiKey", { label: "API Key", secret: true, value: null, source: "secrets", description: "Test API Key" }),
    entry("baseUrl", { label: "Base URL", kind: "url", value: "https://example.com" }), ...extra,
  ], plugins: [], files: { config: "c", secrets: "s" } };
  const fetchSnapshot = vi.fn(async () => ({ ok: true as const, snapshot }));
  const write = vi.fn(async (_values: Record<string, unknown>) => ({ ok: true as const, snapshot }));
  const store = createBackendSettingsStore({ fetchSnapshot, write });
  const el = document.createElement("div"); document.body.append(el); root = createRoot(el);
  await act(async () => root.render(<ProviderSettingsCards store={store} compact />));
  const click = async (text: string) => act(async () => [...el.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)!.click());
  const input = async (key: string, value: string) => act(async () => {
    const field = el.querySelector<HTMLInputElement>(`[data-setting-key="providers.test.${key}"] input`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return { el, input, click, write, store };
}
it("Provider 一次保存多个字段；收起高级设置和刷新快照不丢草稿", async () => {
  const f = await fixture();
  expect([...f.el.querySelectorAll("button")].filter(button => button.textContent === "保存")).toHaveLength(1);
  expect(f.el.textContent).not.toMatch(/providers\.test|即时生效|密钥文件|Test API Key/);
  const advanced = f.el.querySelector("details")!;
  expect(advanced.open).toBe(false);
  advanced.open = true;
  await f.input("apiKey", "draft-key");
  await f.input("baseUrl", "https://custom.example/v1");
  advanced.open = false;
  await act(async () => f.store.load());
  expect(f.el.querySelector<HTMLInputElement>('[type="password"]')!.value).toBe("draft-key");
  await f.click("保存");
  expect(f.write).toHaveBeenCalledOnce();
  expect(f.write).toHaveBeenCalledWith({ "providers.test.apiKey": "draft-key", "providers.test.baseUrl": "https://custom.example/v1" });
  expect(f.el.querySelector<HTMLInputElement>('[type="password"]')!.value).toBe("");
});
it("空密钥不覆盖已保存密钥；保存失败保留草稿与可重试错误", async () => {
  const f = await fixture();
  await f.input("baseUrl", "https://new.example/v1");
  f.write.mockResolvedValueOnce({ ok: false, error: "地址不可用", code: "invalid" } as never);
  await f.click("保存");
  expect(f.write).toHaveBeenCalledWith({ "providers.test.baseUrl": "https://new.example/v1" });
  expect(f.el.textContent).toContain("地址不可用");
  expect(f.el.querySelector<HTMLInputElement>('[type="url"]')!.value).toBe("https://new.example/v1");
  await f.click("保存");
  expect(f.write).toHaveBeenCalledTimes(2);
});
it("清除须确认后随保存提交；锁定和等待重启的异常保留", async () => {
  const f = await fixture([entry("region", { label: "区域", value: "cn", lockedBy: "TEST_REGION", source: "env", pendingRestart: true })]);
  expect(f.el.textContent).toContain("TEST_REGION");
  expect(f.el.textContent).toContain("等待重启");
  expect(f.el.querySelector<HTMLInputElement>('[data-setting-key="providers.test.region"] input')!.disabled).toBe(true);
  await f.click("清除API Key");
  expect(f.write).not.toHaveBeenCalled();
  await f.click("确认清除");
  expect(f.write).not.toHaveBeenCalled();
  await f.click("保存");
  expect(f.write).toHaveBeenCalledWith({ "providers.test.apiKey": null });
});
