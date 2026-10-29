/**
 * Frontend Event Bus 架构审计
 * （change: formalize-frontend-event-bus，任务 7.1–7.4 / design D8）。
 *
 * 用 TypeScript compiler API 扫描 `src/cordis` 下**生产**源码（排除 tests/build/generated）：
 * - 记录 `.emit()` / `.on()` / `.once()` 的字符串字面量首参；
 * - 拒绝非字面量事件名（无法静态识别）；
 * - 拒绝未登记事件名；
 * - 对照目录检查每个事件至少一个 producer 与一个 consumer；
 * - 拒绝旧事件名与已删除 Task Activity service 符号。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript-legacy";
import { describe, expect, it } from "vitest";
import {
  FRONTEND_EVENT_NAMES,
  RETIRED_FRONTEND_EVENT_NAMES
} from "./catalog.js";

const CORDIS_ROOT = fileURLToPath(new URL("..", import.meta.url));
/**
 * extension 前端生产源码根（change: 2026-10-10-extract-optional-feature-extensions，任务 5.1/6.2）。
 *
 * `task-activity` 等可选业务的 emit/on 随业务迁至独立包，前端事件目录审计必须同时覆盖
 * extension 前端入口，否则会误报「无 producer/consumer」。扫描仍只针对**生产源码**。
 */
const EXTENSIONS_ROOT = fileURLToPath(new URL("../../../../extensions", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.") && !full.includes("/test-support/")) {
      out.push(full);
    }
  }
  return out;
}

/** 事件审计扫描集：宿主 cordis 树 + extension 前端生产源码。 */
function scanFiles(): string[] {
  const hostFiles = walk(CORDIS_ROOT);
  // extension 前端代码有两种布局：`src/frontend/` 入口，以及 film-set 这类按领域拆分的
  // `src/<domain>/browser/` 浏览器侧实现；两者都发布前端事件，必须一起扫描。
  const extensionFiles = walk(EXTENSIONS_ROOT).filter((file) => {
    const normalized = file.split(path.sep).join("/");
    return normalized.includes("/src/frontend/") || (normalized.includes("/src/") && normalized.includes("/browser/"));
  });
  return [...hostFiles, ...extensionFiles];
}

const EMIT_METHODS = new Set(["emit", "on", "once", "parallel", "serial", "bail"]);

type CallSite = { name: string | null; nonLiteral: boolean; file: string; kind: "emit" | "on" };

/**
 * 扫描**任意** `.emit()/.on()` 调用中作为首参的字面量事件名。
 *
 * 用于目录 producer/consumer 完整性检查：producer 可能经 typed sink/transport 选项转发
 * （例如 canvas-runtime 的 `options.emit("ui.*")`），字面量仍应静态可见。
 */
export function scanAllLiteralEventNames(file: string, source: string): Array<{ name: string; kind: "emit" | "on" }> {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Array<{ name: string; kind: "emit" | "on" }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (EMIT_METHODS.has(method)) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) {
          const kind = method === "emit" || method === "parallel" || method === "serial" || method === "bail"
            ? "emit"
            : "on";
          out.push({ name: arg.text, kind });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** 判定调用表达式是否作用在 Cordis Context 上（`ctx.emit`、`this.ctx.on`）。 */
function isContextReceiver(expression: ts.PropertyAccessExpression): boolean {
  const receiver = expression.expression;
  if (ts.isIdentifier(receiver)) {
    const name = receiver.text;
    return name === "ctx" || name.endsWith("Ctx") || name.endsWith("Context");
  }
  if (ts.isPropertyAccessExpression(receiver)) {
    const name = receiver.name.text;
    return name === "ctx" || name.endsWith("Ctx") || name.endsWith("Context");
  }
  return false;
}

/** 扫描一个源文件里的 Cordis emit/on 调用点。 */
export function scanEventCallSites(file: string, source: string): CallSite[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const sites: CallSite[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && isContextReceiver(node.expression)
    ) {
      const method = node.expression.name.text;
      if (EMIT_METHODS.has(method)) {
        const kind = method === "emit" || method === "parallel" || method === "serial" || method === "bail"
          ? "emit"
          : "on";
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) {
          sites.push({ name: arg.text, nonLiteral: false, file, kind });
        } else {
          // 事件名不是字面量：无法静态识别（审计失败）。
          sites.push({ name: null, nonLiteral: true, file, kind });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

describe("Frontend Event Bus 审计（任务 7.1 / 7.2）", () => {
  const files = scanFiles();

  it("生产 emit/on 事件名必须是字面量且已登记", () => {
    const offenders: string[] = [];
    const declared = new Set<string>(FRONTEND_EVENT_NAMES);
    for (const file of files) {
      const sites = scanEventCallSites(file, readFileSync(file, "utf8"));
      for (const site of sites) {
        if (site.nonLiteral) {
          offenders.push(`${path.relative(CORDIS_ROOT, file)}: 非字面量事件名`);
          continue;
        }
        // Cordis 框架内部事件（`internal/*`）不属于前端目录。
        if (site.name && site.name.startsWith("internal/")) continue;
        if (site.name && !declared.has(site.name)) {
          offenders.push(`${path.relative(CORDIS_ROOT, file)}: 未登记事件 ${site.name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("目录事件在生产源码中至少有一个 emit 与一个 on", () => {
    const emitted = new Set<string>();
    const listened = new Set<string>();
    for (const file of files) {
      for (const site of scanAllLiteralEventNames(file, readFileSync(file, "utf8"))) {
        if (site.kind === "emit") emitted.add(site.name);
        else listened.add(site.name);
      }
    }
    const missing: string[] = [];
    for (const name of FRONTEND_EVENT_NAMES) {
      if (!emitted.has(name)) missing.push(`${name}: 无 producer`);
      if (!listened.has(name)) missing.push(`${name}: 无 consumer`);
    }
    expect(missing).toEqual([]);
  });

  it("旧事件名与已删除 Task Activity service 符号零引用", () => {
    const banned = [...RETIRED_FRONTEND_EVENT_NAMES, "TASK_ACTIVITY_SERVICE", "SubmitActivityHook"];
    // 允许出现在目录常量自身（迁移说明）中；这里扫描生产源码。
    // 路径归一为 posix，避免 Windows 的 `\` 让排除失效（否则目录常量会被误报）。
    const productionFiles = files.filter((file) => !file.split(path.sep).join("/").endsWith("events/catalog.ts"));
    const offenders: string[] = [];
    for (const file of productionFiles) {
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      for (const needle of banned) {
        if (source.includes(needle)) offenders.push(`${path.relative(CORDIS_ROOT, file)}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
