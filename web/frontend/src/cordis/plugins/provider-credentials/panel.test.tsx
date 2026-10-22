/**
 * Provider 凭据弹窗：每个 Provider 一张卡片，只列它配置段里的密钥项；无 Provider 时提示。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SettingsEntryView } from "@woohaa3/contracts";
import { createBackendSettingsStore } from "../settings/backend-settings-store.js";
import { createProviderCredentialsRenderer } from "./panel.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots = new Set<Root>();
afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.innerHTML = "";
});

const entry = (key: string, overrides: Partial<SettingsEntryView>): SettingsEntryView => ({
  key,
  kind: "string",
  label: key,
  description: "",
  reload: "hot",
  secret: false,
  source: null,
  lockedBy: null,
  value: null,
  configured: false,
  pendingRestart: false,
  ...overrides
});

async function render(settings: SettingsEntryView[]) {
  const store = createBackendSettingsStore({
    fetchSnapshot: async () => ({ ok: true, snapshot: { settings, plugins: [], files: { config: "c", secrets: "s" } } }),
    write: async () => ({ ok: false, code: "unavailable", error: "x" })
  });
  const Renderer = createProviderCredentialsRenderer(store);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  await act(async () => {
    root.render(<Renderer instance={{} as never} requestClose={() => undefined} setBusy={() => undefined} replace={() => undefined} />);
  });
  return container;
}

describe("Provider 凭据弹窗", () => {
  it("每个 Provider 一张卡片，只列密钥项", async () => {
    const container = await render([
      entry("storage.cos.secretKey", { secret: true }),
      entry("providers.litellm.apiKey", { secret: true, label: "API Key", group: "LiteLLM" }),
      entry("providers.litellm.baseUrl", { kind: "url", group: "LiteLLM" }),
      entry("providers.runninghub.apiKey", { secret: true, label: "API Key", group: "RunningHub", configured: true, source: "secrets" })
    ]);
    expect(container.textContent).toContain("Provider 凭据");
    expect(container.querySelector('[data-provider-id="litellm"]')?.textContent).toContain("LiteLLM");
    expect(container.querySelector('[data-setting-key="providers.litellm.apiKey"] input')?.getAttribute("type")).toBe("password");
    expect(container.querySelector('[data-setting-key="providers.litellm.baseUrl"]')).toBeNull();
    expect(container.querySelector('[data-setting-key="storage.cos.secretKey"]')).toBeNull();
    expect((container.querySelector('[data-testid="setting-input-providers.runninghub.apiKey"]') as HTMLInputElement).placeholder).toBe("已配置，输入以覆盖");
  });

  it("没有 Provider 时提示", async () => {
    const container = await render([entry("storage.primary", { kind: "string" })]);
    expect(container.querySelector('[data-testid="provider-settings-empty"]')).not.toBeNull();
  });
});
