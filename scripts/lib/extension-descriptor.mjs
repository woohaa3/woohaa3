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
export const EXTENSION_DESCRIPTOR_TOP_LEVEL_KEYS = ["schemaVersion", "extensionId", "site", "backend", "bootstrap", "metadata", "publicRoutes", "hostPlugin", "canvasContent", "icon", "required"];
export const EXTENSION_CAPABILITY_KINDS = ["capability", "handler"];
export const EXTENSION_CAPABILITY_AUTH = ["public", "authenticated"];
export const EXTENSION_ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
/**
 * 扩展层 Cordis 插件的种类（`hostPlugin.kind`）。
 *
 * `provider` 注入 `ctx.generation`（模型 Provider），`storage` 注入 `ctx.storage`（存储后端）。
 * 两者都是宿主插件树扩展层的插件，由声明驱动装配——宿主不再维护逐插件的手写注册表。
 */
export const EXTENSION_HOST_PLUGIN_KINDS = ["provider", "storage"];

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const KEBAB_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
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

/**
 * 校验一份声明。
 *
 * 返回 `{ ok: true, value }` 或 `{ ok: false, errors: string[] }`；错误信息面向作者，指出字段与原因。
 */
export function validateExtensionDescriptor(value) {
  const errors = [];
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
      for (const key of unknownKeys(hostPlugin, ["module", "factory", "kind", "order", "optional"])) errors.push(`hostPlugin 未知字段：${key}`);
      const moduleValue = hostPlugin.module ?? "./backend";
      if (!isNonEmptyString(moduleValue) || !PACKAGE_SUBPATH.test(moduleValue)) {
        errors.push("hostPlugin.module 必须是包内相对子路径（如 ./backend）");
      }
      if (!isNonEmptyString(hostPlugin.factory) || !IDENTIFIER.test(hostPlugin.factory)) errors.push("hostPlugin.factory 必须是导出函数名");
      if (!EXTENSION_HOST_PLUGIN_KINDS.includes(hostPlugin.kind)) {
        errors.push(`hostPlugin.kind 必须是 ${EXTENSION_HOST_PLUGIN_KINDS.join(" / ")}`);
      }
      if (hostPlugin.order !== undefined && !Number.isFinite(hostPlugin.order)) errors.push("hostPlugin.order 必须是数字");
      if (hostPlugin.optional !== undefined && typeof hostPlugin.optional !== "boolean") errors.push("hostPlugin.optional 必须是布尔值");
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
  return { ok: true, value };
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
  if (validated.value.extensionId !== extension.extensionId) {
    throw new ExtensionScanError(
      "EXTENSION_DESCRIPTOR_IDENTITY_MISMATCH",
      `${relative} 的 extensionId（${validated.value.extensionId}）与扫描 identity（${extension.extensionId}）不一致`
    );
  }
  return validated.value;
}
