/**
 * 受管扩展的静态插件描述 `backend-dist/config-schema.json`
 * （change: 2026-10-21-isolate-extension-host-process，任务 6.1–6.3 / design D1、D9）。
 *
 * 受管扩展的后端只在 Extension Host 子进程里执行，宿主进程不 import 它。可宿主仍要在激活前知道：
 * 插件名、标签、配置段前缀与字段（设置页表单、密钥登记）、模型刷新入口、是否实现 health，以及
 * `metadata` / `publicPathExport` 这些原本靠 import 才能取到的常量。这些信息由 `build:backend` 在
 * **打包机**上求值工厂一次后写进本文件，随包签名分发；宿主与预检只读 JSON。
 *
 * 受管扩展的额外约束（预检与扫描都执行，口径同一函数）：
 * - 配置字段不得声明 `legacyEnv`：否则扩展能借「旧环境变量兼容」读到宿主进程的任意环境变量（含凭据）；
 * - `configPrefix` 必须是 `providers.<名字>` 或 `extensions.<名字>`：不能占用宿主设置命名空间；
 * - `modelRefresh.path` 必须位于扩展自己的 `/api/extensions/<extensionId>/` 之下或声明的公开路径之下。
 */
import fs from "node:fs";
import path from "node:path";

export const CONFIG_SCHEMA_FILE = "config-schema.json";
export const CONFIG_SCHEMA_RELATIVE = `backend-dist/${CONFIG_SCHEMA_FILE}`;
export const CONFIG_SCHEMA_VERSION = 1;

const SETTING_KINDS = ["string", "url", "integer", "boolean"];
const FIELD_KEYS = ["kind", "label", "description", "reload", "secret", "default", "min", "max", "protocols", "legacyEnv"];
const CONFIG_PREFIX = /^(providers|extensions)\.[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 深度判断一个值是否是纯 JSON（无函数、undefined、类实例、循环）。 */
export function isJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, seen));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    return Object.values(value).every((entry) => isJsonValue(entry, seen));
  } finally {
    seen.delete(value);
  }
}

function validateField(name, field, errors) {
  const at = `plugin.fields.${name}`;
  if (!FIELD_NAME.test(name)) errors.push(`${at}：字段名非法`);
  if (!isPlainObject(field)) {
    errors.push(`${at} 必须是对象`);
    return;
  }
  for (const key of Object.keys(field)) if (!FIELD_KEYS.includes(key)) errors.push(`${at} 未知字段：${key}`);
  if (!SETTING_KINDS.includes(field.kind)) errors.push(`${at}.kind 必须是 ${SETTING_KINDS.join(" / ")}`);
  for (const key of ["label", "description"]) if (typeof field[key] !== "string" || field[key].length === 0) errors.push(`${at}.${key} 必须是非空字符串`);
  if (field.reload !== "hot" && field.reload !== "restart") errors.push(`${at}.reload 必须是 hot / restart`);
  if (field.secret !== undefined && typeof field.secret !== "boolean") errors.push(`${at}.secret 必须是布尔值`);
  if (field.legacyEnv !== undefined) errors.push(`${at}.legacyEnv：受管扩展不得读取宿主环境变量`);
  const expected = field.kind === "integer" ? "number" : field.kind === "boolean" ? "boolean" : "string";
  if (field.default !== undefined && typeof field.default !== expected) errors.push(`${at}.default 类型应为 ${expected}`);
  if (field.kind === "integer") {
    for (const key of ["min", "max"]) if (field[key] !== undefined && !Number.isInteger(field[key])) errors.push(`${at}.${key} 必须是整数`);
  }
  if (field.kind === "url" && (!Array.isArray(field.protocols) || !field.protocols.every((entry) => typeof entry === "string"))) {
    errors.push(`${at}.protocols 必须是字符串数组`);
  }
}

