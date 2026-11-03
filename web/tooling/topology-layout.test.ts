/**
 * 统一后端运行单元布局守卫
 * （change: 2026-10-06-unify-backend-runtime-with-cordis，任务 4.3）。
 *
 * 结构不变式：前端与**单一后端**两个交付物；后端进程内组合 Canvas/Task/Media/MCP 与站点
 * 插件宿主；领域模块彼此独立、不 import 彼此实现；插件两端实现位于 `plugins/<extensionId>/`。
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("统一后端运行单元布局", () => {
  it("前端与单一后端两个交付物存在", () => {
    expect(existsSync(path.join(WEB_ROOT, "frontend", "package.json"))).toBe(true);
    expect(existsSync(path.join(WEB_ROOT, "backend", "package.json"))).toBe(true);
    expect(existsSync(path.join(WEB_ROOT, "backend", "src", "server.ts"))).toBe(true);
    expect(existsSync(path.join(WEB_ROOT, "backend", "src", "composition.ts"))).toBe(true);
  });

  it("后端进程内组合各领域模块（领域模块仍各自自包含）", () => {
    for (const service of ["canvas-service", "task-service", "media-service", "mcp-service", "application-service"]) {
      const dir = path.join(WEB_ROOT, "services", service);
      expect(existsSync(path.join(dir, "package.json")), service).toBe(true);
      expect(existsSync(path.join(dir, "src", "composition.ts")), service).toBe(true);
    }
    // 组合根只启动 Context；各领域模块由插件树核心层的插件各自创建，进程内契约为类型化调用。
    const composition = readFileSync(path.join(WEB_ROOT, "backend", "src", "composition.ts"), "utf8");
    for (const layer of ["loadBaseLayer", "loadCoreLayer", "loadExtensionLayer"]) expect(composition).toContain(layer);
    const core = (file: string) => readFileSync(path.join(WEB_ROOT, "backend", "src", "host", "core", file), "utf8");
    for (const [file, name] of [
      ["canvas.ts", "createCanvasService"],
      ["task.ts", "createTaskService"],
      ["media.ts", "createMediaService"],
      ["mcp.ts", "createMcpService"],
      ["application.ts", "createApplicationService"]
    ] as const) {
      expect(core(file), file).toContain(name);
    }
  });

  it("站点插件宿主在后端 Cordis 运行时内，不在 Task 模块", () => {
    expect(existsSync(path.join(WEB_ROOT, "backend", "src", "runtime", "backend-runtime.ts"))).toBe(true);
    expect(existsSync(path.join(WEB_ROOT, "backend", "src", "extensions", "contract.ts"))).toBe(true);
    // Task 不拥有站点插件宿主/配置写 API。
    expect(existsSync(path.join(WEB_ROOT, "services", "task-service", "src", "extensions"))).toBe(false);
    expect(existsSync(path.join(WEB_ROOT, "services", "task-service", "src", "api", "extension-api.ts"))).toBe(false);
  });

  it("Task 只保留插件任务关联，不 import 插件后端包", () => {
    const index = readFileSync(path.join(WEB_ROOT, "services", "task-service", "src", "index.ts"), "utf8");
    expect(index).not.toContain("plugin-sample-site");
    expect(index).toContain("extension-task-association-repository");
    const pkg = JSON.parse(readFileSync(path.join(WEB_ROOT, "services", "task-service", "package.json"), "utf8"));
    expect(pkg.dependencies["@woohaa3/extension-sample-site"]).toBeUndefined();
  });

  it("插件包按 frontend/backend/shared 独立 exports", () => {
    const pkg = JSON.parse(readFileSync(path.join(WEB_ROOT, "test-fixtures", "sample-site-extension", "package.json"), "utf8"));
    expect(pkg.exports["./frontend"]).toBeTruthy();
    expect(pkg.exports["./backend"]).toBeTruthy();
    expect(pkg.exports["./shared"]).toBeTruthy();
    expect(pkg.exports["."]).toBeUndefined();
    expect(existsSync(path.join(WEB_ROOT, "test-fixtures", "sample-site-extension", "src", "frontend.ts"))).toBe(true);
    expect(existsSync(path.join(WEB_ROOT, "test-fixtures", "sample-site-extension", "src", "backend.ts"))).toBe(true);
  });

  it("pnpm 工作区登记 plugins/* 与 backend", () => {
    const workspace = readFileSync(path.join(WEB_ROOT, "pnpm-workspace.yaml"), "utf8");
    expect(workspace).toContain("extensions/*");
    expect(workspace).toContain("backend");
  });

  it("MCP Streamable HTTP 传输位于 mcp 模块，不在 canvas 模块", () => {
    expect(existsSync(path.join(WEB_ROOT, "services", "mcp-service", "src", "model-mcp", "mcp-http.ts"))).toBe(true);
    expect(existsSync(path.join(WEB_ROOT, "services", "canvas-service", "src", "model-mcp", "mcp-http.ts"))).toBe(false);
    expect(existsSync(path.join(WEB_ROOT, "services", "canvas-service", "src", "model-mcp", "service.ts"))).toBe(true);
  });

  it("MCP 依赖 @modelcontextprotocol，Canvas 不依赖它", () => {
    const mcp = JSON.parse(readFileSync(path.join(WEB_ROOT, "services", "mcp-service", "package.json"), "utf8"));
    expect(mcp.dependencies["@modelcontextprotocol/server"]).toBeTruthy();
    const canvas = JSON.parse(readFileSync(path.join(WEB_ROOT, "services", "canvas-service", "package.json"), "utf8"));
    expect(canvas.dependencies["@modelcontextprotocol/server"]).toBeUndefined();
  });
});
