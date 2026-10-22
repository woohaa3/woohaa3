/**
 * Theme preset 解析与验证（change: unify-application-theme-tokens，任务 1.2 / design D1/D7）。
 *
 * 严格、无副作用：
 * - 只接受已知 token key、受限 id/version 和规范 hex 颜色；
 * - 拒绝 `url()`、`var()`、gradient、CSS function、控制字符、超长值、未知结构与
 *   prototype-bearing input；
 * - **完整** preset 必须一次通过；不得用默认值与部分无效 preset 合并伪装成功。
 *
 * fingerprint 是确定性内容指纹，参与 render scene equality 与 Bevy theme-only 重建判定。
 */
import {
  APP_THEME_HEX_PATTERN,
  APP_THEME_MAX_ID_LENGTH,
  APP_THEME_MAX_JSON_BYTES,
  APP_THEME_MAX_TOKEN_LENGTH,
  APP_THEME_SCHEMA_VERSION,
  APP_THEME_TOKEN_NAMES,
  isAppThemeTokenName,
  type AppThemeErrorCode,
  type AppThemeSnapshot,
  type AppThemeTokens,
  type AppThemeValidationResult
} from "./schema.js";
import { APP_THEME_DEFAULT_PRESET } from "./generated-default.js";

/** 规范 hex：小写 `#rrggbb`（无 alpha）或 `#rrggbbaa`（有 alpha）。 */
export function parseAppThemeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length > APP_THEME_MAX_TOKEN_LENGTH) return null;
  if (!APP_THEME_HEX_PATTERN.test(value)) return null;
  return value.toLowerCase();
}

/**
 * 稳定内容指纹（FNV-1a 64-bit，hex）。不依赖 crypto，浏览器/Node/Rust 可实现同构。
 * 输入顺序固定为 `id` + `version` + 按 schema 顺序的全部 `name=value`。
 */
export function appThemeFingerprint(input: {
  id: string;
  version: string;
  tokens: AppThemeTokens;
}): string {
  const parts = [`id=${input.id}`, `version=${input.version}`];
  for (const name of APP_THEME_TOKEN_NAMES) parts.push(`${name}=${input.tokens[name]}`);
  const hash = fnv1a64(parts.join("|"));
  return hash.toString(16).padStart(16, "0");
}

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function reject(code: AppThemeErrorCode, error: string): AppThemeValidationResult {
  return { ok: false, code, error };
}

/**
 * 校验一个未知 preset 输入，成功返回不可变 snapshot + 确定性 fingerprint。
 *
 * 注意：`tokens` 只允许覆盖 schema 中已知 key；出现任何未知 key 即整体拒绝。
 */
export function validateAppThemePreset(input: unknown): AppThemeValidationResult {
  if (typeof input === "string") {
    if (byteLength(input) > APP_THEME_MAX_JSON_BYTES) {
      return reject("oversized", "theme preset 超过大小上限");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      return reject("not-object", "theme preset 不是合法 JSON");
    }
    return validateAppThemePreset(parsed);
  }

  if (!isPlainObject(input)) {
    return reject("not-object", "theme preset 必须是普通对象");
  }
  if (hasPrototypeBearing(input)) {
    return reject("prototype-bearing", "theme preset 含 prototype 污染键");
  }
  if (Object.keys(input).some((key) => key !== "id" && key !== "version" && key !== "tokens" && key !== "fingerprint")) {
    return reject("unknown-key", "theme preset 含未知顶层字段");
  }

  const id = input.id;
  if (typeof id !== "string" || id.length === 0 || id.length > APP_THEME_MAX_ID_LENGTH) {
    return reject("invalid-id", "theme id 缺失或超长");
  }
  if (!isSafeId(id)) {
    return reject("invalid-id", "theme id 含非法字符");
  }
  if (input.version !== APP_THEME_SCHEMA_VERSION) {
    return reject("invalid-version", `不支持的 theme schema 版本：${String(input.version)}`);
  }

  const rawTokens = input.tokens;
  if (!isPlainObject(rawTokens)) {
    return reject("not-object", "theme tokens 必须是普通对象");
  }
  if (hasPrototypeBearing(rawTokens)) {
    return reject("prototype-bearing", "theme tokens 含 prototype 污染键");
  }
  const rawKeys = Object.keys(rawTokens);
  for (const key of rawKeys) {
    if (!isAppThemeTokenName(key)) {
      return reject("unknown-key", `未知 theme token：${key}`);
    }
  }
  // 缺少任一必填 token → 整体拒绝（不得部分合并默认值）。
  const tokens = {} as AppThemeTokens;
  for (const name of APP_THEME_TOKEN_NAMES) {
    if (!(name in rawTokens)) {
      return reject("missing-token", `缺少必填 theme token：${name}`);
    }
    const parsed = parseAppThemeHex(rawTokens[name]);
    if (parsed === null) {
      return reject("invalid-token", `theme token ${name} 不是规范 hex 颜色`);
    }
    tokens[name] = parsed;
  }

  const snapshot: AppThemeSnapshot = Object.freeze({
    id,
    version: APP_THEME_SCHEMA_VERSION,
    tokens: Object.freeze(tokens),
    fingerprint: appThemeFingerprint({ id, version: APP_THEME_SCHEMA_VERSION, tokens })
  });
  return { ok: true, theme: snapshot };
}

/** 规范化默认 preset（生成物）；加载即视为合法，但仍走一次校验以钉住一致性。 */
export function defaultAppTheme(): AppThemeSnapshot {
  const result = validateAppThemePreset(APP_THEME_DEFAULT_PRESET);
  if (!result.ok) {
    throw new Error(`内置默认主题非法（生成物漂移）：${result.code} ${result.error}`);
  }
  return result.theme;
}

/** 基于当前合法 snapshot 构造一个替换 tokens 的新合法 snapshot（测试/哨兵用）。 */
export function withAppThemeTokens(
  base: AppThemeSnapshot,
  id: string,
  tokens: Partial<AppThemeTokens>
): AppThemeValidationResult {
  return validateAppThemePreset({
    id,
    version: base.version,
    tokens: { ...base.tokens, ...tokens }
  });
}

function hasPrototypeBearing(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => key === "__proto__" || key === "constructor" || key === "prototype");
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function byteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  return text.length;
}
