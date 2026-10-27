#!/usr/bin/env node
/**
 * 扩展静态预检
 * （change: 2026-10-15-add-scannable-extension-directories，任务 3.4 / design D7）。
 *
 * 取代原 `extensions:check` 的"生成物漂移"校验：发现时机移到服务启动期后，CI 需要一条
 * **不写盘、不起服务**的命令提前发现脏目录。它做四件事：
 *
 * 1. 扫描配置根（缺根、跨根重复 identity、非法声明都会失败）；
 * 2. 声明校验与后端/共享模块解析（包内相对子路径、越界与缺失都在此暴露）；
 * 3. browser 产物存在性：有 `src/frontend/` 源码或已有 `browser-dist/` 的扩展必须带
 *    `browser-dist/artifact-manifest.json`（`--strict` 时升级为失败，缺省只告警）；
 * 4. 打印启动期会写入的同一份结构化摘要（不含秘密）。
 *
 * 分级（本批对齐：缺槽位实现只告警）：
 * - **失败**（退出码 1）：跨根重复 extensionId、声明格式/身份错误、模块越界或缺失、
 *   工厂导出缺失或类型不符、同槽位两个启用实现、未知依赖、依赖成环或缺失。
 * - **告警**（退出码 0，`--strict` 时升级为失败）：有 browser 源码但缺产物；站点扩展声明
 *   前端入口但缺产物；**必需槽位（storage / identity / access）没有已启用的实现**。
 *   最后一项在分支当前姿态下是正常状态——槽位实现扩展目录尚未搬入；启动期宿主仍会
 *   fail-fast，因此它是部署提示而不是仓库布局错误。
 *
 * 用法：
 *   node scripts/extensions-preflight.mjs [--strict] [--json]
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EXTENSION_PACKAGE_PREFIX, hasBrowserEntry, readExtensionDescriptor } from "./lib/extension-scan.mjs";
import { syncExtensionIconAssets } from "./lib/extension-icon-assets.mjs";
import { checkEnginesCompatible, contentDeclarationCollisions, validateExtensionDescriptor } from "./lib/extension-descriptor.mjs";
import { loadExtensionContracts } from "./lib/extension-release-protocol.mjs";
import {
  FOUNDATION_SLOT_NAMES,
  requiredFoundationSlots,
  hasBrowserArtifact,
  hostSummary,
  loadExtensionHost,
  probeDeclaredModules,
  untrustedRootViolation
} from "./lib/extension-host.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = path.resolve(HERE, "..");

/** 必需槽位（与后端 `bootstrapProviders` 的 FoundationSlot 口径一致）。 */
export const REQUIRED_SLOTS = FOUNDATION_SLOT_NAMES;

/**
 * 收集预检问题（纯函数：只读宿主结果与扩展目录）。
 *
 * `slotDeclarations` 传入时额外校验槽位覆盖（change:
 * 2026-10-15-scan-bootstrap-slots-as-extension-directories，任务 2.4 / 8.3）：
 * 同槽位两个实现是布局错误（失败），缺必需槽位只告警——分支可能尚未搬入槽位实现扩展目录，
 * 启动期宿主仍会拒绝装配。
 *
 * 返回 `{ errors, warnings }`；`errors` 非空表示预检失败。
 */
