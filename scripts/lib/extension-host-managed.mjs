/**
 * 受管根 / 可写根的信任边界与受管扩展的 isolated 描述
 * （change: 2026-10-21-add-extension-marketplace-point 与 2026-10-21-isolate-extension-host-process）。
 *
 * 从 `extension-host.mjs` 拆出，行为不变；宿主主文件只在扫描循环里调用 `screenExtension`。
 */
import fs from "node:fs";
import path from "node:path";

import { EXTENSION_DESCRIPTOR_NAME } from "./extension-scan.mjs";
import { loadExtensionDescriptor } from "./extension-descriptor.mjs";
import { CONFIG_SCHEMA_RELATIVE, readConfigSchema, validateConfigSchema } from "./extension-config-schema.mjs";
import { extensionIconAssetFile, extensionIconPublicPath } from "./extension-icon-assets.mjs";
import { ExtensionLoadError, FALLBACK_ORDER, resolveModuleFile } from "./extension-host-modules.mjs";

/**
 * 受管根 / 可写根的信任边界（change: 2026-10-21-add-extension-marketplace-point，任务 2.2 / design D3、D4）。
 *
 * - 市场来源（`hostPlugin.kind = "marketplace-source"`）只能来自内置根：来源决定能拿到什么代码，
 *   市场装来的扩展若能再注册来源，信任链就会被被信任方自己延长。
 * - 受管扩展不得提供 `bootstrap` 槽位实现与 `canvasContent` 端口（与可写根拒绝 bootstrap 同一位置）。
 *
 * 返回第一条违规 `{ code, field, message }`，没有违规返回 null。只读 JSON 声明，不执行扩展代码；
 * 静态预检（`preflightDirectory`）复用同一函数，保证安装前与装配时口径一致。
 */
export function untrustedRootViolation(extension, descriptor) {
  const managed = extension.managed === true;
  const writable = extension.rootWritable === true;
  if (!descriptor || (!managed && !writable)) return null;
  const where = managed ? "受管扩展根（市场安装）" : "可写扩展根";
  if (descriptor.hostPlugin?.kind === "marketplace-source") {
    return {
      code: "EXTENSION_MARKETPLACE_SOURCE_UNTRUSTED_ROOT",
      field: "hostPlugin.kind",
      message: `${where}里的扩展不得提供市场来源：${extension.extensionId}（${extension.dir}）→ 市场来源只能放在内建根`
    };
  }
  if (managed && descriptor.bootstrap) {
    return {
      code: "EXTENSION_MANAGED_FORBIDDEN_DECLARATION",
      field: "bootstrap",
      message: `受管扩展不得声明槽位实现（bootstrap）：${extension.extensionId}（${extension.dir}）`
    };
  }
  if (managed && descriptor.hostPlugin?.kind === "storage") {
    return {
      code: "EXTENSION_MANAGED_FORBIDDEN_DECLARATION",
      field: "hostPlugin.kind",
      message: `受管扩展不得提供存储后端（hostPlugin.kind = storage）：${extension.extensionId}（${extension.dir}）→ 存储属基础能力，必须进程内且来自内建根`
    };
  }
  if (managed && descriptor.canvasContent) {
    return {
      code: "EXTENSION_MANAGED_FORBIDDEN_DECLARATION",
      field: "canvasContent",
      message: `受管扩展不得声明画布内容端口（canvasContent）：${extension.extensionId}（${extension.dir}）`
    };
  }
  return null;
}

/**
 * 只解析（不 import）声明里的全部包内模块与品牌图形，返回第一条错误 `{ code, message }` 或 null。
 * 供受管扩展在装配前隔离问题，也供安装预检复用。
 */
export function probeDeclaredModules(extension, descriptor) {
  const context = { extensionId: extension.extensionId, directory: extension.dir, descriptorPath: extension.descriptorPath ?? null };
  const subpaths = [];
  if (descriptor.backend) subpaths.push(descriptor.backend.module ?? "./backend");
  if (descriptor.hostPlugin) subpaths.push(descriptor.hostPlugin.module ?? "./backend");
  if (descriptor.canvasContent) subpaths.push(descriptor.canvasContent.module ?? "./backend");
  if (descriptor.metadata) subpaths.push(descriptor.metadata.module ?? "./shared");
  if (descriptor.bootstrap) subpaths.push(descriptor.bootstrap.module ?? "./bootstrap");
  for (const route of descriptor.publicRoutes ?? []) if (route.publicPathExport) subpaths.push(route.module ?? "./shared");
  for (const subpath of new Set(subpaths)) {
    try {
      resolveModuleFile(extension.dir, subpath, context);
    } catch (error) {
      return { code: error?.code ?? "EXTENSION_MODULE_INVALID", message: error?.message ?? String(error) };
    }
  }
  if (extensionIconPublicPath(descriptor, extension.extensionId)) {
    const assetFile = extensionIconAssetFile(extension.dir, descriptor);
    if (!assetFile || !fs.existsSync(assetFile)) {
      return { code: "EXTENSION_ICON_ASSET_MISSING", message: `扩展 ${extension.extensionId} 声明的品牌图形不存在：${String(descriptor.icon?.asset)}` };
    }
  }
  return null;
}

