/**
 * 公共前端 API 依赖方向与循环审计
 * （change: 2026-10-10-unify-extension-frontend-entry，任务 2.2/3.4 / design D2/D6）。
 *
 * 静态保证：`frontend/src/extension-api` 的运行时依赖闭包只含 `@woohaa3/ui` 与
 * `task-execution/execution-panel` 等叶子模块，不含扫描器、装配根（canvas-manifest /
 * install-services / page-scope / kernel）、app-host 或具体业务插件。公共入口不得反向依赖
 * extension 扫描发现层，避免循环装配。
 *
 * @vitest-environment node
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url));
const API_DIR = path.join(SRC_ROOT, "extension-api");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "bevy-wasm"]);

function walk(dir: string, match: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, match));
    else if (match.test(entry.name)) out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** `extension-api` 运行时可依赖的叶子目录（相对 SRC_ROOT；转出公共 UI/类型）。 */
const ALLOWED_RUNTIME_PREFIXES = [
  // Pure page input controllers and presentation; these do not import a host composition root.
  "cordis/services/assistant-execution/",
  "cordis/ui/assistant-execution/",
  // Pure same-origin URL constructors shared by remote adapters and upload planning.
  "cordis/services/paths.js",
  // change: 2026-10-15-support-configurable-app-base-path，design D6：通用公开 URL 解析能力
  // （逻辑路径 ↔ 当前挂载公开路径）作为叶子模块经 extension-api 转出给 extension 前端。
  "cordis/services/app-base-path.js",
  // 构建标识（遥测 / diagnostics 上报的 `frontendVersion`）：纯函数叶子模块，没有运行时依赖，
  // 经 extension-api 交给独立构建的扩展使用。
  "cordis/services/build-info.js",
  "cordis/plugins/task-execution/execution-panel/",
  // change: 2026-10-21-unify-assistant-execution：助手连接选择器与创作表面区域是
  // task-execution 下的叶子 UI（只依赖 contracts 类型、共享 UI 与纯服务），
  // 经 extension-api 转出给 film-set 等扩展复用同一交互。
  "cordis/plugins/task-execution/assistant-connection-picker.js",
  "cordis/plugins/task-execution/authoring-generate-layout.js",
  // change: 2026-10-10-extract-optional-feature-extensions，design D4：Dialog primitives
  // （Dialog/AlertDialog/objectPayload）作为公共 UI 经 extension-api 转出，属叶子组件契约。
  "cordis/services/dialogs/",
  // change: 2026-10-10-extract-optional-feature-extensions，design D4：通用受控 Lexical
  // `MentionEditor` 与通用 catalog → ExecutionPanel 纯投影 `projectModelConfig` 作为公共能力
  // 经 extension-api 转出，被 task-execution 与片段扩展共用（叶子模块，无业务状态）。
  "cordis/plugins/task-execution/mention/",
  "cordis/plugins/task-execution/generic-panel-projection",
  // change: 2026-10-27-harden-plugin-service-access：装配期服务访问守护。零运行时依赖的纯函数
  // 叶子（只 import type cordis），`defineExtensionPlugin` 必须与宿主 `definePlugin` 用同一套
  // 判定，否则扩展侧（出事的那一侧）没有守护。见 docs/design/plugin-service-access.md。
  "cordis/service-access-guard.js"
];

/** 禁止的宿主装配根/扫描器/业务插件依赖。 */
const FORBIDDEN = [
  "cordis/extension-entry",
  "cordis/canvas-manifest",
  "cordis/install-services",
  "cordis/page-scope",
  "cordis/kernel",
  "cordis/app-host",
  "cordis/plugins/chatgpt",
  "cordis/plugins/model-editor",
  "cordis/plugins/task-execution/plugin"
];

describe("extension-api 依赖方向审计（任务 2.2/3.4）", () => {
  const files = walk(API_DIR, /\.(ts|tsx)$/).filter((file) => !file.includes(".test."));

  it("公共 API 运行时依赖不含装配根、扫描器或业务插件", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        const specifier = match[1]!;
        if (!specifier.startsWith(".")) continue; // 裸包依赖由 manifest/其它守卫约束
        const relative = path.relative(API_DIR, path.resolve(path.dirname(file), specifier)).split(path.sep).join("/");
        if (FORBIDDEN.some((needle) => relative.includes(needle))) {
          offenders.push(`${path.relative(SRC_ROOT, file)} -> ${relative}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("运行时相对依赖落在允许的叶子目录；类型转出只做 type-only", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = stripComments(readFileSync(file, "utf8"));
      const base = path.dirname(file);
      for (const match of source.matchAll(/(import|export)\s+(type\s+)?[^;]*?from\s+["'](\.[^"']+)["']/g)) {
        const isTypeOnly = Boolean(match[2]);
        const specifier = match[3]!;
        const resolved = path.resolve(base, specifier);
        const relative = path.relative(SRC_ROOT, resolved).split(path.sep).join("/");
        const insideApi = !path.relative(API_DIR, resolved).startsWith("..");
        const allowed = insideApi || ALLOWED_RUNTIME_PREFIXES.some((prefix) => relative.startsWith(prefix));
        // 类型转出可以指向 contract 类型；运行时引用必须落在 API 内部或允许叶子目录。
        if (!isTypeOnly && !allowed) offenders.push(`${path.relative(SRC_ROOT, file)} -> ${relative} (runtime)`);
      }
    }
    // 允许的运行时引用：ui.ts 转出 @woohaa3/ui 与 execution-panel；entry/context 只有类型依赖。
    expect(offenders).toEqual([]);
  });

  it("extension 前端只消费公共 API/自身源码/types-only contracts，不导入后端实现", () => {
    // change: 2026-10-10-unify-extension-frontend-entry，任务 5.3：extension 前端产物不得内联
    // 后端 SDK/Node-only 依赖或宿主业务实现。
    const EXT_ROOT = fileURLToPath(new URL("../../../extensions", import.meta.url));
    const BANNED = [
      "@woohaa3/backend",
      "@woohaa3/canvas-service",
      "@woohaa3/task-service",
      "@woohaa3/media-service",
      "@woohaa3/mcp-service",
      "@woohaa3/application-service",
      "@openai/codex-sdk",
      "jose",
      "node:sqlite",
      "mongodb",
      "cos-nodejs-sdk-v5"
    ];
    const offenders: string[] = [];
    for (const ext of readdirSync(EXT_ROOT, { withFileTypes: true })) {
      if (!ext.isDirectory()) continue;
      const frontendDir = path.join(EXT_ROOT, ext.name, "src", "frontend");
      for (const file of walk(frontendDir, /\.(ts|tsx)$/)) {
        const source = stripComments(readFileSync(file, "utf8"));
        for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
          const specifier = match[1]!;
          if (BANNED.some((b) => specifier === b || specifier.startsWith(`${b}/`))) {
            offenders.push(`${path.relative(EXT_ROOT, file)} -> ${specifier}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