export function collectPreflightProblems(host, { slotDeclarations = null } = {}) {
  const errors = [];
  const warnings = [];
  // 品牌图形生成物（`web/frontend/public/plugin-icons/`）与扩展包内资产必须一致：漂移会让设置页
  // 卡片图标 404。事实来源是扩展目录，生成物由 `pnpm -C web run icons:sync` 刷新。
  // 只在「真实仓库根 + 至少一个扩展声明了品牌图形」时校验：合成 fixture（无 repoRoot / 无图标声明）
  // 不该被生成物规则干扰。
  const iconRegistrations = host.registrations.filter((registration) => registration.descriptor?.icon?.asset);
  if (typeof host.repoRoot === "string" && host.repoRoot.length > 0 && iconRegistrations.length > 0) {
    const iconAssets = syncExtensionIconAssets({
      repoRoot: host.repoRoot,
      check: true,
      extensions: iconRegistrations.map((registration) => ({
        extensionId: registration.extensionId,
        dir: registration.directory,
        descriptor: registration.descriptor
      }))
    });
    for (const message of iconAssets.errors) errors.push({ extensionId: "品牌图形", directory: "", message });
  }
  errors.push(...contentDeclarationCollisions(host.registrations));
  for (const extension of host.scan.extensions) {
    const built = hasBrowserArtifact(extension.dir);
    const hasSources = hasBrowserEntry(extension.dir);
    if (!built && hasSources) {
      warnings.push({
        extensionId: extension.extensionId,
        directory: extension.dir,
        message: "有 browser 源码但缺 browser-dist/artifact-manifest.json；先运行 build:browser"
      });
    }
    if (built && !hasSources) {
      // 允许：只交付预构建产物的目录（部署形态）。仅记录，不算问题。
      continue;
    }
  }
  for (const registration of host.registrations) {
    if (!registration.descriptor.site) continue;
    if (!registration.hasBrowserArtifact && hasBrowserEntry(registration.directory)) {
      warnings.push({
        extensionId: registration.extensionId,
        directory: registration.directory,
        message: "站点扩展声明了前端入口但缺已构建产物；发布目录不会登记其浏览器入口"
      });
    }
  }
  if (slotDeclarations) {
    const directoryOf = new Map((host.slotEntries ?? []).map((entry) => [entry.extensionId, entry.directory]));
    const ownersBySlot = new Map();
    for (const declaration of slotDeclarations) {
      for (const provider of declaration.providers ?? []) {
        const owners = ownersBySlot.get(provider.slot) ?? [];
        owners.push(declaration.extensionId);
        ownersBySlot.set(provider.slot, owners);
      }
    }
    for (const slot of requiredFoundationSlots([...ownersBySlot.keys()])) {
      const owners = ownersBySlot.get(slot) ?? [];
      if (owners.length === 1) continue;
      const directory = owners.map((owner) => directoryOf.get(owner)).filter(Boolean).join("、");
      if (owners.length === 0) {
        warnings.push({
          extensionId: `（无 ${slot} 实现）`,
          directory: "",
          message: `槽位 ${slot} 没有已启用的实现：静态预检不因此失败，但启动期扩展宿主会拒绝装配。放入实现后重启（存储：web/extensions/<backend>-storage；身份/权限：安装部署选择的扩展）`
        });
        continue;
      }
      errors.push({
        extensionId: owners.join("、"),
        directory,
        message: `槽位 ${slot} 有 ${owners.length} 个已启用实现：给其中一个目录名加 \`.\` 前缀停用，改后重启`
      });
    }
  }
  return { errors, warnings };
}

/**
 * 探测声明指向的工厂导出是否真的存在。
 *
 * 扫描期只校验"模块文件存在"，不校验导出：`backend.factory` 指向已经被删掉的函数时预检照样通过，
 * 直到有人真按声明构造定义才炸（本仓库就出现过 7 个 provider 的死 `backend` 声明）。这里按声明
 * import 一次模块并断言导出是函数，让"声明与实现漂移"在静态预检阶段失败。
 *
 * `metadata` / `publicRoutes` / `bootstrap` 的导出在宿主扫描与槽位声明阶段已经探测过，不重复。
 */
export async function probeDeclaredExports(host) {
  const errors = [];
  const modules = new Map();
  const load = async (file) => {
    if (!modules.has(file)) modules.set(file, await import(pathToFileURL(file).href));
    return modules.get(file);
  };
  for (const registration of host.registrations ?? []) {
    const probes = [];
    if (registration.backend) {
      probes.push({ what: "backend.factory", module: registration.backend.module, exportName: registration.backend.factory });
    }
    if (registration.hostPlugin) {
      probes.push({ what: "hostPlugin.factory", module: registration.hostPlugin.module, exportName: registration.hostPlugin.factory });
    }
    if (registration.canvasContent) {
      probes.push({ what: "canvasContent.factory", module: registration.canvasContent.module, exportName: registration.canvasContent.factory });
    }
    for (const probe of probes) {
      let module;
      try {
        module = await load(probe.module);
      } catch (error) {
        errors.push({
          extensionId: registration.extensionId,
          directory: registration.directory,
          message: `声明 ${probe.what} 指向的模块无法加载（${path.relative(DEFAULT_REPO_ROOT, probe.module)}）：${error instanceof Error ? error.message : String(error)}`
        });
        continue;
      }
      if (typeof module[probe.exportName] !== "function") {
        errors.push({
          extensionId: registration.extensionId,
          directory: registration.directory,
          message: `声明 ${probe.what}=${probe.exportName} 的导出不存在或不是函数（${path.relative(DEFAULT_REPO_ROOT, probe.module)}）：删掉这条死声明，或补回导出`
        });
      }
    }
  }
  return errors;
}

