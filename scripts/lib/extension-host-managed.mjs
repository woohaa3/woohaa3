/**
 * 受管根 / 可写根的信任边界（change: 2026-10-21-add-extension-marketplace-point）。
 *
 * 从 `extension-host.mjs` 拆出，行为不变；宿主主文件只在扫描循环里调用 `screenExtension`。
 * C 方向取消进程隔离后，这里只剩声明层的信任检查——「市场来源只能来自内置根」、
 * 「受管扩展不得声明 bootstrap / storage / canvasContent」与模块越界探测。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { EXTENSION_DESCRIPTOR_NAME } from "./extension-scan.mjs";
import { loadExtensionDescriptor } from "./extension-descriptor.mjs";
import { extensionIconAssetFile, extensionIconPublicPath } from "./extension-icon-assets.mjs";
import { ExtensionLoadError, FALLBACK_ORDER, resolveModuleFile } from "./extension-host-modules.mjs";

/**
 * 运行期从一个已提交到受管根的版本目录加载**真实**扩展层插件（热切换用）。
 *
 * 与启动期扫描走同一套声明校验（`untrustedRootViolation` / `probeDeclaredModules`），区别只是
 * 目录是运行期才知道的。返回可直接交给 `ExtensionLayer.add` 的插件对象；插件名必须等于扩展 identity。
 *
 * 不同版本位于 `installed/<id>/<version>/`，因此 `import()` 的 URL 天然不同，不会命中 ESM 模块缓存——
 * 这正是进程内换版可行的原因。同一版本重装会命中缓存，等于复用同一模块实例，符合预期。
 */
export async function loadRuntimePlugin({ dir, extensionId, version }) {
  const extension = {
    extensionId,
    dir,
    directory: `${extensionId}@${version}`,
    descriptorPath: path.join(dir, EXTENSION_DESCRIPTOR_NAME),
    managed: true,
    rootWritable: false
  };
  const descriptor = loadExtensionDescriptor(extension);
  if (!descriptor?.hostPlugin) {
    throw new ExtensionLoadError("EXTENSION_MODULE_INVALID", `扩展 ${extensionId} 没有声明 hostPlugin，无法作为后端插件装配`, { extensionId, directory: dir });
  }
  const violation = untrustedRootViolation(extension, descriptor);
  if (violation) throw new ExtensionLoadError(violation.code, violation.message, { extensionId, directory: dir, field: violation.field });
  const problem = probeDeclaredModules(extension, descriptor);
  if (problem) throw new ExtensionLoadError(problem.code, problem.message, { extensionId, directory: dir });

  const context = { extensionId, directory: dir, descriptorPath: extension.descriptorPath };
  const modulePath = resolveModuleFile(dir, descriptor.hostPlugin.module ?? "./backend", context);
  const module = await import(pathToFileURL(modulePath).href);
  const factory = module[descriptor.hostPlugin.factory];
  if (typeof factory !== "function") {
    throw new ExtensionLoadError("EXTENSION_EXPORT_INVALID", `扩展 ${extensionId} 的 hostPlugin 工厂导出不是函数：${descriptor.hostPlugin.factory}`, { extensionId, directory: dir, export: descriptor.hostPlugin.factory });
  }
  const plugin = factory({});
  if (!plugin || typeof plugin.apply !== "function" || typeof plugin.configPrefix !== "string") {
    throw new ExtensionLoadError("EXTENSION_EXPORT_INVALID", `扩展 ${extensionId} 的 hostPlugin 工厂返回值不是扩展层插件（需要 name/configPrefix/apply）`, { extensionId, directory: dir });
  }
  if (plugin.name !== extensionId) {
    throw new ExtensionLoadError("EXTENSION_IDENTITY_MISMATCH", `插件名与扩展 identity 不一致：${plugin.name} ≠ ${extensionId}`, { extensionId, directory: dir });
  }
  return {
    plugin: {
      ...plugin,
      directory: dir,
      origin: Object.freeze({ managed: true, rootWritable: false })
    },
    descriptor
  };
}

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
 * 受管扩展后端是否走 Extension Host 子进程（change: 2026-10-21-isolate-extension-host-process，D1）。
 *
 * **C 方向已取消进程隔离**：受管根的后端插件与内置根一样进宿主进程，这里恒返回 false。
 * 保留函数签名是为了不改动调用方；声明层的信任检查（`untrustedRootViolation`、
 * `probeDeclaredModules`）与它无关，仍然生效。
 */
export function resolveIsolation() {
  return false;
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
  // C 方向取消了进程隔离：受管根的后端插件与内置根一样被 import，不再需要从
  // config-schema.json 静态描述配置段（那份产物只是打包期的历史遗留）。
  return { descriptor };
}

/** 插件对象的来源章：宿主 `ctx.marketplace.register` 据此做运行期来源断言（design D3 纵深防御）。 */
export function hostPluginOrigin(registration) {
  return Object.freeze({ managed: registration.managed === true, rootWritable: registration.rootWritable === true });
}
