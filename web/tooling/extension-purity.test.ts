/**
 * 扩展纯粹性门禁：**插件开发/修改只改扩展目录**，框架代码不为具体插件开特例。
 *
 * 背景（application-extension-runtime 规范）：
 * - 一个 extension 的完整前端/后端/共享定义都在 `web/extensions/<id>/`（或第二根 `extensions/<id>/`）；
 * - 新增 Provider 插件 SHALL 自动出现为新的面板项，**无需修改前端**；
 * - 后端入口来自静态可信清单这一条，只覆盖**宿主核心站点插件**（ChatGPT、炉体、迁移绑定、任务监控），
 *   不覆盖由 `extension.json` 声明的插件（Provider / 存储后端 / 浏览器扩展）。
 *
 * 本门禁只针对两类**真实耦合**，不把注释里提到插件名当成问题：
 * 1. 框架源码 import 扩展包 `@woohaa3/extension-*`（import / 动态 import / require / package.json 依赖）；
 * 2. 插件**注册面**出现具体扩展 id 或 `providers.<id>` 配置段字面量——宿主只为「知道某个插件存在」而改的那种。
 *
 * 例外集中在 `extension-purity-allowlist.ts`，每条写明原因与去向；门禁同时校验清单不腐化
 * （文件仍在、记录的字面量仍在），清债必须同步删除条目。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain JS module without type declarations (shared with the startup host).
import { scanExtensions } from "../../scripts/lib/extension-scan.mjs";
import {
  CONTENT_FIELD_DEBT,
  EXTENSION_IMPORT_DEBT,
  PLUGIN_REGISTRATION_DEBT
} from "./extension-purity-allowlist.js";
// @ts-expect-error -- plain JS module without type declarations.
import { declaredContentLiterals, diffContentCoupling, findContentLiterals, listContentScanFiles, readContentDeclarations, scanContentSources } from "./extension-purity-content.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

/** 框架源码扫描根（生产代码；扩展目录本身不在其中，它们才是被保护的一方）。 */
const FRAMEWORK_ROOTS = [
  "web/backend/src",
  "web/contracts/src",
  "web/frontend/src",
  "web/services",
  // 扩展根里的**共享框架包**（不是插件，扫描按包名规则跳过）：Provider 插件公共能力。
  // 它属于框架侧，同样不得 import 具体扩展。
  "web/extensions/provider-sdk/src",
  "scripts",
  "web/tooling"
];

const SKIP_DIRS = new Set(["node_modules", "dist", "server-dist", "browser-dist", ".browser-build", ".browser-test", "test-results", "vendor"]);
const SOURCE_RE = /\.(ts|tsx|mjs|js)$/;
const isTestFile = (rel: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);

/** 插件注册面：宿主在这里「登记某个插件」。这些文件里出现具体插件身份就是回归。 */
const REGISTRATION_SURFACES = [
  "scripts/lib/ingress.mjs",
  "scripts/assemble-release.mjs",
  "scripts/canvas-legacy-migration.mjs",
  "web/package.json",
  "web/backend/package.json",
  "web/backend/src/extensions/manifest.ts",
  "web/contracts/src/extension/host/trusted-manifest.ts",
  "web/services/application-service/src/extensions/manifest.ts"
];

function walkFiles(rel: string, out: string[] = []): string[] {
  const abs = path.join(REPO_ROOT, rel);
  if (!existsSync(abs)) return out;
  const stat = statSync(abs);
  if (stat.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(rel))) return out;
    for (const entry of readdirSync(abs)) walkFiles(path.join(rel, entry), out);
    return out;
  }
  out.push(rel.replaceAll("\\", "/"));
  return out;
}

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

/**
 * 去掉注释后再判字面量：文档/注释里拿 `providers.ark` 举例不算耦合。
 * 只处理注释（不剥字符串），避免把真实耦合藏进字符串而漏检。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** 框架源码里真实 import 的扩展包（不含注释里的提及）。 */
function importedExtensionPackages(rel: string, text: string): string[] {
  if (rel.endsWith(".json")) {
    const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
    return Object.keys(deps).filter((name) => name.startsWith("@woohaa3/extension-"));
  }
  const code = stripComments(text);
  const found = new Set<string>();
  const patterns = [/\bfrom\s+["'](@woohaa3\/extension-[^"']+)["']/g, /\bimport\(\s*["'](@woohaa3\/extension-[^"']+)["']/g, /\brequire\(\s*["'](@woohaa3\/extension-[^"']+)["']/g];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) found.add(match[1]!.split("/").slice(0, 2).join("/"));
  }
  return [...found].sort();
}

