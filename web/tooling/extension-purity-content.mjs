import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * 字段级扩展纯粹性扫描（change: 2026-10-26-abstract-extension-content-fields，任务 1.4）。
 *
 * 只认扩展 `content` 声明里的字段、身份、路由前缀、工具名和 wire 字段。
 * 注释不算耦合。带连字符或点号的字面量不匹配更长的标识符。
 */

export const CONTENT_PURITY_STAGES = ["node-data", "command", "route", "interaction", "render", "identity"];

const STAGE_REASON = {
  "node-data": "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。",
  command: "历史债：内核仍含扩展命令或编辑分支。去向：第 3 组改为 extension.command。",
  route: "历史债：内核仍写死扩展路由、工具或媒体作用域。去向：第 4 组改为内容路由。",
  interaction: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。",
  render: "历史债：渲染 wire 或场景构建仍含扩展字段。去向：第 6 组改为通用原语。",
  identity: "历史债：身份白名单或旧格式 reader 仍在内核。去向：第 7 组清债。"
};

export function contentStageReason(stage) {
  return STAGE_REASON[stage] ?? STAGE_REASON["node-data"];
}

export function stageForContentFile(file) {
  if (file.includes("composite-asset-identity") || file.includes("legacy-film-set") || file.includes("compat-inventory")) return "identity";
  if (file.startsWith("bevy/") || file.includes("render-scene") || file.includes("scene-builder") || file.includes("/recording")) return "render";
  if (file.includes("/mcp") || file.includes("media-client") || file.includes("agent-connections") || file.includes("/canvas-api")) return "route";
  if (file.includes("command-reducer") || file.endsWith("/commands.ts") || file.includes("edit-plan") || file.includes("edit-command") || file.includes("command-satisfaction")) return "command";
  if (file.startsWith("web/frontend/") || file.includes("/extension-api/")) return "interaction";
  return "node-data";
}

export function stripContentComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

export function declaredContentLiterals(declarations) {
  const found = new Set();
  for (const declaration of declarations) {
    if (declaration.extensionId) found.add(declaration.extensionId);
    for (const name of declaration.ownedFields ?? []) found.add(name);
    for (const name of declaration.ownedWireFields ?? []) found.add(name);
    if (declaration.routePrefix) found.add(declaration.routePrefix);
    for (const name of declaration.mcpTools ?? []) found.add(name);
    for (const name of declaration.targetModes ?? []) found.add(name);
    for (const name of declaration.eventOwners ?? []) found.add(name);
  }
  return [...found].sort();
}

export function findContentLiterals(source, literals) {
  const code = stripContentComments(source);
  return literals.filter((literal) => {
    const boundary = /[-.]/.test(literal) ? "[^A-Za-z0-9_-]" : "[^A-Za-z0-9_]";
    const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|${boundary})${escaped}(${boundary}|$)`).test(code);
  }).sort();
}

const SKIP_DIRS = new Set(["node_modules", "dist", "server-dist", "browser-dist", ".browser-build", ".browser-test", "test-results", "vendor"]);
const CONTENT_SOURCE = /\.(ts|tsx|mjs|js|rs)$/;
const CONTENT_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;
const CONTENT_SCAN_SKIP = new Set([
  "web/tooling/extension-purity-allowlist.ts",
  "web/tooling/extension-purity-content-allowlist.ts",
  "web/tooling/extension-purity-content.mjs"
]);

export const CONTENT_SCAN_ROOTS = [
  "web/backend/src",
  "web/contracts/src",
  "web/frontend/src",
  "web/services",
  "web/framework/provider-sdk/src",
  "scripts",
  "web/tooling",
  "bevy/src"
];

function walkContentFiles(repoRoot, rel, out) {
  if (CONTENT_SCAN_SKIP.has(rel)) return;
  const abs = path.join(repoRoot, rel);
  if (!existsSync(abs)) return;
  const stat = statSync(abs);
  if (stat.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(rel))) return;
    for (const entry of readdirSync(abs)) walkContentFiles(repoRoot, path.join(rel, entry), out);
    return;
  }
  const normalized = rel.replaceAll("\\", "/");
  if (!CONTENT_SOURCE.test(normalized) || CONTENT_TEST.test(normalized) || CONTENT_SCAN_SKIP.has(normalized)) return;
  out.push(normalized);
}

export function listContentScanFiles(repoRoot) {
  const files = [];
  for (const root of CONTENT_SCAN_ROOTS) walkContentFiles(repoRoot, root, files);
  return files;
}

export function readContentDeclarations(extensions) {
  const declarations = [];
  for (const extension of extensions) {
    const descriptorPath = extension.descriptorPath;
    if (!descriptorPath || !existsSync(descriptorPath)) continue;
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
    if (!descriptor.content) continue;
    declarations.push({ extensionId: descriptor.extensionId, ...descriptor.content });
  }
  return declarations;
}

export function scanContentSources(files, readFile, literals) {
  const found = [];
  for (const file of files) {
    const hits = findContentLiterals(readFile(file), literals);
    if (hits.length > 0) found.push({ file, literals: hits });
  }
  return found;
}

export function diffContentCoupling(found, allowlist) {
  const allowed = new Map(allowlist.map((entry) => [entry.file, new Set(entry.literals)]));
  const present = new Map(found.map((entry) => [entry.file, new Set(entry.literals)]));
  const unexpected = [];
  const stale = [];
  for (const entry of found) {
    const permitted = allowed.get(entry.file);
    const extra = entry.literals.filter((literal) => !permitted?.has(literal));
    if (extra.length > 0) unexpected.push(`${entry.file} → ${extra.join(", ")}`);
  }
  for (const entry of allowlist) {
    const live = present.get(entry.file);
    const missing = entry.literals.filter((literal) => !live?.has(literal));
    if (missing.length > 0) stale.push(`${entry.file} 已不再出现 ${missing.join(", ")}`);
  }
  return { unexpected, stale };
}
