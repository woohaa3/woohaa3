import { describe, expect, it, vi } from "vitest";
import type { SettingsEntryView } from "@woohaa3/contracts";
import { LEGACY_PROVIDER_KEYS_STORAGE_KEY, migrateLegacyProviderKeys } from "./legacy-provider-keys.js";
import type { SettingsRemote } from "./settings-remote.js";

const key = (providerId: string, overrides: Partial<SettingsEntryView> = {}): SettingsEntryView => ({
  key: `providers.${providerId}.apiKey`,
  kind: "string",
  label: "API Key",
  description: "",
  reload: "hot",
  secret: true,
  source: null,
  lockedBy: null,
  value: null,
  configured: false,
  pendingRestart: false,
  ...overrides
});

function memory(value: unknown) {
  const items = new Map<string, string>([[LEGACY_PROVIDER_KEYS_STORAGE_KEY, JSON.stringify(value)]]);
  return { items, getItem: (k: string) => items.get(k) ?? null, removeItem: (k: string) => void items.delete(k) };
}

function remote(settings: SettingsEntryView[], ok = true): SettingsRemote & { write: ReturnType<typeof vi.fn> } {
  const snapshot = { settings, plugins: [], files: { config: "c", secrets: "s" } };
  return {
    fetchSnapshot: async () => ({ ok: true, snapshot }),
    write: vi.fn(async () => (ok ? { ok: true as const, snapshot } : { ok: false as const, code: "unauthorized", error: "x" }))
  };
}

describe("旧版浏览器 Provider Key 迁移", () => {
  it("只把未配置、未锁定的 Key 写进对应配置段，成功后删掉浏览器副本", async () => {
    const storage = memory({ litellm: { apiKey: " lk " }, runninghub: { apiKey: "rk" }, ark: { apiKey: "ak" }, gone: { apiKey: "x" } });
    const settings = remote([key("litellm"), key("runninghub", { configured: true }), key("ark", { lockedBy: "ARK_VIDEO_API_KEY" })]);
    await migrateLegacyProviderKeys(settings, storage);
    expect(settings.write).toHaveBeenCalledWith({ "providers.litellm.apiKey": "lk" });
    expect(storage.items.has(LEGACY_PROVIDER_KEYS_STORAGE_KEY)).toBe(false);
  });

  it("写入失败时保留浏览器副本", async () => {
    const storage = memory({ litellm: { apiKey: "lk" } });
    await migrateLegacyProviderKeys(remote([key("litellm")], false), storage);
    expect(storage.items.has(LEGACY_PROVIDER_KEYS_STORAGE_KEY)).toBe(true);
  });
});
