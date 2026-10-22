/**
 * 模块依赖边界门禁
 * （change: split-web-runtime-services；change: 2026-10-06-unify-backend-runtime-with-cordis，任务 4.3）。
 *
 * 结构性守卫：通过源码与 manifest 扫描强制以下不变式：
 * - **领域模块互相不得 import 其它模块实现目录**（保持代码级边界，即使同进程）；
 * - 只有 `backend` 组合根可以 import 各领域模块（它是唯一 composition root）；
 * - 领域模块不得 import `backend`（不能反向依赖组合根）；
 * - `contracts` 不含副作用实现（无 Node driver、ws、COS SDK、provider SDK、yjs server）；
 * - `frontend` 不引用 Node-only 模块或任一领域模块实现；
 * - 插件包不 import 宿主/领域模块实现（只允许 contracts 与 shared）。
 *
 * 用故意违规 fixture 确认门禁会失败：`scanForViolations` 纯函数 + 构造输入断言。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 领域模块目录名 → 其禁止 import 的其它模块实现包/目录前缀。 */
export const SERVICE_IMPLEMENTATION_PREFIXES: Record<string, readonly string[]> = {
  "application-service": [
    "@woohaa3/canvas-service",
    "@woohaa3/task-service",
    "@woohaa3/media-service",
    "@woohaa3/mcp-service",
    "@woohaa3/backend",
    "@woohaa3/frontend"
  ],
  "canvas-service": ["@woohaa3/application-service", "@woohaa3/task-service", "@woohaa3/media-service", "@woohaa3/mcp-service", "@woohaa3/backend", "@woohaa3/frontend"],
  "task-service": ["@woohaa3/application-service", "@woohaa3/canvas-service", "@woohaa3/canvas-yjs", "@woohaa3/mcp-service", "@woohaa3/backend", "@woohaa3/frontend"],
  "media-service": ["@woohaa3/application-service", "@woohaa3/canvas-service", "@woohaa3/task-service", "@woohaa3/mcp-service", "@woohaa3/backend", "@woohaa3/frontend"],
  "mcp-service": ["@woohaa3/application-service", "@woohaa3/canvas-service", "@woohaa3/task-service", "@woohaa3/media-service", "@woohaa3/backend", "@woohaa3/frontend"]
};

/** 插件包禁止 import 的宿主/服务实现（只允许 contracts、shared 与生成插件所需的 provider SDK）。 */
export const PLUGIN_FORBIDDEN = [
  "@woohaa3/application-service",
  "@woohaa3/canvas-service",
  "@woohaa3/task-service",
  "@woohaa3/media-service",
  "@woohaa3/mcp-service",
  "@woohaa3/backend",
  "@woohaa3/frontend",
  "node:sqlite",
  "node:fs",
  "mongodb",
  "cos-nodejs-sdk-v5",
  "@sdppp/pptask-worker-server"
];

/**
 * contracts 不允许出现的副作用/服务端实现依赖。
 *
 * change: split-web-runtime-services 后，浏览器与服务端**共用**的 Yjs 线格式 codec
 * （format/commands/protocol/mapping/diff-writes）按 design D7 归属 `contracts/canvas-yjs`，
 * 因此 `yjs`/`lib0`（纯编解码，无副作用）是允许的；这里继续禁止的是**服务端运行时**：
 * 数据库 driver、ws server、COS SDK、provider SDK 与任何服务实现。
 */
export const CONTRACTS_FORBIDDEN = [
  "ws",
  "cos-nodejs-sdk-v5",
  "mongodb",
  "node:sqlite",
  "node:fs",
  "zustand",
  "@woohaa3/canvas-service",
  "@woohaa3/task-service",
  "@woohaa3/media-service",
  "@sdppp/pptask",
  "@sdppp/pptask-worker-server"
];

/** frontend 不允许的 Node-only / 服务实现依赖。 */
export const FRONTEND_FORBIDDEN = [
  "node:sqlite",
  "node:fs",
  "node:path",
  "mongodb",
  "cos-nodejs-sdk-v5",
  "@woohaa3/application-service",
  "@woohaa3/canvas-service",
  "@woohaa3/task-service",
  "@woohaa3/media-service",
  "@sdppp/pptask",
  "@sdppp/pptask-worker-server"
];

const IMPORT_PATTERN =
  /(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

export type Violation = { file: string; specifier: string; rule: string };

/** 从源码文本抽取裸 import 说明符。 */
export function extractSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  let match: RegExpExecArray | null;
  IMPORT_PATTERN.lastIndex = 0;
  while ((match = IMPORT_PATTERN.exec(source))) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier && !specifier.startsWith(".")) specifiers.push(specifier);
  }
  return specifiers;
}

