/**
 * 旧版浏览器里保存的 Provider API Key 一次性迁移。
 *
 * 以前 apiKey 存在 localStorage（`woohaa:provider-credentials:v1`，形如
 * `{ "<providerId>": { "apiKey": "..." } }`）再推给后端内存。现在密钥是 Provider 配置段里的
 * `secret` 项，写进本机密钥文件。启动时把仍在浏览器里的 Key 写到对应的 `providers.<id>.apiKey`
 * （后端已配置的不覆盖），写入成功或无可迁移项后删除浏览器副本；无权限或失败时保留，下次再试。
 */
import type { SettingsWriteValue } from "@woohaa3/contracts";
import type { SettingsRemote } from "./settings-remote.js";

export const LEGACY_PROVIDER_KEYS_STORAGE_KEY = "woohaa:provider-credentials:v1";

export type LegacyKeyStorage = Pick<Storage, "getItem" | "removeItem">;

export async function migrateLegacyProviderKeys(remote: SettingsRemote, storage: LegacyKeyStorage | null = defaultStorage()): Promise<void> {
  if (!storage) return;
  let raw: string | null;
  try {
    raw = storage.getItem(LEGACY_PROVIDER_KEYS_STORAGE_KEY);
  } catch {
    return;
  }
  if (raw === null) return;
  const stored = parse(raw);
  const snapshot = await remote.fetchSnapshot();
  if (!snapshot.ok) return;
  const entries = new Map(snapshot.snapshot.settings.map((entry) => [entry.key, entry]));
  const values: Record<string, SettingsWriteValue> = {};
  for (const [providerId, apiKey] of Object.entries(stored)) {
    const entry = entries.get(`providers.${providerId}.apiKey`);
    if (entry?.secret && !entry.configured && entry.lockedBy === null) values[entry.key] = apiKey;
  }
  if (Object.keys(values).length > 0 && !(await remote.write(values)).ok) return;
  try {
    storage.removeItem(LEGACY_PROVIDER_KEYS_STORAGE_KEY);
  } catch {
    // 存储不可写时下次启动再试。
  }
}

function parse(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [providerId, fields] of Object.entries(parsed as Record<string, unknown>)) {
      const apiKey = typeof fields === "object" && fields !== null ? (fields as Record<string, unknown>).apiKey : undefined;
      if (typeof apiKey === "string" && apiKey.trim() !== "") out[providerId] = apiKey.trim();
    }
    return out;
  } catch {
    return {};
  }
}

function defaultStorage(): LegacyKeyStorage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}
