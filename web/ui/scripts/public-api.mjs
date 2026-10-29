import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the approved package export table without evaluating React or application code. */
export function uiPublicApi(ts) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const result = new Map();
  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    if (typeof entry === "string") continue;
    const exports = new Map();
    const seen = new Set();
    const visit = file => {
      if (seen.has(file)) return;
      seen.add(file);
      const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      for (const s of ast.statements) {
        if (ts.isExportDeclaration(s)) {
          if (s.exportClause && ts.isNamedExports(s.exportClause)) {
            for (const n of s.exportClause.elements) exports.set(n.name.text, !(s.isTypeOnly || n.isTypeOnly));
          } else if (s.moduleSpecifier) {
            let target = path.resolve(path.dirname(file), s.moduleSpecifier.text).replace(/\.js$/, ".ts");
            if (!existsSync(target)) target = target.replace(/\.ts$/, ".tsx");
            visit(target);
          }
        } else if (s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
          const names = ts.isVariableStatement(s) ? s.declarationList.declarations.map(d => d.name.text) : s.name ? [s.name.text] : [];
          for (const name of names) exports.set(name, !ts.isTypeAliasDeclaration(s) && !ts.isInterfaceDeclaration(s));
        }
      }
    };
    visit(path.join(root, entry.import));
    result.set(subpath === "." ? pkg.name : pkg.name + subpath.slice(1), exports);
  }
  return result;
}