/** 纯函数门禁：给定文件与依赖集合，返回违规列表（供测试用 fixture 注入）。 */
export function scanForViolations(input: {
  service?: string;
  source?: string;
  dependencies?: readonly string[];
}): Violation[] {
  const violations: Violation[] = [];
  const file = input.service ?? "<fixture>";
  const deps = input.dependencies ?? [];
  const specs = input.source ? extractSpecifiers(input.source) : [...deps];

  if (input.service && SERVICE_IMPLEMENTATION_PREFIXES[input.service]) {
    for (const specifier of specs) {
      for (const forbidden of SERVICE_IMPLEMENTATION_PREFIXES[input.service]) {
        if (specifier === forbidden || specifier.startsWith(`${forbidden}/`)) {
          violations.push({ file, specifier, rule: "service-cross-import" });
        }
      }
    }
  }
  if (input.service === "contracts") {
    for (const specifier of specs) {
      if (CONTRACTS_FORBIDDEN.some((f) => specifier === f || specifier.startsWith(`${f}/`))) {
        violations.push({ file, specifier, rule: "contracts-side-effect" });
      }
    }
  }
  if (input.service === "frontend") {
    for (const specifier of specs) {
      if (FRONTEND_FORBIDDEN.some((f) => specifier === f || specifier.startsWith(`${f}/`))) {
        violations.push({ file, specifier, rule: "frontend-node-only" });
      }
    }
  }
  if (input.service === "plugins") {
    for (const specifier of specs) {
      if (PLUGIN_FORBIDDEN.some((f) => specifier === f || specifier.startsWith(`${f}/`))) {
        violations.push({ file, specifier, rule: "plugin-host-import" });
      }
    }
  }
  return violations;
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "server-dist") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(dir);
  return files;
}

