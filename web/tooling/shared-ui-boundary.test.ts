import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
const web = fileURLToPath(new URL("..", import.meta.url));
const ui = path.join(web, "ui");
function scan(file: string, source: string): string[] {
  const violations: string[] = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) && (
      (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) && node.parent.moduleSpecifier === node ||
      ts.isCallExpression(node.parent) && node.parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
      ts.isLiteralTypeNode(node.parent) && ts.isImportTypeNode(node.parent.parent)
    )) {
      const spec = node.text;
      if (spec.startsWith(".")) {
        const resolved = path.resolve(path.dirname(file), spec);
        if (!resolved.startsWith(ui + path.sep) || /\.(stories|test)\.|test-setup|fixture/.test(resolved)) violations.push(`${file}: ${spec}`);
      } else if (!["react", "react-dom", "lucide-react", "@woohaa3/contracts"].some(p => spec === p || spec.startsWith(p + "/")) && !spec.startsWith("@radix-ui/")) violations.push(`${file}: ${spec}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast); return violations;
}
function files(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : /\.(tsx?|mts)$/.test(e.name) ? [path.join(dir, e.name)] : []); }
describe("shared UI package ownership", () => {
  it("production source and emitted declarations reject application and development dependencies", () => {
    expect(existsSync(path.join(ui, "dist/index.d.ts")), "run ui build first").toBe(true);
    const production = [...files(path.join(ui, "src")), ...files(path.join(ui, "dist"))].filter(f => !/\.(stories|test)\.|test-setup|test-support/.test(f));
    expect(production.flatMap(file => scan(file, readFileSync(file, "utf8")))).toEqual([]);
  });
  it.each([
    'import type { X } from "@woohaa3/frontend/extension-api";',
    'export type { X } from "../../../frontend/src/cordis/contracts.js";',
    'const x = import("@woohaa3/backend");',
    'type X = import("@woohaa3/extension-film-set").X;',
    'export * from "./Buttons.stories.js";',
    'import { fixture } from "../fixtures/data.js";',
    'import { X } from "@ladle/react";'
  ])("detects deliberate violations including type-only: %s", source => {
    expect(scan(path.join(ui, "src/violation.ts"), source)).toHaveLength(1);
  });
  it("old private trees and frontend vendor ownership are removed", () => {
    expect(existsSync(path.join(web, "frontend/src/shared/ui"))).toBe(false);
    const pkg = JSON.parse(readFileSync(path.join(web, "frontend/package.json"), "utf8"));
    expect(Object.keys(pkg.dependencies).filter(k => k.startsWith("@radix-ui/") || k === "lucide-react")).toEqual([]);
  });
});
