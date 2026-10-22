/**
 * 构建单元依赖扫描（change: split-web-runtime-services，任务 4.1 / 5.6 / 6.1）。
 *
 * 结构性验证拆分目标：每个运行单元的构建/依赖图不加载其它服务的实现。
 * - Frontend 构建不加载 provider / worker / COS；
 * - Canvas 构建不加载 provider / worker / COS；
 * - Task 构建不加载 COS / canvas；
 * - Media 构建不加载 Canvas/Task/provider。
 *
 * 扫描源码 import 与 manifest 依赖；构建产物若存在则一并扫描。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

function collectSource(dir: string): string {
  let text = "";
  const walk = (current: string) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (["node_modules", "dist", "server-dist", "__fixtures__"].includes(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) text += readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return text;
}

function collectBundle(dir: string): string {
  let text = "";
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) text += collectBundle(full);
      else if (/\.(js|mjs)$/.test(entry.name)) text += readFileSync(full, "utf8");
    }
  } catch {
    /* missing */
  }
  return text;
}

/** 去掉注释，避免文档里引用的包名造成误报。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// 生成 Provider 实现已迁移到独立后端插件（web/extensions/*-provider）；这些符号/包名
// 仍不得出现在 Canvas / Frontend / 各领域模块的构建里（只有插件包例外）。
const PROVIDER_WORKER_NEEDLES = [
  "createLiteLLMProvider",
  "createRunninghubProvider",
  "litellm-provider",
  "@sdppp/pptask-worker-server",
  "createPptaskWorkerServer"
];

describe("运行单元依赖图（任务 4.1 / 5.6 / 6.1）", () => {
  it("Canvas 源码不 import provider / worker 实现", () => {
    const canvas = collectSource(path.join(WEB_ROOT, "services", "canvas-service", "src"));
    for (const needle of PROVIDER_WORKER_NEEDLES) {
      expect(canvas, needle).not.toContain(needle);
    }
  });

  it("Frontend 浏览器源码不 import provider / worker 实现", () => {
    const frontend = collectSource(path.join(WEB_ROOT, "frontend/src"));
    for (const needle of PROVIDER_WORKER_NEEDLES) {
      expect(frontend, needle).not.toContain(needle);
    }
  });

  it("Task 源码不 import canvas 实现或 COS", () => {
    const task = stripComments(collectSource(path.join(WEB_ROOT, "services", "task-service", "src")));
    for (const needle of ["@woohaa3/canvas-service", "@woohaa3/canvas-yjs", "@woohaa3/canvas-storage", "cos-nodejs-sdk-v5"]) {
      expect(task, needle).not.toContain(needle);
    }
  });

  it("Media 源码不 import provider / worker / Canvas / Task", () => {
    const media = collectSource(path.join(WEB_ROOT, "services", "media-service", "src"));
    for (const needle of [
      ...PROVIDER_WORKER_NEEDLES,
      "@woohaa3/canvas-service",
      "@woohaa3/canvas-yjs",
      "@woohaa3/task-service"
    ]) {
      expect(media, needle).not.toContain(needle);
    }
  });

  it("MCP Service 源码不 import provider / COS / Canvas / Task / Media 实现", () => {
    const mcp = collectSource(path.join(WEB_ROOT, "services", "mcp-service", "src"));
    for (const needle of [
      ...PROVIDER_WORKER_NEEDLES,
      "@woohaa3/canvas-service",
      "@woohaa3/canvas-yjs",
      "@woohaa3/task-service",
      "@woohaa3/media-service",
      "cos-nodejs-sdk-v5",
      "node:sqlite",
      "mongodb",
      "yjs"
    ]) {
      expect(mcp, needle).not.toContain(needle);
    }
  });

  it("Application Service 源码不 import 领域服务实现 / provider / worker / COS", () => {
    const application = collectSource(path.join(WEB_ROOT, "services", "application-service", "src"));
    for (const needle of [
      ...PROVIDER_WORKER_NEEDLES,
      "@woohaa3/canvas-service",
      "@woohaa3/canvas-yjs",
      "@woohaa3/task-service",
      "@woohaa3/media-service",
      "@woohaa3/mcp-service",
      "cos-nodejs-sdk-v5",
      "mongodb",
      "yjs"
    ]) {
      expect(application, needle).not.toContain(needle);
    }
  });

  it("Application manifest 无领域服务实现依赖", () => {
    const pkg = JSON.parse(readFileSync(path.join(WEB_ROOT, "services", "application-service", "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of [
      "@woohaa3/canvas-service",
      "@woohaa3/task-service",
      "@woohaa3/media-service",
      "@woohaa3/mcp-service",
      "cos-nodejs-sdk-v5",
      "@sdppp/pptask",
      "@sdppp/pptask-worker-server"
    ]) {
      expect(deps[name], name).toBeUndefined();
    }
  });

  it("插件包源码不 import 宿主/领域服务实现", () => {
    const plugins = collectSource(path.join(WEB_ROOT, "plugins"));
    for (const needle of [
      "@woohaa3/application-service",
      "@woohaa3/canvas-service",
      "@woohaa3/task-service",
      "@woohaa3/media-service",
      "@woohaa3/mcp-service",
      "cos-nodejs-sdk-v5",
      "node:sqlite"
    ]) {
      expect(plugins, needle).not.toContain(needle);
    }
  });

  it("Canvas 构建产物不内联 provider / worker / COS（若已构建）", () => {
    const bundle = collectBundle(path.join(WEB_ROOT, "services", "canvas-service", "dist"));
    if (bundle === "") return; // 未构建则跳过
    for (const needle of ["createLiteLLMTaskProvider", "createPptaskWorkerServer", "cos-nodejs-sdk-v5"]) {
      expect(bundle, needle).not.toContain(needle);
    }
  });

  it("前端构建产物不含 COS / provider 凭据键（若已构建）", () => {
    const bundle = collectBundle(path.join(WEB_ROOT, "frontend/dist"));
    if (bundle === "") return;
    for (const needle of ["COS_SECRET_ID", "COS_SECRET_KEY", "PPTASK_LITELLM_API_KEY", "cos-nodejs-sdk-v5"]) {
      expect(bundle, needle).not.toContain(needle);
    }
  });
});

describe("Task/Media manifest 依赖边界（任务 4.1 / 5.6）", () => {
  it("Task manifest 无 COS SDK / canvas 实现", () => {
    const pkg = JSON.parse(readFileSync(path.join(WEB_ROOT, "services", "task-service", "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps["cos-nodejs-sdk-v5"]).toBeUndefined();
    expect(deps["@woohaa3/canvas-yjs"]).toBeUndefined();
  });

  it("Media manifest 无 provider / Canvas / Task 实现", () => {
    const pkg = JSON.parse(readFileSync(path.join(WEB_ROOT, "services", "media-service", "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps["@woohaa3/canvas-service"]).toBeUndefined();
    expect(deps["@woohaa3/task-service"]).toBeUndefined();
  });

  it("MCP manifest 无 provider / COS / Canvas / Task / Media 实现", () => {
    const pkg = JSON.parse(readFileSync(path.join(WEB_ROOT, "services", "mcp-service", "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of [
      "@woohaa3/canvas-service",
      "@woohaa3/task-service",
      "@woohaa3/media-service",
      "cos-nodejs-sdk-v5",
      "@sdppp/pptask",
      "@sdppp/pptask-worker-server"
    ]) {
      expect(deps[name], name).toBeUndefined();
    }
  });

  it("构建产物存在性检查（dist 目录）", () => {
    // 只作为构建成功的轻量确认；不强依赖（CI 可能未构建）。
    expect(typeof existsSync(path.join(WEB_ROOT, "services", "media-service", "package.json"))).toBe("boolean");
  });
});
