/**
 * Frontend 插件偏好 codec
 * （change: add-frontend-plugin-manager，任务 2.1 / design D3；
 *  其后改为配置文件投影：localStorage 只剩一次性迁移读取）。
 *
 * 纯函数、无 React/DOM：
 * - 从宿主配置投影（`extensions.<id>.enabled`）规范化出**已知可配置 optional ID**
 *   到布尔值的映射；
 * - 读取旧版本遗留在浏览器 localStorage 的 `woohaa:frontend-extensions:v1`，仅供**一次性迁移**
 *   写回宿主配置文件，之后不再写这个键。
 *
 * 严格解析规则：缺失返回全部启用；JSON 错误 / 非 object / 非布尔值整体降级；未知 ID 忽略并上报。
 * codec 只回显**错误类别**，绝不回显原始配置内容。
 */

/**
 * 旧版浏览器偏好键：仅用于**一次性迁移**到宿主配置文件。
 *
 * 新写入一律走宿主配置（`extensions.<id>.enabled`），本键不再被写入。
 */
export const LEGACY_FRONTEND_PLUGIN_PREFERENCES_KEY = "woohaa:frontend-extensions:v1";

/** @deprecated 仅为迁移保留；新代码不要引用。 */
export const FRONTEND_PLUGIN_PREFERENCES_KEY = LEGACY_FRONTEND_PLUGIN_PREFERENCES_KEY;

/** 有效选择：只含可配置 optional ID 到布尔值的映射。 */
export type FrontendExtensionPreferences = Readonly<Record<string, boolean>>;

/** 不含原始内容的诊断类别。 */
export type PreferencesDiagnosticCode =
  | "malformed-json"
  | "not-object"
  | "non-boolean"
  | "unknown-ids"
  | "storage-read-failed"
  | "storage-write-failed";

export type PreferencesDiagnostic = {
  code: PreferencesDiagnosticCode;
  /** 安全摘要（不含原始配置内容或敏感数据）。 */
  detail: string;
};

export type PreferencesParseResult = {
  preferences: FrontendExtensionPreferences;
  diagnostic: PreferencesDiagnostic | null;
};

/** 可注入的最小 Storage facade（只读；仅用于旧版偏好的一次性迁移）。 */
export type PreferenceStorage = {
  getItem(key: string): string | null;
};

/** 全部启用默认值：缺失配置或降级时保持既有行为。 */
export function defaultPreferences(ids: readonly string[]): FrontendExtensionPreferences {
  const out: Record<string, boolean> = {};
  for (const id of ids) out[id] = true;
  return out;
}

/** 规范化写入值：完整已知 ID map（避免部分写导致下次解析歧义）。 */
export function normalizePreferences(
  ids: readonly string[],
  values: FrontendExtensionPreferences
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const id of ids) out[id] = values[id] ?? true;
  return out;
}

/** 严格解析旧版偏好字符串；缺失或损坏时返回默认值与诊断。 */
export function parsePreferences(raw: string | null, ids: readonly string[]): PreferencesParseResult {
  const fallback = { preferences: defaultPreferences(ids), diagnostic: null } as const;
  if (raw == null) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      preferences: fallback.preferences,
      diagnostic: { code: "malformed-json", detail: "插件配置不是合法 JSON 值" }
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      preferences: fallback.preferences,
      diagnostic: { code: "not-object", detail: "插件配置不是受支持的布尔映射" }
    };
  }
  const source = parsed as Record<string, unknown>;
  const preferences: Record<string, boolean> = {};
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (!ids.includes(key)) {
      unknown.push(key);
      continue;
    }
    if (typeof value !== "boolean") {
      return {
        preferences: fallback.preferences,
        diagnostic: { code: "non-boolean", detail: "插件配置包含非布尔值" }
      };
    }
    preferences[key] = value;
  }
  const merged = { ...defaultPreferences(ids), ...preferences };
  if (unknown.length > 0) {
    return {
      preferences: merged,
      diagnostic: {
        code: "unknown-ids",
        detail: `忽略 ${unknown.length} 个未知或不可配置的插件 ID`
      }
    };
  }
  return { preferences: merged, diagnostic: null };
}

/** 序列化为规范化的完整 map（仅迁移/测试用；生产写入走宿主配置）。 */
export function serializePreferences(ids: readonly string[], values: FrontendExtensionPreferences): string {
  return JSON.stringify(normalizePreferences(ids, values));
}

/**
 * 读取旧版浏览器偏好，返回**需要迁移**的显式选择。
 *
 * 只返回 allowlist 内、且与默认值不同的条目：迁移只为把用户显式改过的开关带到配置文件，
 * 不把默认全启用的噪音写进 `extensions`。
 */
export function readLegacyPreferencesForMigration(
  storage: PreferenceStorage | null,
  ids: readonly string[]
): { explicit: Record<string, boolean>; diagnostic: PreferencesDiagnostic | null } {
  if (storage === null) return { explicit: {}, diagnostic: null };
  let raw: string | null;
  try {
    raw = storage.getItem(LEGACY_FRONTEND_PLUGIN_PREFERENCES_KEY);
  } catch {
    return {
      explicit: {},
      diagnostic: { code: "storage-read-failed", detail: "浏览器拒绝读取旧版插件选择，跳过迁移" }
    };
  }
  const parsed = parsePreferences(raw, ids);
  const defaults = defaultPreferences(ids);
  const explicit: Record<string, boolean> = {};
  for (const [id, enabled] of Object.entries(parsed.preferences)) {
    if (defaults[id] !== enabled) explicit[id] = enabled;
  }
  return { explicit, diagnostic: parsed.diagnostic };
}
