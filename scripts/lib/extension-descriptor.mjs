/**
 * 扩展声明 `extension.json` 的 schema 与校验
 * （change: 2026-10-15-add-scannable-extension-directories，任务 2.1 / design D2）。
 *
 * 声明是**纯数据**：只说明宿主接线事实（身份、站点目录元数据、后端工厂与选项 identity、公开路由、
 * 扩展层插件、图标（品牌图形或语义图形名）、必需标记），不含源码、脚本、远程地址或运行期加载入口。
 * 启动期宿主据此加载与装配（没有需要同步的注册表生成物）；发布目录是唯一的运行期生成物。
 */
import fs from "node:fs";
import path from "node:path";

import { EXTENSION_DESCRIPTOR_NAME, ExtensionScanError } from "./extension-scan.mjs";

export const EXTENSION_DESCRIPTOR_SCHEMA_VERSION = 1;
export const EXTENSION_DESCRIPTOR_TOP_LEVEL_KEYS = ["schemaVersion", "extensionId", "version", "engines", "migrate", "site", "backend", "executors", "bootstrap", "metadata", "publicRoutes", "hostPlugin", "canvasContent", "content", "icon", "required"];
export const EXTENSION_CAPABILITY_KINDS = ["capability", "handler"];
export const EXTENSION_CAPABILITY_AUTH = ["public", "authenticated"];
export const EXTENSION_ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
/**
 * 扩展层 Cordis 插件提供的功能面（`hostPlugin.features`，**可多选**）。
 *
 * 一个插件同时提供 Provider、存储后端与市场来源是正常情况，所以这不是单值枚举：
 * - `provider`：注入 `ctx.generation`（模型 Provider）；
 * - `storage`：注入 `ctx.storage`（存储后端），**唯一有装载语义的一项**——
 *   `storage.primary` 指向它时必须就绪，其余并发装载；
 * - `marketplace-source`：向 `ctx.marketplace` 注册来源（合法性由运行期 origin 判定）。
 *
 * 三者互不排斥，也不决定「装了之后能干什么」——能干什么取决于插件实际调用了哪些服务。
 * 这里只声明「提供哪类功能」，用于装载排序、就绪判定与受管根校验。
 */
export const EXTENSION_HOST_PLUGIN_FEATURES = ["provider", "storage", "marketplace-source"];

/**
 * 已废弃、但仍被接受并自动归一的声明字段。
 *
 * 保留它们只是为了给**已有扩展**一个过渡期（外部 / 市场扩展不在本仓，改不到）。
 * 这里只放「读进来就归一」的字段，不复用旧语义：归一后下游只认新字段。
 *
 * **删除清单**（检索标记 `deprecated-declaration`）：
 * 1. 本表里对应条目；
 * 2. `validateExtensionDescriptor` 里 `hostPlugin.kind` 的归一分支；
 * 3. `extension-descriptor.test.mjs` 里 `hostPlugin.kind` 的两条用例；
 * 4. `docs/code-map/extensions.md` 中关于过渡期的说明。
 *
 * TODO(remove-after: 2026-12-31)
 */
export const EXTENSION_DEPRECATED_DECLARATIONS = Object.freeze({
  // deprecated-declaration
  "hostPlugin.kind": "hostPlugin.features"
});

/**
 * 宿主自身满足的运行环境（change: 2026-10-21-add-extension-marketplace-point，design D4）。
 *
 * `hostAbi`：宿主后端 SDK ABI（`HostExtensionContext` 形状）；`sdkAbi`：浏览器 SDK ABI，与
 * `EXTENSION_SDK_ABI_VERSION` 同步；`protocolVersion`：browser artifact / 包格式协议版本。
 * 扩展 `extension.json` 的 `engines` 用 semver range 声明要求，在 resolve 与预检两处检查。
 */
export const HOST_ENGINES = Object.freeze({ hostAbi: "1.0.0", sdkAbi: "1.0.0", protocolVersion: 1 });

/** 权限声明字段（本期只校验格式并记录，不强制；与后续进程隔离 change 的 ctx 裁剪一一对应）。 */

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HOSTNAME = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{1,5})?$/;