describe("服务依赖边界（任务 2.3）", () => {
  it("服务不互相 import 实现目录", () => {
    const offenders: Violation[] = [];
    for (const [service, forbidden] of Object.entries(SERVICE_IMPLEMENTATION_PREFIXES)) {
      const dir = path.join(WEB_ROOT, service, "src");
      for (const file of collectSourceFiles(dir)) {
        const source = readFileSync(file, "utf8");
        for (const specifier of extractSpecifiers(source)) {
          for (const prefix of forbidden) {
            if (specifier === prefix || specifier.startsWith(`${prefix}/`)) {
              offenders.push({ file: path.relative(WEB_ROOT, file), specifier, rule: "service-cross-import" });
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("contracts 不含副作用/服务端实现依赖", () => {
    const offenders: Violation[] = [];
    for (const file of collectSourceFiles(path.join(WEB_ROOT, "contracts", "src"))) {
      const source = readFileSync(file, "utf8");
      for (const specifier of extractSpecifiers(source)) {
        if (CONTRACTS_FORBIDDEN.some((f) => specifier === f || specifier.startsWith(`${f}/`))) {
          offenders.push({ file: path.relative(WEB_ROOT, file), specifier, rule: "contracts-side-effect" });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("frontend 不引用 Node-only 模块与服务实现", () => {
    const offenders: Violation[] = [];
    for (const file of collectSourceFiles(path.join(WEB_ROOT, "frontend", "src"))) {
      const source = readFileSync(file, "utf8");
      for (const specifier of extractSpecifiers(source)) {
        if (FRONTEND_FORBIDDEN.some((f) => specifier === f || specifier.startsWith(`${f}/`))) {
          offenders.push({ file: path.relative(WEB_ROOT, file), specifier, rule: "frontend-node-only" });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("frontend 不 import 服务端实现或组合根", () => {
    const offenders: Violation[] = [];
    for (const file of collectSourceFiles(path.join(WEB_ROOT, "frontend", "src"))) {
      const source = readFileSync(file, "utf8");
      for (const specifier of extractSpecifiers(source)) {
        const relative = path.relative(WEB_ROOT, file);
        // 浏览器代码不得引用服务端目录（相对或裸路径形式）。
        if (specifier.includes("apps/site") || specifier.includes("/server/")) {
          offenders.push({ file: relative, specifier, rule: "frontend-server-import" });
        }
      }
      // 也不得用相对路径跨到服务端组合根。
      if (/from\s*["'][^"']*\.\.\/[^"']*server\//.test(source)) {
        offenders.push({ file: path.relative(WEB_ROOT, file), specifier: "<relative>", rule: "frontend-server-import" });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("插件包不 import 宿主/领域服务实现（只依赖 contracts 与 shared）", () => {
    const offenders: Violation[] = [];
    for (const file of collectSourceFiles(path.join(WEB_ROOT, "plugins"))) {
      const source = readFileSync(file, "utf8");
      for (const specifier of extractSpecifiers(source)) {
        if (PLUGIN_FORBIDDEN.some((f) => specifier === f || specifier.startsWith(`${f}/`))) {
          offenders.push({ file: path.relative(WEB_ROOT, file), specifier, rule: "plugin-host-import" });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("backend 组合根可 import 各领域模块；领域模块不得 import backend", () => {
    // 反向依赖：领域模块不得 import backend。
    const offenders: Violation[] = [];
    for (const [service, forbidden] of Object.entries(SERVICE_IMPLEMENTATION_PREFIXES)) {
      const dir = path.join(WEB_ROOT, "services", service, "src");
      for (const file of collectSourceFiles(dir)) {
        const source = readFileSync(file, "utf8");
        for (const specifier of extractSpecifiers(source)) {
          for (const prefix of forbidden) {
            if (prefix === "@woohaa3/backend" && (specifier === prefix || specifier.startsWith(`${prefix}/`))) {
              offenders.push({ file: path.relative(WEB_ROOT, file), specifier, rule: "module-imports-backend" });
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);
    // 正向：backend 组合根确实组合各领域模块。
    const composition = readFileSync(path.join(WEB_ROOT, "backend", "src", "composition.ts"), "utf8");
    for (const pkg of ["@woohaa3/canvas-service", "@woohaa3/task-service", "@woohaa3/media-service", "@woohaa3/mcp-service", "@woohaa3/application-service"]) {
      expect(composition).toContain(pkg);
    }
  });

  it("backend 组合根不使用服务间网络 client（进程内契约）", () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(path.join(WEB_ROOT, "backend", "src"))) {
      const source = readFileSync(file, "utf8");
      for (const needle of [
        "createCanvasTaskClient",
        "createCanvasMediaClient",
        "createCanvasMcpClient",
        "createAgentCanvasClient",
        "buildInternalHeaders",
        "x-woohaa3-service-token"
      ]) {
        if (source.includes(needle)) offenders.push(`${path.relative(WEB_ROOT, file)}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("故意违规 fixture 会被门禁检出（证明守卫有效）", () => {
    expect(
      scanForViolations({ service: "task-service", source: `import { x } from "@woohaa3/canvas-service";` })
    ).toEqual([{ file: "task-service", specifier: "@woohaa3/canvas-service", rule: "service-cross-import" }]);
    expect(
      scanForViolations({ service: "application-service", source: `import { x } from "@woohaa3/task-service";` })
    ).toEqual([{ file: "application-service", specifier: "@woohaa3/task-service", rule: "service-cross-import" }]);
    expect(
      scanForViolations({ service: "contracts", source: `import "cos-nodejs-sdk-v5";` })
    ).toEqual([{ file: "contracts", specifier: "cos-nodejs-sdk-v5", rule: "contracts-side-effect" }]);
    expect(
      scanForViolations({ service: "frontend", source: `import fs from "node:fs";` })
    ).toEqual([{ file: "frontend", specifier: "node:fs", rule: "frontend-node-only" }]);
    expect(
      scanForViolations({ service: "plugins", source: `import { host } from "@woohaa3/application-service";` })
    ).toEqual([{ file: "plugins", specifier: "@woohaa3/application-service", rule: "plugin-host-import" }]);
    // 合法情况不误报。
    expect(scanForViolations({ service: "task-service", source: `import { x } from "@woohaa3/contracts";` })).toEqual([]);
    expect(scanForViolations({ service: "plugins", source: `import { x } from "@woohaa3/contracts";` })).toEqual([]);
    expect(scanForViolations({ service: "plugins", source: `import { x } from "./shared.js";` })).toEqual([]);
    // 领域模块 import backend 被检出。
    expect(
      scanForViolations({ service: "task-service", source: `import { x } from "@woohaa3/backend";` })
    ).toEqual([{ file: "task-service", specifier: "@woohaa3/backend", rule: "service-cross-import" }]);
  });
});

/** 包根目录（相对 web/）→ 包名；用于“内部模块不得反向 import 自身 barrel”。 */
const PACKAGE_NAMES: Record<string, string> = {
  contracts: "@woohaa3/contracts",
  "services/canvas-service": "@woohaa3/canvas-service",
  "services/task-service": "@woohaa3/task-service",
  "services/media-service": "@woohaa3/media-service",
  "services/mcp-service": "@woohaa3/mcp-service",
  "services/application-service": "@woohaa3/application-service",
  frontend: "@woohaa3/frontend",
  backend: "@woohaa3/backend"
};

describe("模块边界补充守卫（change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，任务 1.4）", () => {
  it("包内模块不通过包名反向 import 自身 barrel（避免循环与隐藏实现）", () => {
    const offenders: Violation[] = [];
    for (const [dir, pkgName] of Object.entries(PACKAGE_NAMES)) {
      const pkgRoot = path.join(WEB_ROOT, dir, "src");
      for (const file of collectSourceFiles(pkgRoot)) {
        const relative = path.relative(pkgRoot, file);
        // 入口 barrel 自身导出各子模块，不算反向依赖。
        if (relative === "index.ts" || relative === "index.tsx") continue;
        const source = readFileSync(file, "utf8");
        for (const specifier of extractSpecifiers(source)) {
          if (specifier === pkgName) {
            offenders.push({ file: path.relative(WEB_ROOT, file), specifier, rule: "internal-imports-own-barrel" });
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("contracts 源码不含运行时 Node import（browser-safe）", () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(path.join(WEB_ROOT, "contracts", "src"))) {
      const source = readFileSync(file, "utf8");
      // 只拦静态 import/export 的 `node:` 运行时依赖；类型位置的 `import("node:http")`
      // 引用（如 ports.ts 的 handler 签名）在打包时被擦除，不属于浏览器运行时依赖。
      const runtimeNodeImport = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s*["']node:[^"']+["']/;
      if (runtimeNodeImport.test(source)) {
        offenders.push(path.relative(WEB_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
