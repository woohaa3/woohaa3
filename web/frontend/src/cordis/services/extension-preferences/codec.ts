/**
 * Frontend 插件偏好 codec
 * （change: add-frontend-plugin-manager，任务 2.1 / design D3）。
 *
 * 纯函数、无 React/DOM：把版本化 `woohaa:frontend-plugins:v1` 记录在**已知可配置
 * optional Plugin ID** 与布尔选择之间严格互转。
 *
 * 严格解析规则（design D3）：
 * - 缺失（`null`）：返回全部启用默认值，无诊断。
 * - JSON 错误 / 非 object / 已知 ID 的值为非 boolean：**整体**降级到全部启用并报告错误类别。
 * - 未知 ID（含 required ID、清单外 ID）：忽略并报告 `unknown-ids`，合法已知值仍生效。
 *
 * codec 只回显**错误类别**，绝不回显原始配置内容。
 */

/** 版本化存储键（新 schema 必须使用新键）。 */
export const FRONTEND_PLUGIN_PREFERENCES_KEY = "woohaa:frontend-extensions:v1";

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

/** 可注入的最小 Storage facade（浏览器 localStorage 或测试替身）。 */
export type PreferenceStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/** 全部启用默认值：缺失配置或降级时保持升级前行为。 */
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

/** 严格解析存储字符串；缺失或损坏时返回默认值与诊断。 */
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

/** 序列化为规范化的完整 map。 */
export function serializePreferences(ids: readonly string[], values: FrontendExtensionPreferences): string {
  return JSON.stringify(normalizePreferences(ids, values));
}