function collectImportViolations(): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const root of FRAMEWORK_ROOTS) {
    for (const rel of walkFiles(root)) {
      if (rel.endsWith(".json") ? !rel.endsWith("package.json") : !SOURCE_RE.test(rel) || isTestFile(rel)) continue;
      const packages = importedExtensionPackages(rel, read(rel));
      if (packages.length > 0) byFile.set(rel, packages);
    }
  }
  return byFile;
}

function isRegistrationSurface(rel: string): boolean {
  if (REGISTRATION_SURFACES.includes(rel)) return true;
  if (rel.startsWith("web/backend/src/host/extensions/")) return !isTestFile(rel);
  // 设置（画布内弹窗）与插件管理/凭据的注册面：仍不得写死具体插件身份
  // （change: 2026-10-17-move-settings-into-canvas-dialog：设置内容从 pages/settings 迁入 cordis/plugins/settings）。
  if (rel.startsWith("web/frontend/src/cordis/plugins/settings/")) return SOURCE_RE.test(rel) && !isTestFile(rel);
  return false;
}

/** 注册面文件里出现的扩展 id 与 `providers.<id>` 配置段字面量。 */
function registrationLiterals(text: string, ids: readonly string[]): string[] {
  const code = stripComments(text);
  const found = new Set<string>();
  for (const id of ids) {
    if (new RegExp(`(^|[^a-zA-Z0-9_-])${id}([^a-zA-Z0-9_-]|$)`).test(code)) found.add(id);
  }
  // Configuration identities are string values; ordinary providers.map/length are not identities.
  for (const match of code.matchAll(/(["'`])(providers\\?\.[a-z][a-z0-9-]*)(?:\.[^"'`\n]*)?\1/g)) {
    found.add(match[2]!.replace("\\", ""));
  }
  return [...found].sort();
}

const extensionIds: string[] = scanExtensions({ repoRoot: REPO_ROOT }).extensions.map(
  (extension: { extensionId: string }) => extension.extensionId
);

describe("注册面字面量扫描", () => {
  it("识别引号内的 Provider 配置键，忽略集合属性、方法和模块路径", () => {
    expect(registrationLiterals(`providers.length; providers.map(x => x); providers.find(x => x); providers.push(x); import "./generation-providers.js";`, [])).toEqual([]);
    expect(registrationLiterals(`const section = 'providers.ark'; const nested = "providers.fal.apiKey";`, [])).toEqual(["providers.ark", "providers.fal"]);
  });
  it("仍拒绝真实的扩展身份，忽略注释示例", () => {
    expect(registrationLiterals(`const id = "sample-extension"; // "providers.ark"`, ["sample-extension"])).toEqual(["sample-extension"]);
  });
});

describe("扩展纯粹性：框架不登记具体插件", () => {
  it("框架源码不 import 扩展包（宿主核心站点插件例外已登记）", () => {
    const allowed = new Map(EXTENSION_IMPORT_DEBT.map((entry) => [entry.file, entry]));
    const violations = [...collectImportViolations().entries()]
      .filter(([file, packages]) => {
        const exception = allowed.get(file);
        return !exception || packages.some((name) => !exception.packages.includes(name));
      })
      .map(([file, packages]) => `${file} → ${packages.join(", ")}`);
    expect(
      violations,
      "插件不得要求框架源码 import 扩展包。若这是宿主核心站点插件（静态可信清单），把文件与包名登记到 extension-purity-allowlist.ts 并写明原因；否则应改为通过 extension.json 声明 + 启动期宿主加载。"
    ).toEqual([]);
  });

  it("插件注册面不出现具体插件身份（历史债已登记）", () => {
    const allowed = new Map(PLUGIN_REGISTRATION_DEBT.map((entry) => [entry.file, entry]));
    const violations: string[] = [];
    for (const root of FRAMEWORK_ROOTS) {
      for (const rel of walkFiles(root)) {
        if (!isRegistrationSurface(rel)) continue;
        const literals = registrationLiterals(read(rel), extensionIds);
        if (literals.length === 0) continue;
        const exception = allowed.get(rel);
        const unexpected = literals.filter((literal) => !exception?.literals.includes(literal));
        if (unexpected.length > 0) violations.push(`${rel} → ${unexpected.join(", ")}`);
      }
    }
    expect(
      violations,
      "注册面（宿主插件清单、ingress 路由表、设置页、构建脚本）不得写死具体插件身份。新增扩展应只改扩展目录：静态注册表改扫描/声明，路由改模式，设置面改声明驱动。确属历史债的登记到 extension-purity-allowlist.ts。"
    ).toEqual([]);
  });

  it("历史债清单不腐化：条目文件仍在、记录的身份仍在", () => {
    const stale: string[] = [];
    for (const entry of EXTENSION_IMPORT_DEBT) {
      const packages = importedExtensionPackages(entry.file, read(entry.file));
      for (const name of entry.packages) {
        if (!packages.includes(name)) stale.push(`${entry.file} 已不再引用 ${name}`);
      }
    }
    for (const entry of PLUGIN_REGISTRATION_DEBT) {
      const literals = registrationLiterals(read(entry.file), extensionIds);
      for (const literal of entry.literals) {
        if (!literals.includes(literal)) stale.push(`${entry.file} 已不再出现 ${literal}`);
      }
    }
    expect(stale, "例外清单里的条目已经不存在了：清债后请从 extension-purity-allowlist.ts 删除对应条目（否则清单会掩盖新的耦合）。").toEqual([]);
  });

  it("Provider 刷新入口与品牌图形由声明驱动（示例性断言）", () => {
    // 这两条是「插件只改自己目录」的直接体现：宿主设置页不再有 Provider → 刷新入口的映射表，
    // 扩展源码也不再写死宿主 public 目录里的品牌图形路径。
    const dialog = read("web/frontend/src/cordis/plugins/settings/workspace/plugin-config-content.tsx");
    expect(dialog).not.toContain("MODEL_REFRESH");
    expect(dialog).toContain("group.modelRefresh");
    const hardcodedIcons: string[] = [];
    for (const id of extensionIds) {
      for (const candidate of [`web/extensions/${id}`, `extensions/${id}`]) {
        try {
          if (!statSync(path.join(REPO_ROOT, candidate)).isDirectory()) continue;
        } catch {
          continue;
        }
        for (const rel of walkFiles(`${candidate}/src`)) {
          if (!SOURCE_RE.test(rel) || isTestFile(rel)) continue;
          if (/"\/plugin-icons\//.test(read(rel))) hardcodedIcons.push(rel);
        }
      }
    }
    expect(
      hardcodedIcons,
      "扩展源码不得写死宿主静态目录里的品牌图形路径：把图形放进扩展包 assets/，在 extension.json 里声明 icon.asset，路径由宿主按约定注入。"
    ).toEqual([]);
  });
});

describe("字段级扩展纯粹性", () => {
  const literals = ["filmSetContent", "film-set"];

  it("新增耦合失败，注释和更长标识符不算", () => {
    expect(findContentLiterals(`const field = "filmSetContent";`, literals)).toEqual(["filmSetContent"]);
    expect(findContentLiterals(`// "filmSetContent"\nconst id = "film-set-shot";`, literals)).toEqual([]);
    expect(diffContentCoupling([{ file: "web/contracts/src/new.ts", literals: ["filmSetContent"] }], []).unexpected).toEqual([
      "web/contracts/src/new.ts → filmSetContent"
    ]);
  });

  it("清理后残留的 allowlist 条目失败", () => {
    expect(diffContentCoupling([], [{ file: "web/contracts/src/gone.ts", literals: ["filmSetContent"], stage: "node-data", reason: "已清理" }]).stale).toEqual([
      "web/contracts/src/gone.ts 已不再出现 filmSetContent"
    ]);
  });

  it("现有内核在字段债清单下通过", () => {
    const declarations = readContentDeclarations(scanExtensions({ repoRoot: REPO_ROOT, env: {} }).extensions);
    const declared = declaredContentLiterals(declarations);
    const found = scanContentSources(listContentScanFiles(REPO_ROOT), (file: string) => read(file), declared);
    const diff = diffContentCoupling(found, CONTENT_FIELD_DEBT);
    expect(diff.unexpected, "新增字段、身份、路由或 wire 字面量要改为内容声明，或登记历史债并写明阶段。").toEqual([]);
    expect(diff.stale, "字段债清单里的字面量已经不存在，请删除对应条目。").toEqual([]);
  });
});