/** 严格 semver（`1.2.3`，可带预发布/构建后缀）。 */
export function isSemver(value) {
  return typeof value === "string" && SEMVER.test(value);
}

function parseVersion(value) {
  const match = /^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(value);
  if (!match) return null;
  const part = (raw) => (raw === undefined || raw === "x" || raw === "*" ? null : Number(raw));
  return [Number(match[1]), part(match[2]), part(match[3])];
}

function compareTriples(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function coreOf(version) {
  const match = SEMVER.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * 判断版本是否满足一个 semver range（只支持本仓库需要的子集，不引入依赖）：
 * `*`、`1` / `1.x` / `1.2.x`、精确版本、`^1.2.3`、`~1.2.3`、比较符 `>= > <= < =`，空格表示交集，`||` 表示并集。
 * 预发布后缀只比较核心三段。无法解析的 range 返回 `null`（由调用方当作非法声明）。
 */
export function satisfiesRange(version, range) {
  const target = coreOf(version);
  if (!target || typeof range !== "string" || range.trim().length === 0) return null;
  let anyValid = false;
  for (const alternative of range.split("||").map((entry) => entry.trim())) {
    if (alternative.length === 0) return null;
    const comparators = alternative.split(/\s+/);
    let ok = true;
    for (const comparator of comparators) {
      const result = matchComparator(target, comparator);
      if (result === null) return null;
      if (!result) ok = false;
    }
    anyValid = true;
    if (ok) return true;
  }
  return anyValid ? false : null;
}

function matchComparator(target, comparator) {
  if (comparator === "*" || comparator === "x") return true;
  const match = /^(\^|~|>=|<=|>|<|=)?v?(.+)$/.exec(comparator);
  if (!match) return null;
  const operator = match[1] ?? "";
  const parsed = parseVersion(match[2].replace(/-.*$/, ""));
  if (!parsed) return null;
  const [major, minor, patch] = parsed;
  const floor = [major, minor ?? 0, patch ?? 0];
  if (operator === "^") {
    const ceiling = major > 0 ? [major + 1, 0, 0] : minor === null ? [1, 0, 0] : minor > 0 ? [0, minor + 1, 0] : [0, 0, (patch ?? 0) + 1];
    return compareTriples(target, floor) >= 0 && compareTriples(target, ceiling) < 0;
  }
  if (operator === "~") {
    const ceiling = minor === null ? [major + 1, 0, 0] : [major, minor + 1, 0];
    return compareTriples(target, floor) >= 0 && compareTriples(target, ceiling) < 0;
  }
  if (operator === "" || operator === "=") {
    if (minor === null) return target[0] === major;
    if (patch === null) return target[0] === major && target[1] === minor;
    return compareTriples(target, floor) === 0;
  }
  const order = compareTriples(target, floor);
  if (operator === ">=") return order >= 0;
  if (operator === ">") return order > 0;
  if (operator === "<=") return order <= 0;
  return order < 0;
}

/**
 * 检查扩展声明的 `engines` 是否与宿主兼容。返回 `{ ok: true }` 或 `{ ok: false, reasons }`。
 * 未声明 `engines` 视为兼容（内置扩展与宿主同版本发布）；受管扩展的"必须声明"由预检负责。
 */
export function checkEnginesCompatible(engines, host = HOST_ENGINES) {
  if (engines === undefined || engines === null) return { ok: true };
  const reasons = [];
  for (const key of ["hostAbi", "sdkAbi"]) {
    const result = satisfiesRange(host[key], engines[key]);
    if (result === null) reasons.push(`engines.${key} 不是合法的 semver range：${String(engines[key])}`);
    else if (!result) reasons.push(`engines.${key}（${engines[key]}）不包含宿主 ${host[key]}`);
  }
  if (engines.protocolVersion !== host.protocolVersion) {
    reasons.push(`engines.protocolVersion（${String(engines.protocolVersion)}）与宿主协议 ${host.protocolVersion} 不一致`);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

function validateEngines(engines, errors) {
  if (!isPlainObject(engines)) {
    errors.push("engines 必须是对象");
    return;
  }
  for (const key of unknownKeys(engines, ["hostAbi", "sdkAbi", "protocolVersion"])) errors.push(`engines 未知字段：${key}`);
  for (const key of ["hostAbi", "sdkAbi"]) {
    if (!isNonEmptyString(engines[key])) errors.push(`engines.${key} 必须是非空 semver range（如 ^1.0.0）`);
    else if (satisfiesRange("0.0.0", engines[key]) === null) errors.push(`engines.${key} 不是合法的 semver range：${engines[key]}`);
  }
  if (!Number.isInteger(engines.protocolVersion) || engines.protocolVersion < 1) errors.push("engines.protocolVersion 必须是正整数");
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const KEBAB_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const CONTENT_FIELD_NAME = /^[A-Za-z][A-Za-z0-9]*$/;
const CONTENT_TOOL_NAME = /^[a-z][a-z0-9_]*$/;
const CONTENT_ROUTE_PREFIX = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const CONTENT_KEYS = ["ownedFields", "ownedWireFields", "routePrefix", "mcpTools", "targetModes", "eventOwners"];
/** 只接受包内相对模块（`./backend` 这类子路径），拒绝 URL/绝对路径/脚本地址。 */
const PACKAGE_SUBPATH = /^\.\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
/** 品牌图形允许的扩展名（与 contracts 的图标资产白名单一致）。 */
const IMAGE_EXTENSIONS = new Set([".png", ".svg", ".jpg", ".jpeg", ".webp"]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateContentNames(value, label, pattern, errors) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !pattern.test(item))) {
    errors.push(`${label} 必须是非空且格式合法的字符串数组`);
    return;
  }
  if (new Set(value).size !== value.length) errors.push(`${label} 不得重复`);
}

/** 跨扩展的内容声明必须唯一：字段、wire、路由前缀、工具、目标模式与事件归属。 */
export function contentDeclarationCollisions(registrations) {
  const owners = new Map();
  const errors = [];
  const claim = (kind, name, registration) => {
    const key = `${kind}\0${name}`;
    const previous = owners.get(key);
    if (previous) {
      errors.push({
        extensionId: registration.extensionId,
        directory: registration.directory ?? "",
        message: `content.${kind}「${name}」与扩展 ${previous} 冲突`
      });
      return;
    }
    owners.set(key, registration.extensionId);
  };
  for (const registration of registrations ?? []) {
    const content = registration.descriptor?.content;
    if (!content || typeof content !== "object") continue;
    for (const name of content.ownedFields ?? []) claim("ownedFields", name, registration);
    for (const name of content.ownedWireFields ?? []) claim("ownedWireFields", name, registration);
    if (typeof content.routePrefix === "string") claim("routePrefix", content.routePrefix, registration);
    for (const name of content.mcpTools ?? []) claim("mcpTools", name, registration);
    for (const name of content.targetModes ?? []) claim("targetModes", name, registration);
    for (const name of content.eventOwners ?? []) claim("eventOwners", name, registration);
  }
  return errors;
}

/**
 * 校验一份声明。
 *
 * 返回 `{ ok: true, value }` 或 `{ ok: false, errors: string[] }`；错误信息面向作者，指出字段与原因。
 */
export function validateExtensionDescriptor(value) {
  const errors = [];
  /** 本次声明里用到的废弃字段（`{ field, replacement }`）；调用方据此告警。 */
  const deprecations = [];
  if (!isPlainObject(value)) return { ok: false, errors: ["声明必须是 JSON 对象"] };

  for (const key of unknownKeys(value, EXTENSION_DESCRIPTOR_TOP_LEVEL_KEYS)) {
    errors.push(`未知字段：${key}`);
  }
  if (value.schemaVersion !== EXTENSION_DESCRIPTOR_SCHEMA_VERSION) {
    errors.push(`schemaVersion 必须是 ${EXTENSION_DESCRIPTOR_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(value.extensionId) || !KEBAB_ID.test(value.extensionId)) {
    errors.push("extensionId 必须是非空 kebab-case 字符串（如 sample-access）");
  }

  // 分发字段（change: 2026-10-21-add-extension-marketplace-point，任务 1.3）：全部可选，旧扩展不受影响；
  // 受管扩展（.wxt 安装）在预检阶段要求 version 与 engines 必填。
  if (value.version !== undefined && !isSemver(value.version)) errors.push("version 必须是 semver（如 1.2.0）");
  if (value.engines !== undefined) validateEngines(value.engines, errors);
  // `migrate` 只预留：声明了数据迁移的包在受管安装预检时被拒绝（需要进程隔离支持）。
  if (value.migrate !== undefined) {
    if (!isPlainObject(value.migrate)) {
      errors.push("migrate 必须是对象");
    } else {
      for (const key of unknownKeys(value.migrate, ["module", "export"])) errors.push(`migrate 未知字段：${key}`);
      const moduleValue = value.migrate.module ?? "./backend";
      if (!isNonEmptyString(moduleValue) || !PACKAGE_SUBPATH.test(moduleValue)) errors.push("migrate.module 必须是包内相对子路径");
      if (!isNonEmptyString(value.migrate.export) || !IDENTIFIER.test(value.migrate.export)) errors.push("migrate.export 必须是导出函数名");
    }
  }

  const site = value.site;
  if (site !== undefined) {
    if (!isPlainObject(site)) {
      errors.push("site 必须是对象");
    } else {
      for (const key of unknownKeys(site, ["name", "description", "version", "configSchema", "capabilities", "defaultEnabled", "order", "dependencies"])) {
        errors.push(`site 未知字段：${key}`);
      }
      for (const key of ["name", "description", "version"]) {
        if (!isNonEmptyString(site[key])) errors.push(`site.${key} 必须是非空字符串`);
      }
      if (!isPlainObject(site.configSchema)) {
        errors.push("site.configSchema 必须是对象");
      } else {
        for (const key of unknownKeys(site.configSchema, ["schemaId", "schemaVersion"])) errors.push(`site.configSchema 未知字段：${key}`);
        if (!isNonEmptyString(site.configSchema.schemaId)) errors.push("site.configSchema.schemaId 必须是非空字符串");
        if (!Number.isInteger(site.configSchema.schemaVersion) || site.configSchema.schemaVersion < 1) errors.push("site.configSchema.schemaVersion 必须是正整数");
      }
      if (!Array.isArray(site.capabilities) || site.capabilities.length === 0) {
        errors.push("site.capabilities 必须是非空数组");
      } else {
        site.capabilities.forEach((capability, index) => {
          if (!isPlainObject(capability)) {
            errors.push(`site.capabilities[${index}] 必须是对象`);
            return;
          }
          for (const key of unknownKeys(capability, ["id", "kind", "description", "auth"])) errors.push(`site.capabilities[${index}] 未知字段：${key}`);
          if (!isNonEmptyString(capability.id)) errors.push(`site.capabilities[${index}].id 必须是非空字符串`);
          if (!EXTENSION_CAPABILITY_KINDS.includes(capability.kind)) errors.push(`site.capabilities[${index}].kind 必须是 ${EXTENSION_CAPABILITY_KINDS.join(" / ")}`);
          if (!isNonEmptyString(capability.description)) errors.push(`site.capabilities[${index}].description 必须是非空字符串`);
          if (capability.auth !== undefined && !EXTENSION_CAPABILITY_AUTH.includes(capability.auth)) {
            errors.push(`site.capabilities[${index}].auth 必须是 ${EXTENSION_CAPABILITY_AUTH.join(" / ")}`);
          }
        });
      }
      if (typeof site.defaultEnabled !== "boolean") errors.push("site.defaultEnabled 必须是布尔值");
      if (site.order !== undefined && !Number.isFinite(site.order)) errors.push("site.order 必须是数字");
      if (site.dependencies !== undefined && (!Array.isArray(site.dependencies) || !site.dependencies.every(isNonEmptyString))) {
        errors.push("site.dependencies 必须是字符串数组");
      }
    }
  }

  if (value.executors !== undefined) {
    const ids = new Set();
    if (!value.backend || value.hostPlugin) errors.push("executors requires a backend activation owner, without hostPlugin");
    if (!value.site) errors.push("executors requires site activation metadata");
    if (!Array.isArray(value.executors) || !value.executors.length) errors.push("executors must be a non-empty array");
    else for (const entry of value.executors) {
      if (!isPlainObject(entry)) { errors.push("executor must be an object"); continue; }
      for (const key of unknownKeys(entry, ["id", "module", "export"])) errors.push(`executor unknown field: ${key}`);
      if (!isNonEmptyString(entry.id) || !/^[a-z][a-z0-9-]*$/.test(entry.id) || ids.has(entry.id)) errors.push("executor id must be unique and kebab-case");
      ids.add(entry.id);
      if (!isNonEmptyString(entry.module) || !PACKAGE_SUBPATH.test(entry.module) || entry.module.split("/").includes("..")) errors.push("executor module must be a package subpath");
      if (!isNonEmptyString(entry.export) || !IDENTIFIER.test(entry.export)) errors.push("executor export must be an identifier");
    }
  }

  const backend = value.backend;
  if (backend !== undefined) {
    if (!isPlainObject(backend)) {
      errors.push("backend 必须是对象");
    } else {
      for (const key of unknownKeys(backend, ["module", "factory", "optionsType", "order", "optional"])) errors.push(`backend 未知字段：${key}`);
      const moduleValue = backend.module ?? "./backend";
      if (!isNonEmptyString(moduleValue) || !PACKAGE_SUBPATH.test(moduleValue)) {
        errors.push("backend.module 必须是包内相对子路径（如 ./backend）");
      }
      if (!isNonEmptyString(backend.factory) || !IDENTIFIER.test(backend.factory)) errors.push("backend.factory 必须是导出函数名");
      if (backend.optionsType !== undefined && (!isNonEmptyString(backend.optionsType) || !IDENTIFIER.test(backend.optionsType))) {
        errors.push("backend.optionsType 必须是导出的类型名");
      }
      if (backend.order !== undefined && !Number.isFinite(backend.order)) errors.push("backend.order 必须是数字");
      if (backend.optional !== undefined && typeof backend.optional !== "boolean") errors.push("backend.optional 必须是布尔值");
    }
  }

  /**
   * 扩展层 Cordis 插件声明：宿主按这里的位置与导出名加载并装配插件。
   *
   * 与 `backend` 的区别：`backend` 是站点插件宿主的**后端定义工厂**（`createDefinitions`），
   * `hostPlugin` 是插件树扩展层的 **Cordis 插件**（生成 Provider / 存储后端）。
   * 声明化之后，宿主不再维护逐插件的手写注册表（`host/extensions/providers.ts` 之类）。
   */
  const hostPlugin = value.hostPlugin;
  if (hostPlugin !== undefined) {
    if (!isPlainObject(hostPlugin)) {
      errors.push("hostPlugin 必须是对象");
    } else {
      for (const key of unknownKeys(hostPlugin, ["module", "factory", "features", "kind", "order", "optional"])) errors.push(`hostPlugin 未知字段：${key}`);
      const moduleValue = hostPlugin.module ?? "./backend";
      if (!isNonEmptyString(moduleValue) || !PACKAGE_SUBPATH.test(moduleValue)) {
        errors.push("hostPlugin.module 必须是包内相对子路径（如 ./backend）");
      }
      if (!isNonEmptyString(hostPlugin.factory) || !IDENTIFIER.test(hostPlugin.factory)) errors.push("hostPlugin.factory 必须是导出函数名");
      // ── deprecated-declaration：`hostPlugin.kind`（单值）已由 `hostPlugin.features` 取代 ──
      // 删除步骤：删这段、`EXTENSION_DEPRECATED_DECLARATIONS` 里的条目、对应的两条测试。
      if (hostPlugin.kind !== undefined) {
        const replacement = EXTENSION_DEPRECATED_DECLARATIONS["hostPlugin.kind"];
        if (hostPlugin.features !== undefined) {
          errors.push(`hostPlugin.kind 已废弃，不能与 ${replacement} 同时声明`);
        } else if (typeof hostPlugin.kind !== "string" || !EXTENSION_HOST_PLUGIN_FEATURES.includes(hostPlugin.kind)) {
          errors.push(`hostPlugin.kind 取值必须是 ${EXTENSION_HOST_PLUGIN_FEATURES.join(" / ")}（已废弃，改用 ${replacement}）`);
        } else {
          // 归一成新字段：下游只认 `features`，不再读 `kind`。
          value.hostPlugin = { ...hostPlugin, features: [hostPlugin.kind] };
          delete value.hostPlugin.kind;
          deprecations.push({ field: "hostPlugin.kind", replacement });
        }
      }
      const declaredFeatures = value.hostPlugin?.features ?? hostPlugin.features;
      // `features` 可省略（＝不提供具名功能面）或为数组；重复项视为声明错误。
      if (declaredFeatures !== undefined) {
        if (!Array.isArray(declaredFeatures)) {
          errors.push("hostPlugin.features 必须是数组");
        } else {
          const seen = new Set();
          for (const feature of declaredFeatures) {
            if (!EXTENSION_HOST_PLUGIN_FEATURES.includes(feature)) {
              errors.push(`hostPlugin.features 取值必须是 ${EXTENSION_HOST_PLUGIN_FEATURES.join(" / ")}`);
              continue;
            }
            if (seen.has(feature)) errors.push(`hostPlugin.features 重复：${feature}`);
            seen.add(feature);
          }
        }
      }
      if (hostPlugin.order !== undefined && !Number.isFinite(hostPlugin.order)) errors.push("hostPlugin.order 必须是数字");
      if (hostPlugin.optional !== undefined && typeof hostPlugin.optional !== "boolean") errors.push("hostPlugin.optional 必须是布尔值");
    }
  }

  /** 内容贡献声明：字段、wire、路由前缀、工具名与目标身份，供预检做格式和唯一性校验。 */
  const content = value.content;
  if (content !== undefined) {
    if (!isPlainObject(content)) {
      errors.push("content 必须是对象");
    } else {
      for (const key of unknownKeys(content, CONTENT_KEYS)) errors.push(`content 未知字段：${key}`);
      validateContentNames(content.ownedFields, "content.ownedFields", CONTENT_FIELD_NAME, errors);
      validateContentNames(content.ownedWireFields, "content.ownedWireFields", CONTENT_FIELD_NAME, errors);
      validateContentNames(content.mcpTools, "content.mcpTools", CONTENT_TOOL_NAME, errors);
      validateContentNames(content.targetModes, "content.targetModes", KEBAB_ID, errors);
      validateContentNames(content.eventOwners, "content.eventOwners", KEBAB_ID, errors);
      if (content.routePrefix !== undefined && (typeof content.routePrefix !== "string" || !CONTENT_ROUTE_PREFIX.test(content.routePrefix))) {
        errors.push("content.routePrefix 必须是相对 kebab 路径");
      }
    }
  }

  /**
   * 画布内容扩展声明（change: 2026-10-17-decouple-film-set-from-canvas-service）。
   *
   * 工厂返回 `ContentFrameRuntime`（预览帧/历史缩略图帧端口实现）。宿主在装配 canvas-service 时
   * 注入它；**canvas-service 不 import 任何扩展实现**。与 `hostPlugin` 的区别：后者是 Cordis 插件
   * （provider/storage 槽位），这里注入的是普通运行时对象，不参与插件树。
   */
  const canvasContent = value.canvasContent;
  if (canvasContent !== undefined) {
    if (!isPlainObject(canvasContent)) {
      errors.push("canvasContent 必须是对象");
    } else {
      for (const key of unknownKeys(canvasContent, ["module", "factory", "order"])) errors.push(`canvasContent 未知字段：${key}`);
      const moduleValue = canvasContent.module ?? "./backend";
      if (!isNonEmptyString(moduleValue) || !PACKAGE_SUBPATH.test(moduleValue)) {
        errors.push("canvasContent.module 必须是包内相对子路径（如 ./backend）");
      }
      if (!isNonEmptyString(canvasContent.factory) || !IDENTIFIER.test(canvasContent.factory)) errors.push("canvasContent.factory 必须是导出函数名");
      if (canvasContent.order !== undefined && !Number.isFinite(canvasContent.order)) errors.push("canvasContent.order 必须是数字");
    }
  }

  /**
   * 槽位实现声明（change: 2026-10-15-scan-bootstrap-slots-as-extension-directories，任务 2.1）。
   *
   * 只声明**包内模块 + 导出函数名**；被加载的工厂返回 `{ extensionId, providers }` 声明。
   * 声明模块是否为槽位实现、占哪个槽位，由宿主在启动期加载后校验（见 extension-host.mjs）。
   */
  const bootstrap = value.bootstrap;
  if (bootstrap !== undefined) {
    if (!isPlainObject(bootstrap)) {
      errors.push("bootstrap 必须是对象");
    } else {
      for (const key of unknownKeys(bootstrap, ["module", "export"])) errors.push(`bootstrap 未知字段：${key}`);
      const moduleValue = bootstrap.module ?? "./bootstrap";
      if (!isNonEmptyString(moduleValue) || !PACKAGE_SUBPATH.test(moduleValue)) {
        errors.push("bootstrap.module 必须是包内相对子路径（如 ./bootstrap）");
      }
      if (!isNonEmptyString(bootstrap.export) || !IDENTIFIER.test(bootstrap.export)) errors.push("bootstrap.export 必须是导出函数名");
    }
  }

  /**
   * 必需扩展：发布装配缺它的产物时在指针切换前失败。
   *
   * 由扩展自己声明（不再在 `scripts/assemble-release.mjs` 里写死 id 清单）：装配器按扫描结果汇总。
   */
  if (value.required !== undefined && typeof value.required !== "boolean") {
    errors.push("required 必须是布尔值");
  }

  /**
   * 图标声明，二选一：
   * - 品牌图形 `asset`：资产在**扩展包内**（`./assets/icon.png`），逻辑路径由约定派生
   *   `/plugin-icons/<extensionId><扩展名>`，宿主注入到后端插件卡片与浏览器 metadata；
   * - 语义图形 `glyph`：给没有浏览器前端的后端扩展（存储槽位、迁移工具等）用，值是
   *   `PLUGIN_ICON_NAMES` 里的名字；宿主只透传给插件清单，未知名字由前端回退通用图标。
   *
   * 两者都给时品牌图形优先。见 `scripts/lib/extension-icon-assets.mjs`。
   */
  const icon = value.icon;
  if (icon !== undefined) {
    if (!isPlainObject(icon)) {
      errors.push("icon 必须是对象");
    } else {
      for (const key of unknownKeys(icon, ["asset", "glyph"])) errors.push(`icon 未知字段：${key}`);
      if (icon.asset === undefined && icon.glyph === undefined) {
        errors.push("icon 必须至少声明 asset 或 glyph");
      }
      if (icon.asset !== undefined) {
        if (!isNonEmptyString(icon.asset) || !PACKAGE_SUBPATH.test(icon.asset)) {
          errors.push("icon.asset 必须是包内相对路径（如 ./assets/icon.png）");
        } else if (!IMAGE_EXTENSIONS.has(path.extname(icon.asset).toLowerCase())) {
          errors.push(`icon.asset 必须是图片文件（${[...IMAGE_EXTENSIONS].join(" / ")}）`);
        }
      }
      if (icon.glyph !== undefined && (!isNonEmptyString(icon.glyph) || !KEBAB_ID.test(icon.glyph))) {
        errors.push("icon.glyph 必须是非空 kebab-case 语义图标名（如 migration）");
      }
    }
  }

  const metadata = value.metadata;
  if (metadata !== undefined) {
    if (!isPlainObject(metadata)) {
      errors.push("metadata 必须是对象");
    } else {
      for (const key of unknownKeys(metadata, ["module", "export", "order"])) errors.push(`metadata 未知字段：${key}`);
      const moduleValue = metadata.module ?? "./shared";
      if (!isNonEmptyString(moduleValue) || !PACKAGE_SUBPATH.test(moduleValue)) {
        errors.push("metadata.module 必须是包内相对子路径（如 ./shared）");
      }
      if (!isNonEmptyString(metadata.export) || !IDENTIFIER.test(metadata.export)) errors.push("metadata.export 必须是导出常量名");
      if (metadata.order !== undefined && !Number.isFinite(metadata.order)) errors.push("metadata.order 必须是数字");
    }
  }

  const publicRoutes = value.publicRoutes;
  if (publicRoutes !== undefined) {
    if (!Array.isArray(publicRoutes)) {
      errors.push("publicRoutes 必须是数组");
    } else {
      publicRoutes.forEach((route, index) => {
        if (!isPlainObject(route)) {
          errors.push(`publicRoutes[${index}] 必须是对象`);
          return;
        }
        for (const key of unknownKeys(route, ["publicPath", "publicPathExport", "module", "route", "methods"])) {
          errors.push(`publicRoutes[${index}] 未知字段：${key}`);
        }
        const hasLiteral = route.publicPath !== undefined;
        const hasExport = route.publicPathExport !== undefined;
        if (hasLiteral === hasExport) errors.push(`publicRoutes[${index}] 必须且只能提供 publicPath 或 publicPathExport`);
        if (hasLiteral && (!isNonEmptyString(route.publicPath) || !route.publicPath.startsWith("/") || route.publicPath.startsWith("//"))) {
          errors.push(`publicRoutes[${index}].publicPath 必须是站内绝对路径（以单个 / 开头）`);
        }
        if (hasExport) {
          if (!isNonEmptyString(route.publicPathExport) || !IDENTIFIER.test(route.publicPathExport)) errors.push(`publicRoutes[${index}].publicPathExport 必须是导出常量名`);
          const moduleValue = route.module ?? "./shared";
          if (!isNonEmptyString(moduleValue) || !PACKAGE_SUBPATH.test(moduleValue)) errors.push(`publicRoutes[${index}].module 必须是包内相对子路径`);
        } else if (route.module !== undefined) {
          errors.push(`publicRoutes[${index}].module 只在 publicPathExport 时有效`);
        }
        if (!isNonEmptyString(route.route) || route.route.startsWith("/")) errors.push(`publicRoutes[${index}].route 必须是不带前导 / 的路由名`);
        // `route` 是公开路径下的**基路由**：宿主按请求子路径追加到它后面再匹配 handler。
        // 写成 `sdk-agent/*` 会得到 `sdk-agent/*/connections`，永远匹配不到已注册的 handler。
        else if (route.route.includes("*")) {
          errors.push(`publicRoutes[${index}].route 是公开路径下的基路由，不能含通配符 *（子路径由宿主追加）`);
        }
        if (!Array.isArray(route.methods) || route.methods.length === 0 || !route.methods.every((method) => EXTENSION_ROUTE_METHODS.includes(method))) {
          errors.push(`publicRoutes[${index}].methods 必须是 ${EXTENSION_ROUTE_METHODS.join("/")} 的子集且非空`);
        }
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value, deprecations };
}

/**
 * 读取并校验某个扩展目录的声明。
 *
 * - 无 `extension.json`：返回 null（纯浏览器扩展可以没有声明）。
 * - 声明非法或 extensionId 与扫描 identity 冲突：抛 `ExtensionScanError`。
 */
export function loadExtensionDescriptor(extension, { repoRoot } = {}) {
  const descriptorPath = extension.descriptorPath ?? path.join(extension.dir, EXTENSION_DESCRIPTOR_NAME);
  const relative = repoRoot ? path.relative(repoRoot, descriptorPath) : descriptorPath;
  if (!fs.existsSync(descriptorPath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  } catch (error) {
    throw new ExtensionScanError("EXTENSION_DESCRIPTOR_INVALID", `${relative} 不是合法 JSON：${error.message}`);
  }
  const validated = validateExtensionDescriptor(parsed);
  if (!validated.ok) {
    throw new ExtensionScanError("EXTENSION_DESCRIPTOR_INVALID", `${relative} 声明无效：\n  ${validated.errors.join("\n  ")}`);
  }
  // 归一后的声明不该带 `deprecations` 一起流动（它会让 JSON 比较与快照变化）；
  // 用不可枚举属性挂上去，装载器按需读取并告警。
  if (validated.deprecations.length > 0) {
    Object.defineProperty(validated.value, "deprecations", { value: validated.deprecations, enumerable: false });
  }
  if (validated.value.extensionId !== extension.extensionId) {
    throw new ExtensionScanError(
      "EXTENSION_DESCRIPTOR_IDENTITY_MISMATCH",
      `${relative} 的 extensionId（${validated.value.extensionId}）与扫描 identity（${extension.extensionId}）不一致`
    );
  }
  return validated.value;
}
