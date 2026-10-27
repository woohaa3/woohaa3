/**
 * 启动期扩展宿主
 * （change: 2026-10-15-add-scannable-extension-directories，任务 3.1–3.4 / design D1–D3、D5）。
 *
 * 取代原先的构建期生成器：服务启动时扫描配置根 → 校验每个扩展的 `extension.json` 声明 →
 * 把声明里的包内相对子路径解析成扩展目录内的实际文件 → 动态 `import` → 取具名导出并断言
 * 形状与 identity → 组装后端清单、站点目录与公开路由。
 *
 * 安全边界（design D3）：
 * - 只接受声明里的**包内相对子路径**（正则已限制为 `./x/y`）；解析结果必须落在扩展目录内
 *   （绝对路径与 realpath 双重前缀断言），拒绝 `..` 逃逸与软链逃逸。
 * - 不接受 URL、绝对路径、脚本地址或远程地址；`eval`/`new Function` 不作为加载手段。
 * - 声明非法、跨根重复 identity、导出缺失或类型不符、工厂 identity 不符 → 抛出 `ExtensionLoadError`，
 *   由调用方在启动时 fail-fast，不进入部分注册状态。
 *
 * 本模块只读文件系统与 JSON，并 `import` 声明指向的包内相对模块；不依赖 pnpm 语义。
 */
import fs from "node:fs";
import { createExtensionDirectoryControl } from "./extension-directory-control.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  EXTENSION_DESCRIPTOR_NAME,
  checkRootsCoveredByWorkspace,
  formatWorkspaceCoverageHint,
  scanExtensions
} from "./extension-scan.mjs";
import { loadExtensionDescriptor } from "./extension-descriptor.mjs";
import { extensionIconAssetFile, extensionIconPublicPath } from "./extension-icon-assets.mjs";
import { ExtensionLoadError, FALLBACK_ORDER, hasBrowserArtifact, resolveModuleFile } from "./extension-host-modules.mjs";
import { isSafeModeEssential, suspendedRegistration } from "./extension-host-safe-mode.mjs";
import { hostPluginOrigin, resolveIsolation, screenExtension } from "./extension-host-managed.mjs";
import { createReleaseFacade } from "./extension-host-release.mjs";
// 分支未搬 `extension-release.mjs`（release 布局校验依赖部署模块）；这里直接用协议模块。
import { loadExtensionContracts } from "./extension-release-protocol.mjs";

// 拆出的模块（行为不变）：调用方继续从本文件导入这些名字。
export { ExtensionLoadError, FALLBACK_ORDER, hasBrowserArtifact, resolveModuleFile } from "./extension-host-modules.mjs";
export { isSafeModeEssential } from "./extension-host-safe-mode.mjs";
export { probeDeclaredModules, resolveIsolation, untrustedRootViolation } from "./extension-host-managed.mjs";

/**
 * 基础槽位名单（与 `@woohaa3/application-service` 的 `FOUNDATION_SLOTS` 同口径）。
 *
 * 只读脚本（静态预检、release 装配）需要同一份名单，避免三处各写一遍。
 */
const slotContracts = await loadExtensionContracts();
export const FOUNDATION_SLOT_NAMES = slotContracts.FOUNDATION_SLOTS;
export const requiredFoundationSlots = slotContracts.requiredFoundationSlots;