/**
 * 对任意扩展目录做与 `pnpm extensions:check` 同口径的静态预检
 * （change: 2026-10-21-add-extension-marketplace-point，任务 2.3 / design D4、D6、D8）。
 *
 * 供 Extension Manager 对 staging 目录调用：**只读 JSON、解析模块路径与校验 browser 产物，不 import、
 * 不执行包内任何代码**（受管扩展此时尚未被信任为可执行）。
 *
 * `managed: true` 额外施加受管扩展规则：
 * - 必须有 `extension.json`，且声明 `version`（与 package.json 一致）与 `engines`；engines 与宿主兼容；
 * - 包名 `@woohaa3/extension-*`，依赖里不得有 `workspace:`（受管扩展不在 pnpm 工作区里）；
 * - 禁止 `bootstrap` / `canvasContent` / 市场来源（与装配期 `untrustedRootViolation` 同一函数）/ `migrate`
 *   / `required: true` / 前端 activation `always`（design D8：它们参与 page ready，不能热登记）；
 * - 有 browser 源码约定或 `browser-dist/` 时，artifact manifest 必须存在、可解码、与宿主 SDK 兼容，
 *   身份与声明一致，清单里每个文件存在且 sha256/大小一致。
 *
 * 返回 `{ ok, errors, warnings, extensionId, version, descriptor, packageJson, engines,
 * activation, requiresRestart }`；errors/warnings 是 `{ code, field?, message }`。
 * `requiresRestart`：声明了后端代码（backend / hostPlugin / metadata / publicRoutes）→ 受控重启生效（D8）。
 */
