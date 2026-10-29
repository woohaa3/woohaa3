import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Parser is supplied by each extension's existing TypeScript dev dependency. */
export function moduleSpecifiers(ts: typeof import("typescript-legacy"), text: string): string[] {
  const file = ts.createSourceFile("module.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result: string[] = [];
  function visit(node: import("typescript-legacy").Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) result.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) result.push(node.arguments[0].text);
    // import("module").Type is also an environment/dependency edge.
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) result.push(node.argument.literal.text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return result;
}

export function sourceModules(root: string): Map<string, string> {
  const result = new Map<string, string>();
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(tsx?|css)$/.test(file)) result.set(path.relative(root, file).replaceAll("\\", "/"), readFileSync(file, "utf8"));
    }
  }
  walk(root);
  return result;
}

/** Resolve actual module targets before checking responsibility, environment, cycles and entry closures. */
export function checkExtensionDependencies(ts: typeof import("typescript-legacy"), modules: ReadonlyMap<string, string>, entries: readonly string[]): string[] {
  const errors: string[] = [];
  const edges = new Map<string, string[]>();
  const roles = new Set(["state", "authoring", "preview", "integration"]);
  const environments = new Set(["shared", "browser", "backend"]);
  for (const [file, text] of modules) {
    const targets: string[] = [];
    edges.set(file, targets);
    if (file.endsWith(".css")) continue;
    const [role, environment] = file.split("/");
    for (const specifier of moduleSpecifiers(ts, text)) {
      if (!specifier.startsWith(".")) {
        if (environment === "shared" && (specifier.startsWith("node:") || specifier === "react" || specifier === "@deepseek-ai/cordis" || specifier.startsWith("@woohaa3/frontend"))) errors.push(`${file}: impure shared dependency ${specifier}`);
        continue;
      }
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      const stem = base.replace(/\.(js|ts|tsx)$/, "");
      const target = [base, stem + ".ts", stem + ".tsx", base + "/index.ts"].find(candidate => modules.has(candidate));
      if (!target) { errors.push(`${file}: unresolved/outside package ${specifier}`); continue; }
      targets.push(target);
      const [targetRole, targetEnvironment] = target.split("/");
      if (!roles.has(role)) continue; // Stable public facades delegate to implementation.
      if (!roles.has(targetRole)) errors.push(`${file}: internal dependency through public facade ${target}`);
      if (role === "state" && targetRole !== "state" || (role === "authoring" || role === "preview") && targetRole !== role && targetRole !== "state") errors.push(`${file}: responsibility ${role} -> ${targetRole} (${target})`);
      if (environments.has(environment) && (environment === "shared" ? targetEnvironment !== "shared" : targetEnvironment !== environment && targetEnvironment !== "shared")) errors.push(`${file}: environment ${environment} -> ${targetEnvironment} (${target})`);
    }
  }
  const visited = new Set<string>(), stack: string[] = [];
  function visit(file: string) {
    const index = stack.indexOf(file);
    if (index !== -1) { errors.push(`cycle: ${[...stack.slice(index), file].join(" -> ")}`); return; }
    if (visited.has(file)) return;
    stack.push(file);
    for (const target of edges.get(file) ?? []) visit(target);
    stack.pop(); visited.add(file);
  }
  for (const file of modules.keys()) visit(file);
  for (const entry of entries) {
    const closure = new Set<string>();
    function traverse(file: string) {
      if (closure.has(file)) return;
      closure.add(file);
      if (!modules.has(file)) { errors.push(`entry unresolved: ${entry}`); return; }
      if (file.split("/")[1] === "backend") errors.push(`${entry}: backend in neutral/browser closure ${file}`);
      for (const specifier of moduleSpecifiers(ts, modules.get(file)!)) if (specifier.startsWith("node:")) errors.push(`${entry}: Node dependency ${file}: ${specifier}`);
      for (const target of edges.get(file) ?? []) traverse(target);
    }
    traverse(entry);
  }
  return [...new Set(errors)];
}