/**
 * 运行期为一个已提交到受管根的版本目录生成 isolated 描述（change: 2026-10-21-isolate-extension-host-process，任务 8.4）。
 *
 * 与启动扫描的 `isolatedDescriptorOf` 同形：只读 `extension.json` 与 `backend-dist/config-schema.json`、解析模块
 * 路径，**不 import 包内任何模块**。首次安装的受管后端扩展据此在运行期追加代理插件，不必重启。
 * 失败抛 `ExtensionLoadError`（code 同扫描期：`MARKETPLACE_PACKAGE_INVALID` / `EXTENSION_MANAGED_FORBIDDEN_DECLARATION` 等）。
 * 返回 `{ descriptor, metadata }`：`metadata` 是 config-schema 里的站点元数据（没有声明 metadata 时为 null）。
 */
export function describeIsolatedExtension({ dir, extensionId, version }) {
  const extension = { extensionId, dir, directory: `${extensionId}@${version}`, descriptorPath: path.join(dir, EXTENSION_DESCRIPTOR_NAME), managed: true, rootWritable: false, managedVersion: version };
  const descriptor = loadExtensionDescriptor(extension);
  if (!descriptor?.hostPlugin) {
    throw new ExtensionLoadError("EXTENSION_MODULE_INVALID", `受管扩展 ${extensionId} 没有声明 hostPlugin，不需要子进程`, { extensionId, directory: dir });
  }
  const violation = untrustedRootViolation(extension, descriptor);
  if (violation) throw new ExtensionLoadError(violation.code, violation.message, { extensionId, directory: dir, field: violation.field });
  const raw = readConfigSchema(dir);
  if (raw === null) throw new ExtensionLoadError("MARKETPLACE_PACKAGE_INVALID", `缺少 ${CONFIG_SCHEMA_RELATIVE}（旧包，请重新打包）`, { extensionId, directory: dir });
  const validated = validateConfigSchema(raw, { extensionId, descriptor });
  if (!validated.ok) throw new ExtensionLoadError("MARKETPLACE_PACKAGE_INVALID", `${CONFIG_SCHEMA_RELATIVE} 不合法：${validated.errors.join("；")}`, { extensionId, directory: dir });
  const problem = probeDeclaredModules({ ...extension, extensionId }, { ...descriptor, metadata: undefined, publicRoutes: undefined });
  if (problem) throw new ExtensionLoadError(problem.code, problem.message, { extensionId, directory: dir });
  const context = { extensionId, directory: dir, descriptorPath: extension.descriptorPath };
  const iconPath = extensionIconPublicPath(descriptor, extensionId);
  const registration = {
    extensionId,
    directory: dir,
    descriptor,
    managedVersion: version,
    hostPluginOrder: descriptor.hostPlugin.order ?? FALLBACK_ORDER,
    iconPath,
    hostPlugin: {
      module: resolveModuleFile(dir, descriptor.hostPlugin.module ?? "./backend", context),
      factory: descriptor.hostPlugin.factory,
      kind: descriptor.hostPlugin.kind,
      configSchema: validated.value
    }
  };
  const staticRoutes = (descriptor.publicRoutes ?? []).map((route) => ({ ...route, ...(route.publicPathExport ? { staticPublicPath: validated.value.publicPaths?.[route.publicPathExport] } : {}) }));
  registration.descriptor = { ...descriptor, publicRoutes: staticRoutes };
  return {
    descriptor: isolatedDescriptorOf(registration),
    metadata: validated.value.metadata ? { ...validated.value.metadata.value, directory: dir } : null
  };
}

/**
 * 受管扩展的 isolated 描述（change: 2026-10-21-isolate-extension-host-process，任务 6.2 / design D1）。
 * 纯数据，可序列化：宿主据此构造代理插件，子进程据 `entry` + `factory` 加载真实插件。
 */
export function isolatedDescriptorOf(registration) {
  const schema = registration.hostPlugin.configSchema;
  return Object.freeze({
    isolated: true,
    extensionId: registration.extensionId,
    version: registration.managedVersion,
    directory: registration.directory,
    entry: registration.hostPlugin.module,
    factory: registration.hostPlugin.factory,
    kind: registration.hostPlugin.kind,
    order: registration.hostPluginOrder,
    permissions: registration.descriptor.permissions ?? {},
    publicRoutes: (registration.descriptor.publicRoutes ?? []).map((route) => route.publicPath ?? route.staticPublicPath).filter(Boolean),
    plugin: schema.plugin,
    ...(registration.iconPath ? { icon: registration.iconPath } : {}),
    origin: Object.freeze({ managed: true, rootWritable: false })
  });
}