export async function preflightDirectory(dir, { managed = false, contracts = null } = {}) {
  const errors = [];
  const warnings = [];
  const fail = (code, message, field) => errors.push({ code, message, ...(field ? { field } : {}) });
  const root = path.resolve(dir);
  const result = (extra = {}) => ({ ok: errors.length === 0, errors, warnings, extensionId: null, version: null, descriptor: null, packageJson: null, engines: null, permissions: null, activation: null, requiresRestart: false, ...extra });

  let packageJson = null;
  try {
    packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch (error) {
    fail("MARKETPLACE_PREFLIGHT_FAILED", `package.json 缺失或不是合法 JSON：${error.message}`, "package.json");
    return result();
  }
  if (typeof packageJson?.name !== "string" || !packageJson.name.startsWith(EXTENSION_PACKAGE_PREFIX)) {
    fail("MARKETPLACE_PREFLIGHT_FAILED", `package.json 的 name 必须以 ${EXTENSION_PACKAGE_PREFIX} 开头：${String(packageJson?.name)}`, "package.json.name");
  }

  let raw;
  try {
    raw = readExtensionDescriptor(root);
  } catch (error) {
    fail("MARKETPLACE_PREFLIGHT_FAILED", error.message, "extension.json");
    return result({ packageJson });
  }
  if (!raw.descriptorPath) {
    if (managed) fail("MARKETPLACE_PREFLIGHT_FAILED", "受管扩展必须带 extension.json", "extension.json");
    return result({ packageJson });
  }
  const validated = validateExtensionDescriptor(raw.descriptor);
  if (!validated.ok) {
    for (const message of validated.errors) fail("MARKETPLACE_PREFLIGHT_FAILED", `extension.json：${message}`, "extension.json");
    return result({ packageJson });
  }
  const descriptor = validated.value;
  const extensionId = descriptor.extensionId;
  const version = descriptor.version ?? (typeof packageJson.version === "string" ? packageJson.version : null);
  const extension = { extensionId, dir: root, directory: path.basename(root), descriptorPath: raw.descriptorPath, managed, rootWritable: false };

  if (managed) {
    if (descriptor.version === undefined) fail("MARKETPLACE_PREFLIGHT_FAILED", "受管扩展的 extension.json 必须声明 version", "version");
    else if (packageJson.version !== descriptor.version) {
      fail("MARKETPLACE_PREFLIGHT_FAILED", `extension.json 的 version（${descriptor.version}）与 package.json（${String(packageJson.version)}）不一致`, "version");
    }
    if (descriptor.engines === undefined) fail("MARKETPLACE_PREFLIGHT_FAILED", "受管扩展的 extension.json 必须声明 engines", "engines");
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [name, spec] of Object.entries(packageJson[field] ?? {})) {
        if (typeof spec === "string" && spec.startsWith("workspace:")) {
          fail("MARKETPLACE_PREFLIGHT_FAILED", `package.json 的 ${field}.${name} 使用 workspace: 依赖；受管扩展必须是自包含产物（先 pack:extension）`, `package.json.${field}`);
        }
      }
    }
    const violation = untrustedRootViolation(extension, descriptor);
    if (violation) fail("MARKETPLACE_FORBIDDEN_DECLARATION", violation.message, violation.field);
    if (descriptor.migrate) fail("MARKETPLACE_FORBIDDEN_DECLARATION", "受管扩展暂不支持数据迁移（migrate）：需要进程隔离支持", "migrate");
    // 子进程隔离（change: 2026-10-21-isolate-extension-host-process，任务 6.3 / design D9）。
    for (const native of findNativeModules(root)) {
      fail("MARKETPLACE_FORBIDDEN_DECLARATION", `受管扩展不得包含原生模块（可绕过子进程的出网守卫）：${native}`, "native-module");
    }
    if (descriptor.hostPlugin) {
      const entries = [descriptor.hostPlugin.module, descriptor.metadata?.module, ...(descriptor.publicRoutes ?? []).filter((route) => route.publicPathExport).map((route) => route.module)].filter(Boolean);
      for (const subpath of new Set(entries)) {
        if (!String(subpath).startsWith("./backend-dist/")) {
          fail("MARKETPLACE_FORBIDDEN_DECLARATION", `受管扩展的后端入口必须在 backend-dist/ 下（先 pack:extension）：${subpath}`, "hostPlugin.module");
        }
      }
      // 不再要求 backend-dist/config-schema.json：C 方向下受管后端插件在宿主进程内 import，
      // 配置段由装载器按工厂返回值登记，构建期静态描述已无消费者。
    }
    if (descriptor.required === true) fail("MARKETPLACE_FORBIDDEN_DECLARATION", "受管扩展不得声明 required: true", "required");
  }
  if (descriptor.engines !== undefined) {
    const compatible = checkEnginesCompatible(descriptor.engines);
    if (!compatible.ok) for (const reason of compatible.reasons) fail("MARKETPLACE_ENGINES_INCOMPATIBLE", reason, "engines");
  }

  // 模块路径与品牌图形：只解析，不 import（与装配期 probeDeclaredModules 同一函数）。
  const moduleProblem = probeDeclaredModules(extension, descriptor);
  if (moduleProblem) fail("MARKETPLACE_PREFLIGHT_FAILED", moduleProblem.message, moduleProblem.code);

  // browser 产物完整性。
  let activation = null;
  const hasArtifact = hasBrowserArtifact(root);
  if (!hasArtifact && (hasBrowserEntry(root) || fs.existsSync(path.join(root, "browser-dist")))) {
    if (managed) fail("MARKETPLACE_PREFLIGHT_FAILED", "缺少 browser-dist/artifact-manifest.json；先 build:browser", "browser-dist");
    else warnings.push({ code: "EXTENSION_BROWSER_ARTIFACT_MISSING", message: "有 browser 源码但缺 browser-dist/artifact-manifest.json；先运行 build:browser" });
  }
  if (hasArtifact) {
    const resolvedContracts = contracts ?? (await loadExtensionContracts());
    const artifactProblems = checkBrowserArtifact(root, extensionId, resolvedContracts);
    for (const message of artifactProblems.errors) fail("MARKETPLACE_PREFLIGHT_FAILED", message, "browser-dist");
    activation = artifactProblems.activation;
    if (managed && artifactProblems.required) fail("MARKETPLACE_FORBIDDEN_DECLARATION", "受管扩展的前端 metadata 不得声明 required: true", "browser-dist.metadata.required");
    if (managed && activation === "always") {
      fail("MARKETPLACE_FORBIDDEN_DECLARATION", "受管扩展的前端 activation 不得为 always（只允许 server-active / browser-local）", "browser-dist.metadata.activation");
    }
  }

  const requiresRestart = Boolean(descriptor.backend || descriptor.hostPlugin || descriptor.metadata || (descriptor.publicRoutes?.length ?? 0) > 0);
  return result({
    extensionId,
    version,
    descriptor,
    packageJson,
    engines: descriptor.engines ?? null,
    activation,
    requiresRestart
  });
}