function isInside(parent, candidate) {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

/**
 * 调用槽位声明工厂（change: 2026-10-15-scan-bootstrap-slots-as-extension-directories，任务 4.3）。
 *
 * 工厂自身抛错（例如缺存储路径/连接串）时补上扩展目录与稳定错误码：
 * 启动日志必须能直接定位到「哪个扩展目录没配全」。
 */
async function callSlotFactory(entry, factory, input) {
  try {
    return await factory(input);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const wrapped = new ExtensionLoadError(
      "EXTENSION_BOOTSTRAP_FACTORY_FAILED",
      `扩展 ${entry.extensionId} 的槽位声明工厂失败（目录 ${entry.directory}）：${reason}`,
      { extensionId: entry.extensionId, directory: entry.directory, reason }
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

/**
 * 槽位图校验（change: 2026-10-15-scan-bootstrap-slots-as-extension-directories，任务 2.3）。
 *
 * 三类非法声明在这里给出稳定错误码与目录：
 * - 同一槽位有两个启用实现（`EXTENSION_SLOT_DUPLICATE`）；
 * - `requires` 指向未知槽位（`EXTENSION_REQUIRES_UNKNOWN`）；
 * - `requires` 成环（`EXTENSION_REQUIRES_CYCLE`）。
 *
 * 「依赖缺失」与「每槽位恰好一个」在 `bootstrapProviders` 里再来一遍（纵深防御，design D5）。
 * `sources` 是 `{ declaration, directory }` 列表，目录用于让启动日志直接指向该改哪个目录。
 *
 * `requireFoundationCoverage` 缺省为真（启动期 fail-fast）。只读静态预检可以传 `false`：
 * 分支可能暂时没有任何槽位实现扩展目录，此时「缺必需槽位」是部署姿态而不是布局错误；
 * 重复实现、未知依赖、依赖成环、依赖缺失仍然报错（见 `scripts/extensions-preflight.mjs`）。
 */
function assertSlotGraph(sources, { requireFoundationCoverage = true } = {}) {
  const ownerBySlot = new Map();
  for (const { declaration, directory } of sources) {
    for (const provider of declaration.providers) {
      const previous = ownerBySlot.get(provider.slot);
      if (previous) {
        throw new ExtensionLoadError(
          "EXTENSION_SLOT_DUPLICATE",
          `槽位 ${provider.slot} 有两个启用实现：${previous.directory} 与 ${directory}（停用其中一个目录，加 '.' 前缀后重启）`,
          { slot: provider.slot, owners: [previous.directory, directory] }
        );
      }
      for (const requirement of provider.requires) {
        if (!FOUNDATION_SLOT_NAMES.includes(requirement)) {
          throw new ExtensionLoadError(
            "EXTENSION_REQUIRES_UNKNOWN",
            `扩展 ${declaration.extensionId} 的槽位 ${provider.slot} 依赖未知槽位：${String(requirement)}（目录 ${directory}）`,
            { extensionId: declaration.extensionId, directory, slot: provider.slot, requires: requirement }
          );
        }
      }
      ownerBySlot.set(provider.slot, { extensionId: declaration.extensionId, directory, requires: provider.requires });
    }
  }

  const state = new Map();
  const visit = (slot, trail) => {
    const current = state.get(slot);
    if (current === "done") return;
    const owner = ownerBySlot.get(slot);
    if (current === "visiting") {
      const cycle = [...trail.slice(trail.indexOf(slot)), slot];
      throw new ExtensionLoadError(
        "EXTENSION_REQUIRES_CYCLE",
        `provider 依赖循环：${cycle.join(" → ")}（目录 ${owner?.directory}）`,
        { slot, cycle, directory: owner?.directory }
      );
    }
    state.set(slot, "visiting");
    const nextTrail = [...trail, slot];
    for (const requirement of owner?.requires ?? []) {
      if (!ownerBySlot.has(requirement)) throw new ExtensionLoadError(
        "EXTENSION_REQUIRES_MISSING", `槽位 ${slot} 缺少依赖 ${requirement}（目录 ${owner?.directory}）`,
        { slot, requires: requirement, directory: owner?.directory }
      );
      visit(requirement, nextTrail);
    }
    state.set(slot, "done");
  };
  for (const slot of ownerBySlot.keys()) visit(slot, []);
  // 零实现也必须检查必需槽位：`ownerBySlot.size` 非空才检查会让「一个槽位实现都没有」的部署
  // 静默通过（无存储、无身份地启动），与「缺陷：必需槽位缺失时 fail-fast」的承诺相反。
  if (requireFoundationCoverage) {
    for (const slot of requiredFoundationSlots([...ownerBySlot.keys()])) {
      if (!ownerBySlot.has(slot)) throw new ExtensionLoadError(
        "EXTENSION_SLOT_MISSING", `缺少必需槽位 ${slot}（已声明：${[...ownerBySlot.keys()].join("、")}）`, { slot }
      );
    }
  }
}


/** 站点目录条目（`ApplicationExtensionTrustedEntry` 形状；由 contracts 校验器复核）。 */
function siteEntryOf(extension, descriptor, { hasBrowser }) {
  const site = descriptor.site;
  return {
    extensionId: extension.extensionId,
    name: site.name,
    description: site.description,
    directory: extension.directory,
    version: site.version,
    managementScope: "site",
    host: "backend",
    configSchema: site.configSchema,
    dependencies: site.dependencies ?? [],
    capabilities: site.capabilities,
    frontendEntry: hasBrowser,
    backendHosts: ["backend"],
    configScope: "site",
    defaultEnabled: site.defaultEnabled
  };
}

function compareByOrder(orderOf, identityOf) {
  return (a, b) => {
    const orderA = orderOf(a);
    const orderB = orderOf(b);
    if (orderA !== orderB) return orderA - orderB;
    const idA = identityOf(a);
    const idB = identityOf(b);
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  };
}

async function importModule(absolute, { extensionId, directory, subpath, descriptorPath }) {
  try {
    return await import(pathToFileURL(absolute).href);
  } catch (error) {
    throw new ExtensionLoadError(
      "EXTENSION_MODULE_LOAD_FAILED",
      `扩展 ${extensionId} 的模块加载失败（${path.relative(process.cwd(), absolute)}）：${error instanceof Error ? error.message : String(error)}`,
      { extensionId, directory, subpath, descriptorPath }
    );
  }
}

/** 结构化启动日志条目（不含秘密；只含身份、目录、模块与原因）。 */
export function hostSummary(host) {
  return {
    event: "extension-host-loaded",
    roots: host.roots.map((root) => path.relative(host.repoRoot, root) || "."),
    rootsSource: host.source,
    loaded: host.registrations.map((registration) => ({
      extensionId: registration.extensionId,
      directory: path.relative(host.repoRoot, registration.directory) || registration.directory,
      modules: registration.modules.map((module) => path.relative(registration.directory, module)),
      backend: registration.backend !== null,
      hostPlugin: registration.hostPlugin ? { kind: registration.hostPlugin.kind, factory: registration.hostPlugin.factory } : null,
      canvasContent: registration.canvasContent ? { factory: registration.canvasContent.factory } : null,
      site: registration.site,
      metadata: registration.metadataExport,
      order: registration.order
    })),
    browserArtifacts: host.browserArtifacts.map((artifact) => artifact.extensionId),
    browserRelease: {
      releaseId: host.browserRelease.releaseId,
      href: host.browserRelease.href,
      entries: host.browserRelease.entries.map((entry) => ({ extensionId: entry.metadata.extensionId, artifactId: entry.artifactId })),
      skipped: host.browserRelease.skipped.map((entry) => entry.extensionId)
    },
    disabled: host.disabled.map((entry) => entry.directory),
    skipped: host.skipped.map((entry) => `${entry.directory}（${entry.reason}）`),
    undeclared: host.undeclared.map((entry) => entry.directory),
    slots: (host.slotEntries ?? []).map((entry) => ({
      extensionId: entry.extensionId,
      directory: path.relative(host.repoRoot, entry.directory) || entry.directory,
      root: path.relative(host.repoRoot, entry.root) || entry.root,
      rootWritable: entry.rootWritable,
      module: path.relative(entry.directory, entry.module),
      export: entry.export
    }))
  };
}

/**
 * 从一组扩展目录收集槽位声明（不构建发布目录、不装配 provider）。
 *
 * 供 release 装配断言使用（change: 2026-10-15-scan-bootstrap-slots-as-extension-directories，
 * 任务 6.2）：装配进 release 的扩展集必须恰好覆盖 storage / identity / access。
 * 返回 `{ declarations, owners }`，`owners` 是 `slot → extensionId[]`。
 */
export async function collectSlotDeclarations({ directories, env = process.env, optionsByExtensionId = {} }) {
  const declarations = [];
  const sources = [];
  const owners = new Map();
  for (const dir of directories) {
    const extensionId = path.basename(dir);
    const descriptorPath = path.join(dir, EXTENSION_DESCRIPTOR_NAME);
    if (!fs.existsSync(descriptorPath)) continue;
    const descriptor = loadExtensionDescriptor({ extensionId, dir, descriptorPath });
    if (!descriptor?.bootstrap) continue;
    const moduleFile = resolveModuleFile(dir, descriptor.bootstrap.module ?? "./bootstrap", { extensionId, descriptorPath });
    const module = await importModule(moduleFile, {
      extensionId,
      directory: dir,
      subpath: descriptor.bootstrap.export,
      descriptorPath
    });
    const factory = module[descriptor.bootstrap.export];
    if (typeof factory !== "function") {
      throw new ExtensionLoadError(
        "EXTENSION_EXPORT_MISSING",
        `扩展 ${extensionId} 的槽位声明工厂导出缺失或不是函数：${descriptor.bootstrap.export}（目录 ${dir}）`,
        { extensionId, directory: dir, export: descriptor.bootstrap.export }
      );
    }
    const entry = { extensionId, directory: dir, export: descriptor.bootstrap.export };
    const declaration = await callSlotFactory(entry, factory, { env, extensionIds: directories.map(dir => path.basename(dir)), directory: dir, options: optionsByExtensionId[extensionId] });
    declarations.push(declaration);
    sources.push({ declaration, directory: dir });
    for (const provider of declaration.providers) {
      const list = owners.get(provider.slot) ?? [];
      list.push(extensionId);
      owners.set(provider.slot, list);
    }
  }
  assertSlotGraph(sources);
  return { declarations, owners };
}

/**
 * 扫描配置根并加载扩展声明与模块。
 *
 * 返回的宿主对象是后端与 HTTP 入口共用的一次启动期结果：
 * - `createDefinitions(optionsByExtensionId)`：宿主注入依赖后构造后端定义；
 * - `slotEntries` / `createSlotDeclarations(optionsByExtensionId)`：已启用扩展的槽位实现声明；
 * - `metadata`：provider metadata + 站点目录条目（供 Application 注入）；
 * - `publicRoutes`：固定公开路径映射；
 * - `siteExtensionIds`：站点控制面 scope 的 extensionId 集合；
 * - `browserArtifacts`：已构建 browser 产物（供发布目录生成与托管）；
 * - `browserRelease` / `handleReleaseRequest`：运行期发布目录与它的 HTTP 托管。
 */
export async function loadExtensionHost({ repoRoot, env = process.env, configFile, logger = () => undefined, contracts = null, safeMode = false, isolation } = {}) {
  const isolate = resolveIsolation({ isolation, env });
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    throw new ExtensionLoadError("EXTENSION_REPO_ROOT_MISSING", "缺少 repoRoot");
  }
  const scan = scanExtensions({ repoRoot, env, ...(configFile ? { configFile } : {}) });
  const coverage = checkRootsCoveredByWorkspace({ repoRoot, roots: scan.roots });
  const hint = formatWorkspaceCoverageHint(coverage, { repoRoot });
  if (hint) logger({ event: "extension-roots-uncovered", message: hint });

  const resolvedContracts = contracts ?? (await loadExtensionContracts());

  const registrations = [];
  const undeclared = [];
  const browserArtifacts = [];
  const slotEntries = [];
  /** 安全模式下暂停的扩展（change: 2026-10-21-harden-extension-fault-isolation，D7）。 */
  const suspended = [];
  /**
   * 因信任边界或声明问题未装配的受管扩展（change: 2026-10-21-add-extension-marketplace-point）。
   * 受管扩展是可选插件：单个受管扩展的问题只拒绝它自己，其他扩展照常装配。
   */
  const rejected = [];
  for (const warning of scan.warnings ?? []) logger({ event: "extension-managed-skipped", ...warning });
  for (const extension of scan.extensions) {
    const screened = screenExtension({ extension, repoRoot, isolate, rejected, logger });
    if (!screened) continue;
    const { descriptor } = screened;
    if (safeMode && !isSafeModeEssential(extension, descriptor)) {
      // 不导入任何扩展模块、不发布浏览器产物；只保留纯 JSON 的站点目录条目，供控制面投影 suspended。
      suspended.push({ extensionId: extension.extensionId, directory: extension.dir, rootWritable: extension.rootWritable === true });
      if (descriptor?.site) registrations.push(suspendedRegistration(extension, descriptor));
      continue;
    }
    if (hasBrowserArtifact(extension.dir)) {
      browserArtifacts.push({ extensionId: extension.extensionId, directory: extension.dir });
    }
    if (!descriptor) {
      undeclared.push({ extensionId: extension.extensionId, directory: extension.dir });
      continue;
    }
    const context = { extensionId: extension.extensionId, directory: extension.dir, descriptorPath: extension.descriptorPath };
    const backend = descriptor.backend
      ? {
          module: resolveModuleFile(extension.dir, descriptor.backend.module ?? "./backend", context),
          factory: descriptor.backend.factory,
          optionsType: descriptor.backend.optionsType ?? null,
          optional: descriptor.backend.optional === true
        }
      : null;
    const metadata = descriptor.metadata
      ? {
          module: resolveModuleFile(extension.dir, descriptor.metadata.module ?? "./shared", context),
          exportName: descriptor.metadata.export
        }
      : null;
    const publicRoutes = (descriptor.publicRoutes ?? []).map((route) => ({
      ...route,
      module: route.publicPathExport ? resolveModuleFile(extension.dir, route.module ?? "./shared", context) : null
    }));

    /**
     * 扩展层 Cordis 插件声明（Provider / 存储后端）。
     *
     * 宿主按声明加载并装配插件，不再维护 `web/backend/src/host/extensions/*.ts` 里逐插件的手写
     * 注册表：新增一个 Provider 或存储后端只改扩展目录里的 `extension.json` 与实现。
     */
    const hostPlugin = descriptor.hostPlugin
      ? {
          module: resolveModuleFile(extension.dir, descriptor.hostPlugin.module ?? "./backend", context),
          factory: descriptor.hostPlugin.factory,
          kind: descriptor.hostPlugin.kind,
          optional: descriptor.hostPlugin.optional === true
          // 只解析出入口路径；真正的 import 由扩展层装载器完成。
        }
      : null;

    /**
     * 画布内容扩展（change: 2026-10-17-decouple-film-set-from-canvas-service）：工厂返回
     * `ContentFrameRuntime`，由核心层在装配 canvas-service 时注入（不参与插件树）。
     */
    const canvasContent = descriptor.canvasContent
      ? {
          module: resolveModuleFile(extension.dir, descriptor.canvasContent.module ?? "./backend", context),
          factory: descriptor.canvasContent.factory,
          order: descriptor.canvasContent.order ?? FALLBACK_ORDER
        }
      : null;

    /**
     * 槽位实现声明（change: 2026-10-15-scan-bootstrap-slots-as-extension-directories，任务 2.2 / design D2、D5）。
     *
     * 只解析模块位置与导出名，工厂在 `createSlotDeclarations` 里调用（需要核心注入的部署选项）。
     * 可写根里的槽位实现声明一律拒绝：否则「往可写目录丢一个文件夹」就等于接管身份或权限。
     */
    const bootstrap = descriptor.bootstrap
      ? {
          module: resolveModuleFile(extension.dir, descriptor.bootstrap.module ?? "./bootstrap", context),
          export: descriptor.bootstrap.export,
          descriptor: descriptor.bootstrap
        }
      : null;
    if (bootstrap && extension.rootWritable === true) {
      throw new ExtensionLoadError(
        "EXTENSION_SLOT_WRITABLE_ROOT",
        `可写扩展根里的扩展不得声明槽位实现：${extension.directory}（根 ${extension.root}）→ 请把 ${extension.extensionId} 放进内建根，或移除 bootstrap 声明`,
        { extensionId: extension.extensionId, directory: extension.dir, root: extension.root }
      );
    }

    /**
     * 品牌图形：扩展包内的资产（`icon.asset`）→ 约定逻辑路径 `/plugin-icons/<id><ext>`。
     * 宿主把它注入到后端插件卡片；扩展源码不写死宿主目录里的路径。
     */
    const iconPath = extensionIconPublicPath(descriptor, extension.extensionId);
    if (iconPath) {
      const assetFile = extensionIconAssetFile(extension.dir, descriptor);
      if (!assetFile || !fs.existsSync(assetFile)) {
        throw new ExtensionLoadError(
          "EXTENSION_ICON_ASSET_MISSING",
          `扩展 ${extension.extensionId} 声明的品牌图形不存在：${String(descriptor.icon?.asset)}（目录 ${extension.dir}）`,
          { extensionId: extension.extensionId, directory: extension.dir, asset: descriptor.icon?.asset }
        );
      }
    }

    const modules = new Set();
    if (backend) modules.add(backend.module);
    if (hostPlugin) modules.add(hostPlugin.module);
    if (canvasContent) modules.add(canvasContent.module);
    if (metadata) modules.add(metadata.module);
    if (bootstrap) modules.add(bootstrap.module);
    for (const route of publicRoutes) if (route.module) modules.add(route.module);

    registrations.push({
      extensionId: extension.extensionId,
      directory: extension.dir,
      descriptor,
      descriptorPath: extension.descriptorPath,
      order: descriptor.backend?.order ?? descriptor.site?.order ?? FALLBACK_ORDER,
      metadataOrder: descriptor.metadata?.order ?? FALLBACK_ORDER,
      siteOrder: descriptor.site?.order ?? FALLBACK_ORDER,
      hostPluginOrder: descriptor.hostPlugin?.order ?? FALLBACK_ORDER,
      canvasContentOrder: descriptor.canvasContent?.order ?? FALLBACK_ORDER,
      backend,
      hostPlugin,
      canvasContent,
      iconPath,
      metadataExport: metadata ? metadata.exportName : null,
      metadataModule: metadata ? metadata.module : null,
      publicRoutes,
      site: descriptor.site ? true : false,
      hasBrowserArtifact: hasBrowserArtifact(extension.dir),
      managed: extension.managed === true,
      managedVersion: extension.managedVersion ?? null,
      rootWritable: extension.rootWritable === true,
      modules: [...modules]
    });

    if (bootstrap) {
      slotEntries.push({
        extensionId: extension.extensionId,
        directory: extension.dir,
        root: extension.root,
        rootWritable: extension.rootWritable === true,
        descriptorPath: extension.descriptorPath,
        module: bootstrap.module,
        export: bootstrap.export
      });
    }
  }

  registrations.sort(
    compareByOrder(
      (registration) => registration.order,
      (registration) => registration.extensionId
    )
  );

  // 槽位实现按 extensionId 稳定排序：启动日志与错误顺序可复现。
  slotEntries.sort((a, b) => (a.extensionId < b.extensionId ? -1 : a.extensionId > b.extensionId ? 1 : 0));

  // 站点目录：声明有 `site` 段的扩展；`frontendEntry` 来自已构建 browser 产物是否存在。
  // 排序与生成器一致：先按 `site.order`，再按 extensionId。
  const siteEntries = registrations
    .filter((registration) => registration.descriptor.site)
    .sort(
      compareByOrder(
        (registration) => registration.siteOrder,
        (registration) => registration.extensionId
      )
    )
    .map((registration) => siteEntryOf({
      extensionId: registration.extensionId,
      directory: registration.directory
    }, registration.descriptor, { hasBrowser: registration.hasBrowserArtifact }));
  const catalogValidation = resolvedContracts.validateApplicationExtensionCatalog?.(siteEntries);
  if (catalogValidation && !catalogValidation.ok) {
    throw new ExtensionLoadError(
      "EXTENSION_SITE_CATALOG_INVALID",
      `站点目录未通过校验：${catalogValidation.message}`,
      { extensionIds: siteEntries.map((entry) => entry.extensionId) }
    );
  }

  // provider metadata：从 `metadata` 段加载的具名导出（不含站点目录条目）。
  // 排序与生成器一致：先按 `metadata.order`，再按导出名。
  const providerRegistrations = registrations
    .filter((registration) => registration.metadataModule)
    .sort(
      compareByOrder(
        (registration) => registration.metadataOrder,
        (registration) => registration.metadataExport
      )
    );
  const providerMetadata = [];
  for (const registration of providerRegistrations) {
    const value = (
      await importModule(registration.metadataModule, {
        extensionId: registration.extensionId,
        directory: registration.directory,
        subpath: registration.metadataExport,
        descriptorPath: registration.descriptorPath
      })
    )[registration.metadataExport];
    if (value === undefined) {
      throw new ExtensionLoadError(
        "EXTENSION_EXPORT_MISSING",
        `扩展 ${registration.extensionId} 的 metadata 导出缺失：${registration.metadataExport}`,
        { extensionId: registration.extensionId, directory: registration.directory, export: registration.metadataExport }
      );
    }
    if (value.extensionId !== registration.extensionId) {
      throw new ExtensionLoadError(
        "EXTENSION_IDENTITY_MISMATCH",
        `扩展 ${registration.extensionId} 的 metadata identity 不一致：${String(value.extensionId)}`,
        { extensionId: registration.extensionId, directory: registration.directory, actual: value.extensionId }
      );
    }
    providerMetadata.push({ registration, value: { ...value, directory: registration.directory } });
  }

  // 公开路由：字面量直接取值；导出名从扩展模块读取。
  const publicRoutes = [];
  for (const registration of registrations) {
    for (const route of registration.publicRoutes) {
      let publicPath = route.publicPath ?? null;
      if (route.publicPathExport && route.staticPublicPath !== undefined) {
        publicPath = route.staticPublicPath;
      } else if (route.publicPathExport) {
        const module = await importModule(route.module, {
          extensionId: registration.extensionId,
          directory: registration.directory,
          subpath: route.publicPathExport,
          descriptorPath: registration.descriptorPath
        });
        const value = module[route.publicPathExport];
        if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
          throw new ExtensionLoadError(
            "EXTENSION_EXPORT_INVALID",
            `扩展 ${registration.extensionId} 的公开路径导出非法：${route.publicPathExport}`,
            { extensionId: registration.extensionId, directory: registration.directory, export: route.publicPathExport }
          );
        }
        publicPath = value;
      }
      publicRoutes.push({
        extensionId: registration.extensionId,
        publicPath,
        route: route.route,
        methods: route.methods
      });
    }
  }

  // provider metadata 与站点目录可能列出同一个 extensionId（扩展同时声明 hostPlugin 与 site）。
  // 按 extensionId 去重并保持首次出现顺序：重复项会让控制面与设置面把同一个插件列两次。
  const metadata = (() => {
    const seen = new Set();
    const merged = [];
    for (const entry of [...providerMetadata.map((item) => item.value), ...siteEntries]) {
      if (seen.has(entry.extensionId)) continue;
      seen.add(entry.extensionId);
      merged.push(entry);
    }
    return merged;
  })();

  /**
   * 按 extensionId 注入依赖并构造后端定义。
   *
   * `optional: true` 的扩展在宿主未提供依赖时不登记（需要部署绑定的可选扩展）；
   * 其余扩展即使宿主未提供依赖也调用工厂（由扩展自己决定缺省行为）。
   */
  const createDefinitions = async (optionsByExtensionId = {}, { excludeHostPlugins = false } = {}) => {
    const definitions = [];
    const moduleCache = new Map();
    for (const registration of registrations) {
      if (!registration.backend || (excludeHostPlugins && registration.hostPlugin)) continue;
      if (registration.backend.optional && optionsByExtensionId[registration.extensionId] === undefined) continue;
      const load = async () => {
        if (!moduleCache.has(registration.backend.module)) {
          moduleCache.set(
            registration.backend.module,
            await importModule(registration.backend.module, {
              extensionId: registration.extensionId,
              directory: registration.directory,
              subpath: registration.backend.factory,
              descriptorPath: registration.descriptorPath
            })
          );
        }
        return moduleCache.get(registration.backend.module);
      };
      const module = await load();
      const factory = module[registration.backend.factory];
      if (typeof factory !== "function") {
        throw new ExtensionLoadError(
          "EXTENSION_EXPORT_INVALID",
          `扩展 ${registration.extensionId} 的后端工厂导出不是函数：${registration.backend.factory}`,
          { extensionId: registration.extensionId, directory: registration.directory, export: registration.backend.factory }
        );
      }
      const definition = factory(optionsByExtensionId[registration.extensionId] ?? {});
      if (!definition || definition.extensionId !== registration.extensionId) {
        throw new ExtensionLoadError(
          "EXTENSION_IDENTITY_MISMATCH",
          `扩展 ${registration.extensionId} 的后端工厂 identity 不一致：${String(definition?.extensionId)}`,
          { extensionId: registration.extensionId, directory: registration.directory, actual: definition?.extensionId }
        );
      }
      definitions.push(definition);
    }
    // 稳定顺序：声明 order 已在 registrations 排好，定义按同一顺序输出。
    const orderOf = new Map(registrations.map((registration, index) => [registration.extensionId, index]));
    definitions.sort((a, b) => (orderOf.get(a.extensionId) ?? 0) - (orderOf.get(b.extensionId) ?? 0));
    return definitions;
  };

  /**
   * 按 `hostPlugin` 声明加载插件树扩展层的 Cordis 插件（Provider / 存储后端）。
   *
   * 返回 `{ provider, storage }` 两个按 `hostPlugin.order`（再按 extensionId）排序的数组。
   * `optional: true` 的声明在调用方未给出该扩展的依赖时不装载（部署绑定型）。
   * 每个插件的 `name` 必须等于扩展 identity：装配日志、配置归属与站点状态都以它为键。
   */
  const createHostPlugins = async (optionsByExtensionId = {}) => {
    const byKind = { provider: [], storage: [], "marketplace-source": [] };
    const moduleCache = new Map();
    const ordered = registrations
      .filter((registration) => registration.hostPlugin)
      .slice()
      .sort(
        compareByOrder(
          (registration) => registration.hostPluginOrder,
          (registration) => registration.extensionId
        )
      );
    for (const registration of ordered) {
      const declared = registration.hostPlugin;
      if (declared.optional && optionsByExtensionId[registration.extensionId] === undefined) continue;
      if (!moduleCache.has(declared.module)) {
        moduleCache.set(
          declared.module,
          await importModule(declared.module, {
            extensionId: registration.extensionId,
            directory: registration.directory,
            subpath: declared.factory,
            descriptorPath: registration.descriptorPath
          })
        );
      }
      const factory = moduleCache.get(declared.module)[declared.factory];
      if (typeof factory !== "function") {
        throw new ExtensionLoadError(
          "EXTENSION_EXPORT_INVALID",
          `扩展 ${registration.extensionId} 的 hostPlugin 工厂导出不是函数：${declared.factory}（目录 ${registration.directory}）`,
          { extensionId: registration.extensionId, directory: registration.directory, export: declared.factory }
        );
      }
      const plugin = factory(optionsByExtensionId[registration.extensionId] ?? {});
      if (!plugin || typeof plugin.apply !== "function" || typeof plugin.configPrefix !== "string") {
        throw new ExtensionLoadError(
          "EXTENSION_EXPORT_INVALID",
          `扩展 ${registration.extensionId} 的 hostPlugin 工厂返回值不是扩展层插件（需要 name/configPrefix/apply）：${declared.factory}`,
          { extensionId: registration.extensionId, directory: registration.directory, export: declared.factory }
        );
      }
      if (plugin.name !== registration.extensionId) {
        throw new ExtensionLoadError(
          "EXTENSION_IDENTITY_MISMATCH",
          `扩展 ${registration.extensionId} 的 hostPlugin identity 不一致：${String(plugin.name)}`,
          { extensionId: registration.extensionId, directory: registration.directory, actual: plugin.name }
        );
      }
      // 品牌图形由声明注入（扩展源码不写死宿主目录里的路径）；未声明的插件保持自己的语义图标名。
      // `origin`：插件来自哪类根，供宿主做运行期来源断言（见 extension-host-managed.mjs）。
      const origin = hostPluginOrigin(registration);
      byKind[declared.kind].push({ ...plugin, origin, directory: registration.directory, ...(registration.iconPath ? { icon: registration.iconPath } : {}) });
    }
    return byKind;
  };

  /**
   * 加载画布内容扩展（`canvasContent` 声明）：工厂返回 `ContentFrameRuntime`。
   *
   * 返回值按 `canvasContent.order`（再按 extensionId）排序，供核心层注入 canvas-service；
   * 宿主只做形状校验，不认识具体内容领域。
   */
  const createCanvasContent = async (optionsByExtensionId = {}) => {
    const entries = [];
    const moduleCache = new Map();
    const ordered = registrations
      .filter((registration) => registration.canvasContent)
      .slice()
      .sort(compareByOrder((registration) => registration.canvasContentOrder, (registration) => registration.extensionId));
    for (const registration of ordered) {
      const declared = registration.canvasContent;
      if (!moduleCache.has(declared.module)) {
        moduleCache.set(
          declared.module,
          await importModule(declared.module, {
            extensionId: registration.extensionId,
            directory: registration.directory,
            subpath: declared.factory,
            descriptorPath: registration.descriptorPath
          })
        );
      }
      const factory = moduleCache.get(declared.module)[declared.factory];
      if (typeof factory !== "function") {
        throw new ExtensionLoadError(
          "EXTENSION_EXPORT_INVALID",
          `扩展 ${registration.extensionId} 的 canvasContent 工厂导出不是函数：${declared.factory}（目录 ${registration.directory}）`,
          { extensionId: registration.extensionId, directory: registration.directory, export: declared.factory }
        );
      }
      const runtime = await factory(optionsByExtensionId[registration.extensionId] ?? {});
      const hasFrames = runtime?.frames !== undefined;
      const hasConversion = runtime?.conversion !== undefined;
      const hasMcp = runtime?.mcp !== undefined;
      const hasRecording = runtime?.recording !== undefined;
      const framesOk =
        !hasFrames ||
        (typeof runtime.frames === "object" &&
          typeof runtime.frames.matches === "function" &&
          typeof runtime.frames.preparePreviewFrame === "function" &&
          typeof runtime.frames.prepareHistoryFrame === "function" &&
          typeof runtime.frames.identityMatches === "function");
      const conversionOk =
        !hasConversion ||
        (typeof runtime.conversion === "object" &&
          typeof runtime.conversion.createService === "function" &&
          typeof runtime.conversion.createMediaReader === "function" &&
          typeof runtime.conversion.createInMemoryRegistry === "function");
      const mcpOk =
        !hasMcp ||
        (typeof runtime.mcp === "object" &&
          typeof runtime.mcp.createNodeService === "function" &&
          typeof runtime.mcp.createImportService === "function" &&
          typeof runtime.mcp.createItemService === "function");
      const recordingOk =
        !hasRecording ||
        (typeof runtime.recording === "object" &&
          typeof runtime.recording.matches === "function" &&
          typeof runtime.recording.freeze === "function" &&
          typeof runtime.recording.planCommit === "function" &&
          typeof runtime.recording.describe === "function");
      const shapeOk =
        runtime &&
        typeof runtime === "object" &&
        (hasFrames || hasConversion || hasMcp || hasRecording) &&
        framesOk &&
        conversionOk &&
        mcpOk &&
        recordingOk;
      if (!shapeOk) {
        throw new ExtensionLoadError(
          "EXTENSION_EXPORT_INVALID",
          `扩展 ${registration.extensionId} 的 canvasContent 工厂返回值不是画布内容运行时（需要 frames / conversion / mcp / recording 至少一组，且组内方法齐全）：${declared.factory}`,
          { extensionId: registration.extensionId, directory: registration.directory }
        );
      }
      entries.push({ extensionId: registration.extensionId, runtime });
    }
    return entries;
  };

  /**
   * 调用槽位声明工厂并校验返回值（change: 2026-10-15-scan-bootstrap-slots-as-extension-directories，
   * 任务 2.3 / design D2）。
   *
   * `import` 不创建资源；这里调用的是**声明工厂**，它只返回 `{ extensionId, providers }`，
   * 真正建立连接的 `provider.create` 由宿主在槽位校验之后按依赖顺序执行。
   * 部署侧选项（例如企业身份的 profile）由调用方按 extensionId 注入。
   *
   * `requireFoundationCoverage: false` 供只读静态预检使用：缺少必需槽位时不抛
   * `EXTENSION_SLOT_MISSING`，由调用方按告警分级报告。启动期宿主一律保持缺省的真值。
   */
  const createSlotDeclarations = async (optionsByExtensionId = {}, runtimeEnv = env, { requireFoundationCoverage = true } = {}) => {
    const declarations = [];
    const sources = [];
    const moduleCache = new Map();
    for (const entry of slotEntries) {
      const load = async () => {
        if (!moduleCache.has(entry.module)) {
          moduleCache.set(
            entry.module,
            await importModule(entry.module, {
              extensionId: entry.extensionId,
              directory: entry.directory,
              subpath: entry.export,
              descriptorPath: entry.descriptorPath
            })
          );
        }
        return moduleCache.get(entry.module);
      };
      const module = await load();
      const factory = module[entry.export];
      if (typeof factory !== "function") {
        throw new ExtensionLoadError(
          "EXTENSION_EXPORT_MISSING",
          `扩展 ${entry.extensionId} 的槽位声明工厂导出缺失或不是函数：${entry.export}（目录 ${entry.directory}）`,
          { extensionId: entry.extensionId, directory: entry.directory, export: entry.export }
        );
      }
      // 运行期 env 由调用方给出：后端注入自己实际生效的 env（测试与部署入口常注入自定义 env），
      // 只读工具（预检/装配）用宿主扫描时的 env。
      const declaration = await callSlotFactory(entry, factory, { env: runtimeEnv, extensionIds: registrations.map(item => item.extensionId), directory: entry.directory, options: optionsByExtensionId[entry.extensionId] });
      if (!declaration || declaration.extensionId !== entry.extensionId) {
        throw new ExtensionLoadError(
          "EXTENSION_IDENTITY_MISMATCH",
          `扩展 ${entry.extensionId} 的槽位声明 identity 不一致：${String(declaration?.extensionId)}（目录 ${entry.directory}）`,
          { extensionId: entry.extensionId, directory: entry.directory, actual: declaration?.extensionId }
        );
      }
      if (!Array.isArray(declaration.providers) || declaration.providers.length === 0) {
        throw new ExtensionLoadError(
          "EXTENSION_SLOT_DECLARATION_INVALID",
          `扩展 ${entry.extensionId} 的槽位声明必须提供非空 providers（目录 ${entry.directory}）`,
          { extensionId: entry.extensionId, directory: entry.directory }
        );
      }
      for (const provider of declaration.providers) {
        if (!FOUNDATION_SLOT_NAMES.includes(provider?.slot)) {
          throw new ExtensionLoadError(
            "EXTENSION_SLOT_UNKNOWN",
            `扩展 ${entry.extensionId} 声明了未知槽位：${String(provider?.slot)}（只接受 ${FOUNDATION_SLOT_NAMES.join(" / ")}；目录 ${entry.directory}）`,
            { extensionId: entry.extensionId, directory: entry.directory, slot: provider?.slot }
          );
        }
        if (typeof provider.create !== "function" || !Array.isArray(provider.requires)) {
          throw new ExtensionLoadError(
            "EXTENSION_SLOT_DECLARATION_INVALID",
            `扩展 ${entry.extensionId} 的槽位 ${provider.slot} 声明缺 create 或 requires（目录 ${entry.directory}）`,
            { extensionId: entry.extensionId, directory: entry.directory, slot: provider.slot }
          );
        }
      }
      declarations.push(declaration);
      sources.push({ declaration, directory: entry.directory });
    }
    assertSlotGraph(sources, { requireFoundationCoverage });
    return declarations;
  };

  // 运行期发布目录与发布器（见 extension-host-release.mjs）。
  const release = await createReleaseFacade({ artifacts: browserArtifacts, repoRoot, contracts: resolvedContracts, logger });

  // 目录控制只做安装/卸载（改名）；启用/停用走站点控制面，因此它不参与运行状态。
  // 改名写入必须落在配置声明的可写根内，否则管理员能把受版本控制的目录改走。
  const directoryControl = createExtensionDirectoryControl({
    roots: scan.roots,
    writableRoots: scan.writableRoots ?? [],
    metadata,
    onRename(from, to) {
      release.relocate(from, to);
    }
  });
  const host = {
    directoryControl,
    repoRoot,
    roots: scan.roots,
    /** 受管安装根（change: 2026-10-21-add-extension-marketplace-point，D7）；未配置时为 undefined。 */
    managedRoot: scan.managedRoot,
    /** 内置根的可升级元数据（版本 / 目录 / 是否需要后端），即使被受管版本覆盖也保留。 */
    builtinExtensions: scan.builtinExtensions ?? [],
    /** 受管后端扩展是否以 Extension Host 子进程运行（change: 2026-10-21-isolate-extension-host-process，D1）。 */
    isolation: isolate,
    /** 受管扩展被拒绝装配的记录（信任边界/声明/模块缺失）；不让启动失败。 */
    managedRejected: rejected,
    source: scan.source,
    configPath: scan.configPath,
    configFile: scan.configFile,
    scan,
    registrations,
    undeclared,
    disabled: scan.disabled,
    skipped: scan.skipped,
    metadata,
    publicRoutes,
    siteEntries,
    siteExtensionIds: siteEntries.map((entry) => entry.extensionId),
    browserArtifacts,
    slotEntries,
    /**
     * 安全模式（D7）：`null` 表示正常启动；否则列出本次未装配的扩展。宿主据此把它们的站点实际状态
     * 投影为 `suspended`，不改写已保存的启停配置。
     */
    safeMode: safeMode ? { suspended: suspended.map((entry) => entry.extensionId) } : null,
    /**
     * 调用槽位声明工厂并校验（形状、identity、槽位名，以及重复实现/未知依赖/依赖成环）。
     * 「依赖缺失」与「每槽位恰一个」仍由 bootstrapProviders 兜底（纵深防御）。
     */
    createSlotDeclarations,
    createDefinitions,
    /**
     * 插件树扩展层的 Cordis 插件（Provider / 存储后端），由 `hostPlugin` 声明驱动。
     * 宿主不再维护逐插件的手写注册表。
     */
    createHostPlugins,
    /** 画布内容扩展（预览/历史帧端口）：由 `canvasContent` 声明驱动。 */
    createCanvasContent
  };
  // 发布相关成员（含 browserRelease getter）按属性描述符并入，getter 保持「每次取当前值」。
  Object.defineProperties(host, Object.getOwnPropertyDescriptors(release.members));
  return host;
}
