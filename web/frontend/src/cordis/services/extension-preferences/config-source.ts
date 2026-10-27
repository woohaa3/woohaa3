/**
 * browser-local 插件启停的配置来源
 * （配置文件是事实来源：`extensions.frontend.<id>.enabled`）。
 *
 * 三个职责，全部经宿主设置 API：
 * - `readFrontendExtensionPreferences`：从 `GET /api/settings` 快照投影目标状态；
 * - `persistFrontendExtension`：`PUT /api/settings/frontend-plugins`，宿主写配置文件并热生效；
 * - `migrateLegacyPreferences`：把旧版本遗留在 localStorage 的显式选择一次性搬到配置文件。
 *
 * 前端不再持有任何启停持久化介质；配置变了就重新投影，与页面是否重开无关。
 */
import type { FrontendExtensionPreferences } from "./codec.js";
import { readLegacyPreferencesForMigration, type PreferenceStorage } from "./codec.js";
import type { SettingsRemote } from "../settings-remote.js";

export type FrontendPreferencesResult =
  | { ok: true; preferences: FrontendExtensionPreferences }
  | { ok: false; error: string };

/** 从宿主设置快照读取 buser-local 启停目标状态；宿主未提供时返回空映射（= 全部启用）。 */
export async function readFrontendExtensionPreferences(remote: SettingsRemote): Promise<FrontendPreferencesResult> {
  const result = await remote.fetchSnapshot();
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, preferences: result.snapshot.extensionToggles ?? {} };
}

/**
 * 写一个插件的启停目标状态。
 *
 * 返回失败时携带宿主给的**安全**原因（不含配置正文），供面板直接展示。
 */
export function persistFrontendExtension(
  remote: SettingsRemote
): (id: string, enabled: boolean) => Promise<{ ok: true } | { ok: false; error: string }> {
  return async (id, enabled) => {
    if (!remote.setExtensionToggle) return { ok: false, error: "当前宿主不支持保存插件启停" };
    const result = await remote.setExtensionToggle(id, enabled);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  };
}

/**
 * 一次性迁移：旧版浏览器偏好里的**显式**选择写回宿主配置。
 *
 * 只迁移与默认值不同的条目；已经出现在配置文件里的 ID 不覆盖（配置文件更权威）。
 * 迁移完成后不再读取旧键（键本身保留，旧版本回滚仍可读）。
 */
export async function migrateLegacyPreferences(input: {
  remote: SettingsRemote;
  storage: PreferenceStorage | null;
  ids: readonly string[];
  current: FrontendExtensionPreferences;
}): Promise<{ migrated: string[]; error: string | null }> {
  const { explicit, diagnostic } = readLegacyPreferencesForMigration(input.storage, input.ids);
  const pending = Object.entries(explicit).filter(([id]) => input.current[id] === undefined);
  if (pending.length === 0) return { migrated: [], error: diagnostic?.detail ?? null };
  const persist = persistFrontendExtension(input.remote);
  const migrated: string[] = [];
  for (const [id, enabled] of pending) {
    const result = await persist(id, enabled);
    if (result.ok) migrated.push(id);
  }
  return { migrated, error: diagnostic?.detail ?? null };
}

/**
 * 旧版浏览器偏好的读取介质（一次性迁移用）。
 *
 * 只在迁移路径上读一次；新写入一律走宿主配置文件，因此这里没有写入方法。
 */
export function defaultLegacyStorage(): PreferenceStorage | null {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    return { getItem: (key) => storage.getItem(key) };
  } catch {
    return null;
  }
}

/**
 * 轮询配置文件里的启停段，变化时回调。
 *
 * 与站点插件状态同节奏（5s）：宿主配置文件被手工编辑后，宿主侧 watch 已热重载自身，
 * 前端靠这一层感知并热装/热卸。返回停止函数。
 */
export function watchFrontendExtensionPreferences(
  remote: SettingsRemote,
  onChange: (preferences: FrontendExtensionPreferences) => void,
  options: { intervalMs?: number } = {}
): () => void {
  let disposed = false;
  let last = "";
  let inFlight = false;
  const tick = async () => {
    if (disposed || inFlight) return;
    inFlight = true;
    try {
      const result = await readFrontendExtensionPreferences(remote);
      if (disposed || !result.ok) return;
      const signature = JSON.stringify(result.preferences);
      if (signature === last) return;
      last = signature;
      onChange(result.preferences);
    } finally {
      inFlight = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), options.intervalMs ?? 5_000);
  return () => {
    disposed = true;
    clearInterval(timer);
  };
}