/**
 * 受管扩展后端是否走 Extension Host 子进程（change: 2026-10-21-isolate-extension-host-process，D1）。
 * 缺省开启；本机设置 `extensions.host.isolation = false` 由调用方传入 `isolation: false`，
 * 或部署侧用环境变量 `WOOHAA3_EXTENSION_HOST_ISOLATION=0` 关闭（排障降级开关）。
 */
export function resolveIsolation({ isolation, env } = {}) {
  if (typeof isolation === "boolean") return isolation;
  const raw = env?.WOOHAA3_EXTENSION_HOST_ISOLATION;
  if (typeof raw === "string" && /^(0|false|off|no)$/i.test(raw.trim())) return false;
  return true;
}

/**
 * 扫描循环里对单个扩展的信任边界与受管声明检查（原先内联在 `loadExtensionHost` 里）。
 *
 * 返回 `null` 表示该扩展已被拒绝（已记入 `rejected` 并写日志），调用方跳过它；否则返回
 * `{ descriptor, isolated, configSchema }`。内置根 / 可写根的违规仍抛 `ExtensionLoadError`（fail-fast）。
 */
export function screenExtension({ extension, repoRoot, isolate, rejected, logger }) {
  let descriptor;
  try {
    descriptor = loadExtensionDescriptor(extension, { repoRoot });
  } catch (error) {
    if (extension.managed !== true) throw error;
    rejected.push({ extensionId: extension.extensionId, directory: extension.dir, code: error?.code ?? "EXTENSION_DESCRIPTOR_INVALID", message: error?.message ?? String(error) });
    logger({ event: "extension-managed-rejected", extensionId: extension.extensionId, directory: extension.dir, code: error?.code, message: error?.message });
    return null;
  }
  const violation = untrustedRootViolation(extension, descriptor);
  if (violation) {
    // 可写根是运维直接放目录的位置：与 EXTENSION_SLOT_WRITABLE_ROOT 一致 fail-fast。
    // 受管根是市场安装的位置：只拒绝该扩展并记录错误码（受管扩展是可选插件）。
    if (extension.managed !== true) {
      throw new ExtensionLoadError(violation.code, violation.message, { extensionId: extension.extensionId, directory: extension.dir, root: extension.root, field: violation.field });
    }
    rejected.push({ extensionId: extension.extensionId, directory: extension.dir, code: violation.code, field: violation.field, message: violation.message });
    logger({ event: "extension-managed-rejected", extensionId: extension.extensionId, directory: extension.dir, code: violation.code, field: violation.field, message: violation.message });
    return null;
  }
  if (extension.managed === true && descriptor) {
    // 受管扩展的模块缺失/越界只拒绝它自己（内置扩展仍 fail-fast，见下方 resolveModuleFile）。
    const problem = probeDeclaredModules(extension, descriptor);
    if (problem) {
      rejected.push({ extensionId: extension.extensionId, directory: extension.dir, code: problem.code, message: problem.message });
      logger({ event: "extension-managed-rejected", extensionId: extension.extensionId, directory: extension.dir, code: problem.code, message: problem.message });
      return null;
    }
  }
  /**
   * 受管根的 hostPlugin 在隔离开启时不进宿主进程（D1）：读包内静态描述 config-schema.json，
   * 缺失或不合法的旧包只拒绝该扩展（MARKETPLACE_PACKAGE_INVALID，提示重新打包）。
   */
  let configSchema = null;
  const isolated = isolate && extension.managed === true && Boolean(descriptor?.hostPlugin);
  if (isolated) {
    let problem = null;
    try {
      const raw = readConfigSchema(extension.dir);
      if (raw === null) problem = `缺少 ${CONFIG_SCHEMA_RELATIVE}（旧包，请用新版 pack:extension 重新打包安装）`;
      else {
        const validated = validateConfigSchema(raw, { extensionId: extension.extensionId, descriptor });
        if (validated.ok) configSchema = validated.value;
        else problem = `${CONFIG_SCHEMA_RELATIVE} 不合法：${validated.errors.join("；")}`;
      }
    } catch (error) {
      problem = `${CONFIG_SCHEMA_RELATIVE} 不是合法 JSON：${error?.message ?? String(error)}`;
    }
    if (problem) {
      rejected.push({ extensionId: extension.extensionId, directory: extension.dir, code: "MARKETPLACE_PACKAGE_INVALID", message: problem });
      logger({ event: "extension-managed-rejected", extensionId: extension.extensionId, directory: extension.dir, code: "MARKETPLACE_PACKAGE_INVALID", message: problem });
      return null;
    }
  }
  return { descriptor, isolated, configSchema };
}

/** 插件对象的来源章：宿主 `ctx.marketplace.register` 据此做运行期来源断言（design D3 纵深防御）。 */
export function hostPluginOrigin(registration) {
  return Object.freeze({ managed: registration.managed === true, rootWritable: registration.rootWritable === true });
}