/** 包内的原生模块（.node 文件），返回相对路径；不跟随符号链接。 */
function findNativeModules(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".node")) out.push(relative);
      if (out.length >= 20) return;
    }
  };
  walk(root, "");
  return out;
}

/** browser artifact 静态校验（不执行产物代码）：解码、兼容、身份、文件清单一致。 */
function checkBrowserArtifact(root, extensionId, contracts) {
  const errors = [];
  const outDir = path.join(root, "browser-dist");
  let manifestRaw;
  try {
    manifestRaw = JSON.parse(fs.readFileSync(path.join(outDir, "artifact-manifest.json"), "utf8"));
  } catch (error) {
    return { errors: [`browser-dist/artifact-manifest.json 不是合法 JSON：${error.message}`], activation: null, required: false };
  }
  const decoded = contracts.decodeExtensionBrowserArtifactManifest ? contracts.decodeExtensionBrowserArtifactManifest(manifestRaw) : { ok: true, value: manifestRaw };
  if (!decoded.ok) return { errors: [`browser artifact manifest 无效：${decoded.message ?? decoded.code ?? "malformed"}`], activation: null, required: false };
  const manifest = decoded.value;
  if (contracts.isArtifactCompatibleWithHost && !contracts.isArtifactCompatibleWithHost(manifest, { sdkAbi: contracts.EXTENSION_SDK_ABI_VERSION, reactMajor: contracts.HOST_REACT_MAJOR })) {
    errors.push(`browser artifact 与宿主 SDK/React 不兼容：sdkAbi=${manifest.sdkAbi} reactMajor=${manifest.reactMajor}`);
  }
  if (manifest.metadata?.extensionId !== extensionId) {
    errors.push(`browser artifact 的 extensionId（${String(manifest.metadata?.extensionId)}）与 extension.json（${extensionId}）不一致`);
  }
  for (const file of manifest.files ?? []) {
    const reason = typeof file.path === "string" && !file.path.split("/").includes("..") && !file.path.startsWith("/") ? null : "路径非法";
    const full = path.join(outDir, ...String(file.path).split("/"));
    if (reason || !fs.existsSync(full)) {
      errors.push(`browser artifact 清单里的文件缺失或路径非法：${String(file.path)}`);
      continue;
    }
    const bytes = fs.readFileSync(full);
    if (bytes.length !== file.bytes || createHashHex(bytes) !== file.sha256) errors.push(`browser artifact 文件与清单不一致：${file.path}`);
  }
  return { errors, activation: manifest.metadata?.activation ?? null, required: manifest.metadata?.required === true };
}

