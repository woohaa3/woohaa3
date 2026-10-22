/**
 * 环境 schema 边界（change: split-web-runtime-services，任务 2.4；
 * change: 2026-10-16-add-storage-extension-point 后按「谁拥有哪个存储后端」划域）。
 *
 * 结构性守卫：每个服务只读取自己的配置域。
 * - Canvas：数据库与 Yjs 配置；
 * - Task：provider/worker 配置；
 * - Media：不再持有任何对象存储凭据（存储由宿主经 `ctx.storage` 注入）；
 * - 扩展层 `cos-storage` 后端插件独占 `COS_*`。
 *
 * 扫描各服务 `.env.example` 与源码中的 env 读取，确保没有跨域凭据泄漏。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

const COS_KEYS = ["COS_SECRET_ID", "COS_SECRET_KEY", "COS_BUCKET_NAME", "COS_BUCKET_URL", "COS_PREFIX"];
const PROVIDER_KEYS = ["PPTASK_LITELLM_API_KEY", "PPTASK_LITELLM_BASE_URL"];

/** COS 凭据现在只属于扩展层的 cos-storage 后端插件。 */
const COS_STORAGE_DIR = path.join(WEB_ROOT, "extensions", "cos-storage");

function readEnvExample(service: string): string {
  return readFileSync(path.join(WEB_ROOT, "services", service, ".env.example"), "utf8");
}

/** 三个运行单元的源码目录（顶层 `services/` 下的独立单元）。 */
function serviceSrc(service: string): string {
  return path.join(WEB_ROOT, "services", service, "src");
}

function collectSource(dir: string): string {
  let text = "";
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "server-dist") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) text += collectSource(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) text += readFileSync(full, "utf8");
    }
  } catch {
    /* missing dir */
  }
  return text;
}

describe("服务配置域边界（任务 2.4）", () => {
  it("cos-storage 后端插件独占 COS_*（旧环境变量经 legacyEnv 兼容），并声明 COS SDK", () => {
    const source = collectSource(COS_STORAGE_DIR);
    for (const key of COS_KEYS) expect(source, key).toContain(key);
    const pkg = JSON.parse(readFileSync(path.join(COS_STORAGE_DIR, "package.json"), "utf8"));
    expect(pkg.dependencies["cos-nodejs-sdk-v5"]).toBeTruthy();
  });

  it("媒体与其它领域服务不读取 COS_*", () => {
    for (const service of ["canvas-service", "task-service", "media-service", "mcp-service"]) {
      const source = collectSource(serviceSrc(service));
      for (const key of COS_KEYS) expect(source, `${service} -> ${key}`).not.toContain(key);
      const env = readEnvExample(service);
      for (const key of COS_KEYS) expect(env, `${service} .env -> ${key}`).not.toContain(key);
    }
  });

  it("Canvas 与 Media 不读取 provider 凭据", () => {
    for (const service of ["canvas-service", "media-service"]) {
      const source = collectSource(serviceSrc(service));
      for (const key of PROVIDER_KEYS) expect(source, `${service} -> ${key}`).not.toContain(key);
    }
  });

  it("MCP Service 不读取 COS 或 provider 凭据", () => {
    for (const service of ["mcp-service"]) {
      const source = collectSource(serviceSrc(service));
      for (const key of [...COS_KEYS, ...PROVIDER_KEYS]) {
        expect(source, `${service} -> ${key}`).not.toContain(key);
      }
      const env = readEnvExample(service);
      for (const key of [...COS_KEYS, ...PROVIDER_KEYS]) expect(env, `${service} .env -> ${key}`).not.toContain(key);
    }
  });

  it("Task 通过扩展注册消费 Provider，不读取其凭据", () => {
    const source = collectSource(path.join(WEB_ROOT, "services", "task-service", "src"));
    for (const key of PROVIDER_KEYS) expect(source, key).not.toContain(key);
    expect(source).toContain("generationProviders");
    const provider = collectSource(path.join(WEB_ROOT, "extensions", "ark-provider", "src"));
    expect(provider).toContain("ctx.generation.register(");
    // 没有「列举模型」的环境变量：模型集合来自 models-config 文件。
    expect(source).not.toMatch(/process\.env\.PPTASK_MODELS/);
  });

  it("前端/服务端都不使用 VITE_* 承载服务凭据", () => {
    for (const service of ["canvas-service", "task-service", "media-service"]) {
      const source = collectSource(serviceSrc(service));
      expect(source).not.toMatch(/VITE_PPTASK|VITE_COS/);
    }
  });
});
