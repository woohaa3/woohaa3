import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../src", import.meta.url));
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(file) : /\.tsx?$/.test(file) ? [file] : [];
  });
}
function imports(source: string): string[] {
  const file = ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result: string[] = [];
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      result.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      result.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return result;
}
function local(file: string, specifier: string) {
  const base = path.resolve(path.dirname(file), specifier.replace(/\.js$/, ""));
  return [base + ".ts", base + ".tsx", path.join(base, "index.ts"), ...(specifier.endsWith(".css") ? [path.resolve(path.dirname(file), specifier)] : [])].find(existsSync);
}

it("实际扩展包只经公共契约/API访问宿主，不能跨目录 import 宿主实现或执行构建", () => {
  const publicPackages = new Set(["react", "@deepseek-ai/cordis", "@woohaa3/frontend/extension-api"]);
  const serverBuiltins = new Set(["node:path", "node:crypto", "node:fs/promises"]);
  const offenders: string[] = [];
  for (const file of sources(root)) {
    for (const specifier of imports(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) {
        const target = local(file, specifier);
        if (!target || !target.startsWith(root + path.sep)) offenders.push(`${file}: ${specifier}`);
      } else if (!publicPackages.has(specifier) && !serverBuiltins.has(specifier)
        && specifier !== "@woohaa3/contracts" && !specifier.startsWith("@woohaa3/contracts/")) {
        offenders.push(`${file}: ${specifier}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

it("frontend/shared/archive/geometry 的实际依赖闭包不进入 Node 或后端", () => {
  const visited = new Set<string>();
  const offenders: string[] = [];
  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    if (file.endsWith(".css")) return;
    for (const specifier of imports(readFileSync(file, "utf8"))) {
      if (specifier.startsWith("node:")) offenders.push(`${file}: ${specifier}`);
      if (specifier.startsWith(".")) {
        const target = local(file, specifier);
        if (!target) throw Error(`${file}: unresolved ${specifier}`);
        visit(target);
      }
    }
  }
  for (const entry of ["frontend/index.ts", "shared.ts", "archive.ts", "geometry.ts"]) visit(path.join(root, entry));
  expect(visited.size).toBeGreaterThan(10);
  expect(offenders).toEqual([]);
});

it("依赖扫描能识别多行导入、类型导入、转出和动态 import，忽略注释", () => {
  expect(imports('/* import fs from "node:fs" */\nimport type {\n Context\n} from "@deepseek-ai/cordis";\nexport { thing } from "../../host.js";\nconst late = import("node:child_process");')).toEqual([
    "@deepseek-ai/cordis", "../../host.js", "node:child_process"
  ]);
});