function createHashHex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function main() {
  const strict = process.argv.includes("--strict");
  const asJson = process.argv.includes("--json");
  const logger = (event) => process.stderr.write(`${JSON.stringify(event)}\n`);

  let host;
  try {
    host = await loadExtensionHost({ repoRoot: DEFAULT_REPO_ROOT, logger });
  } catch (error) {
    const payload = { ok: false, code: error?.code ?? "EXTENSION_PREFLIGHT_FAILED", message: error?.message ?? String(error) };
    if (asJson) process.stdout.write(`${JSON.stringify(payload)}\n`);
    else process.stderr.write(`[extensions-preflight] 失败：${payload.code}：${payload.message}\n`);
    process.exit(1);
  }

  let slotDeclarations = null;
  let slotError = null;
  try {
    // `requireFoundationCoverage: false`：缺少必需槽位实现由本脚本按**告警**分级报告
    // （分支当前没有槽位实现扩展目录）；重复实现、未知依赖、成环、工厂导出问题仍然抛错。
    slotDeclarations = await host.createSlotDeclarations({}, undefined, { requireFoundationCoverage: false });
  } catch (error) {
    // 声明工厂失败（缺导出、identity 不符、缺存储路径等）：预检失败并保留稳定错误码与目录。
    slotError = {
      code: error?.code ?? "EXTENSION_SLOT_DECLARATION_FAILED",
      message: error?.message ?? String(error)
    };
  }

  const { errors, warnings } = slotError === null ? collectPreflightProblems(host, { slotDeclarations }) : { errors: [], warnings: [] };
  if (slotError) errors.push({ extensionId: `槽位声明（${slotError.code}）`, message: slotError.message });
  // 声明与实现漂移（死工厂）：单独探测，让它在预检阶段失败而不是等人按声明构造时炸。
  errors.push(...(await probeDeclaredExports(host)));
  // `--strict`：把告警升级为失败（CI 用完整姿态卡住）；缺省只按真问题失败。
  const failing = strict ? [...errors, ...warnings] : errors;
  const describe = (problem) => `${problem.extensionId ?? problem.directory}：${problem.message}`;
  const summary = hostSummary(host);
  // 槽位声明清单（任务 2.4）：扩展、槽位、目录、来源根，与启动期日志同一来源。
  const directoryOf = new Map((host.slotEntries ?? []).map((entry) => [entry.extensionId, entry]));
  const slots = {};
  for (const declaration of slotDeclarations ?? []) {
    for (const provider of declaration.providers ?? []) {
      const entry = directoryOf.get(declaration.extensionId);
      (slots[provider.slot] ??= []).push({
        extensionId: declaration.extensionId,
        directory: entry ? path.relative(DEFAULT_REPO_ROOT, entry.directory) : null,
        root: entry ? path.relative(DEFAULT_REPO_ROOT, entry.root) : null,
        rootWritable: entry ? entry.rootWritable : null
      });
    }
  }
  const payload = {
    ok: failing.length === 0,
    strict,
    extensions: host.registrations.length,
    browserArtifacts: host.browserArtifacts.length,
    disabled: host.disabled.length,
    errorCount: errors.length,
    warningCount: warnings.length,
    errors: errors.map(describe),
    warnings: warnings.map(describe),
    slots,
    summary
  };
  if (asJson) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    for (const problem of errors) process.stderr.write(`[extensions-preflight] 错误：${describe(problem)}\n`);
    for (const problem of warnings) process.stderr.write(`[extensions-preflight] 告警：${describe(problem)}\n`);
    // 声明失败时槽位清单不可信：只报告失败本身，不打印「无启用实现」这类误导信息。
    for (const [slot, owners] of slotDeclarations === null ? [] : Object.entries(payload.slots)) {
      for (const owner of owners) {
        process.stdout.write(
          `[extensions-preflight] 槽位 ${slot} ← ${owner.extensionId}（目录 ${owner.directory}，根 ${owner.root}${owner.rootWritable ? "，可写" : ""}）\n`
        );
      }
    }
    if (slotDeclarations !== null) {
      for (const slot of REQUIRED_SLOTS) {
        if (!payload.slots[slot]) process.stdout.write(`[extensions-preflight] 槽位 ${slot} ← （无启用实现）\n`);
      }
    }
    const note = payload.ok
      ? payload.warningCount > 0 ? "（告警不阻断；--strict 时升级为失败）" : ""
      : strict && payload.errorCount === 0 ? "（--strict：告警按失败处理）" : "";
    process.stdout.write(
      `[extensions-preflight] ${payload.ok ? "通过" : "失败"}：扩展 ${payload.extensions} 个、browser 产物 ${payload.browserArtifacts} 个、停用 ${payload.disabled} 个、错误 ${payload.errorCount} 条、告警 ${payload.warningCount} 条${note}\n`
    );
  }
  process.exit(payload.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