/**
 * 校验 config-schema.json 内容并对照 extension.json 声明。返回 `{ ok, errors, value }`。
 * `publicPaths`：允许 modelRefresh 落在的额外公开路径（来自声明的 publicRoutes）。
 */
export function validateConfigSchema(raw, { extensionId, descriptor } = {}) {
  const errors = [];
  if (!isPlainObject(raw)) return { ok: false, errors: [`${CONFIG_SCHEMA_FILE} 必须是 JSON 对象`] };
  if (raw.schemaVersion !== CONFIG_SCHEMA_VERSION) errors.push(`schemaVersion 必须是 ${CONFIG_SCHEMA_VERSION}`);
  if (raw.extensionId !== extensionId) errors.push(`extensionId（${String(raw.extensionId)}）与 extension.json（${String(extensionId)}）不一致`);
  const hostPlugin = descriptor?.hostPlugin;
  if (hostPlugin && (raw.kind !== hostPlugin.kind || raw.factory !== hostPlugin.factory)) {
    errors.push("kind / factory 与 extension.json 的 hostPlugin 不一致（重新执行 build:backend）");
  }
  const plugin = raw.plugin;
  if (!isPlainObject(plugin)) errors.push("plugin 必须是对象");
  else {
    if (plugin.name !== extensionId) errors.push(`plugin.name 必须等于 extensionId：${String(plugin.name)}`);
    if (typeof plugin.label !== "string" || plugin.label.length === 0) errors.push("plugin.label 必须是非空字符串");
    if (typeof plugin.configPrefix !== "string" || !CONFIG_PREFIX.test(plugin.configPrefix)) {
      errors.push(`plugin.configPrefix 必须形如 providers.<名字> 或 extensions.<名字>：${String(plugin.configPrefix)}`);
    }
    if (!isPlainObject(plugin.fields)) errors.push("plugin.fields 必须是对象");
    else for (const [name, field] of Object.entries(plugin.fields)) validateField(name, field, errors);
    if (typeof plugin.health !== "boolean") errors.push("plugin.health 必须是布尔值");
    if (plugin.modelRefresh !== undefined) {
      const refresh = plugin.modelRefresh;
      const allowed = [`/api/extensions/${extensionId}/`, ...Object.values(raw.publicPaths ?? {}).map((value) => `${String(value).replace(/\/$/, "")}/`)];
      if (!isPlainObject(refresh) || typeof refresh.path !== "string" || typeof refresh.hint !== "string") errors.push("plugin.modelRefresh 必须是 { path, hint }");
      else if (!allowed.some((prefix) => `${refresh.path}/`.startsWith(prefix))) {
        errors.push(`plugin.modelRefresh.path 必须位于 /api/extensions/${extensionId}/ 或声明的公开路径之下：${refresh.path}`);
      }
    }
  }
  if (descriptor?.metadata) {
    if (!isPlainObject(raw.metadata) || raw.metadata.export !== descriptor.metadata.export || !isPlainObject(raw.metadata.value)) {
      errors.push("metadata 必须是 { export, value }，与 extension.json 的 metadata.export 一致");
    } else if (raw.metadata.value.extensionId !== extensionId) {
      errors.push("metadata.value.extensionId 与 extension.json 不一致");
    }
  }
  for (const route of descriptor?.publicRoutes ?? []) {
    if (!route.publicPathExport) continue;
    const value = raw.publicPaths?.[route.publicPathExport];
    if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) errors.push(`publicPaths.${route.publicPathExport} 必须是站内绝对路径`);
  }
  if (!isJsonValue(raw)) errors.push(`${CONFIG_SCHEMA_FILE} 含非 JSON 值`);
  return errors.length === 0 ? { ok: true, errors, value: raw } : { ok: false, errors };
}

/** 读取扩展目录里的 config-schema.json：不存在返回 null，非法 JSON 抛错。 */
export function readConfigSchema(dir) {
  const file = path.join(dir, ...CONFIG_SCHEMA_RELATIVE.split("/"));
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
