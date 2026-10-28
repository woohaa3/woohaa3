/**
 * Extension SDK 导出完备性守卫
 * （change: 2026-10-12-add-agent-conversation-panel 回归）。
 *
 * extension 前端只从公共入口 `@woohaa3/frontend/extension-api` 具名消费宿主能力；构建期把这些
 * 运行时具名导入写入发布清单 `requiredSdkExports`，运行期 loader 再用宿主 SDK 分组的
 * `namedExports` 校验。若 extension 声明了宿主未提供的导出，required extension 会加载失败，
 * 进而让 Canvas scope 启动失败并**整屏空白**（无错误浮层）。
 *
 * 本测试用与构建期同一套 AST 规则静态比对两端集合，避免「宿主补了公共入口、忘了补 SDK 分组」
 * 导致静默空白；两处实现均在本测试内以最小规则复刻，不依赖已构建产物（browser-dist 可能不存在）。
 *
 * @vitest-environment node
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const EXTENSION_API_SPECIFIER = "@woohaa3/frontend/extension-api";
const SDK_GROUPS = ["core", "ui", "model", "authoring"] as const;
const SKIP_DIRS = new Set(["node_modules", "dist", "browser-dist", ".git", ".browser-build"]);

const RUNTIME_DIR = fileURLToPath(new URL("./", import.meta.url));
const EXTENSIONS_ROOT = fileURLToPath(new URL("../../../../extensions", import.meta.url));

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

function parse(file: string): ts.SourceFile {
  const source = readFileSync(file, "utf8");
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/**
 * 复刻 `build-extension-browser.mjs#collectSdkRequirements` 的具名运行时需求规则：
 * 命中公共入口的 `ImportDeclaration`/`ExportDeclaration` 的具名子句（排除 type-only）。
 *
 * 扫描范围必须是整个 `src/`，不能只看 `src/frontend/`：构建脚本跟随入口的传递依赖闭包
 * （`collectFrontendSources`），`src/frontend/index.ts` 往往只 re-export 责任目录，真正的
 * SDK 具名导入在 `src/authoring/...` 之类的实现文件里。只看入口目录会漏掉这些需求，把
 * 「构建产物声明了宿主没有的导出 → required extension 装载失败」放过去
 * （2026-10-22-redesign-creature-workflow-node 的 `AssistantToolbar` 就是这样漏检的）。
 */
function requiredSdkExportsForExtension(extensionId: string): string[] {
  const names = new Set<string>();
  for (const file of walk(path.join(EXTENSIONS_ROOT, extensionId, "src"))) {
    for (const statement of parse(file).statements) {
      if (ts.isImportDeclaration(statement)) {
        const specifier = statement.moduleSpecifier;
        if (!ts.isStringLiteral(specifier) || !(specifier.text === EXTENSION_API_SPECIFIER || /^@woohaa3\/ui(?:\/|$)/.test(specifier.text))) continue;
        const clause = statement.importClause;
        if (!clause || clause.isTypeOnly) continue;
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (!element.isTypeOnly) names.add(element.propertyName?.text ?? element.name.text);
          }
        }
      } else if (ts.isExportDeclaration(statement)) {
        const specifier = statement.moduleSpecifier;
        if (!specifier || !ts.isStringLiteral(specifier) || !(specifier.text === EXTENSION_API_SPECIFIER || /^@woohaa3\/ui(?:\/|$)/.test(specifier.text))) continue;
        if (statement.isTypeOnly) continue;
        const bindings = statement.exportClause;
        if (bindings && ts.isNamedExports(bindings)) {
          for (const element of bindings.elements) {
            if (!element.isTypeOnly) names.add(element.propertyName?.text ?? element.name.text);
          }
        }
      }
    }
  }
  return [...names].sort();
}

/** 读取某个 SDK 分组源码里 `namedExports = { ... }` 的键集合（宿主实际提供的运行时导出）。 */
function hostSdkNamedExports(group: (typeof SDK_GROUPS)[number]): string[] {
  const file = path.join(RUNTIME_DIR, `sdk-${group}.ts`);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "namedExports") {
      let init: ts.Expression | undefined = node.initializer;
      while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression(init))) init = init.expression;
      if (init && ts.isObjectLiteralExpression(init)) {
        for (const property of init.properties) {
          if (ts.isShorthandPropertyAssignment(property)) names.push(property.name.text);
          else if (ts.isPropertyAssignment(property)) {
            const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
            if (key) names.push(key);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file));
  return names;
}

describe("extension SDK 导出完备性（change: 2026-10-12-add-agent-conversation-panel 回归）", () => {
  const provided = new Set(SDK_GROUPS.flatMap((group) => hostSdkNamedExports(group)));
  const extensions = existsSync(EXTENSIONS_ROOT)
    ? readdirSync(EXTENSIONS_ROOT, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(path.join(EXTENSIONS_ROOT, entry.name, "src", "frontend", "index.ts")))
        .map((entry) => entry.name)
        .sort()
    : [];

  it("宿主 SDK 分组至少提供入口/plugin 定义辅助", () => {
    expect(provided.has("defineExtensionPlugin")).toBe(true);
    expect(provided.has("defineExtensionFrontend")).toBe(true);
  });

  it("每个 extension 声明的 requiredSdkExports 都由宿主 SDK 分组提供", () => {
    const missing: string[] = [];
    for (const extensionId of extensions) {
      for (const name of requiredSdkExportsForExtension(extensionId)) {
        if (!provided.has(name)) missing.push(`${extensionId} -> ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("覆盖全部含前端入口的扩展（防扫描失效导致假通过）", () => {
    expect(extensions.length).toBeGreaterThanOrEqual(6);
    expect(extensions).toContain("oauth-agent");
  });
});
