/**
 * 凭据与业务数据边界扫描（change: split-web-runtime-services，任务 7.4；
 * change: 2026-10-16-add-storage-extension-point 后 COS SDK 归扩展层 cos-storage）。
 *
 * 扫描各服务的依赖树与源码，确认：
 * - Frontend/Canvas/Task/Media 无 COS 凭据或 COS SDK（只有扩展层 cos-storage 后端插件可以有）；
 * - Frontend/Canvas 无 provider 凭据；
 * - Media 不 import Canvas/Task 业务实现。
 *
 * 纯静态扫描，不需要构建产物或运行环境。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

function manifest(relative: string): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(WEB_ROOT, relative), "utf8"));
}

function sourceText(service: string): string {
  let text = "";
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (["node_modules", "dist", "server-dist"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // 只扫描生产源码：测试会把禁止的 needle 写成断言文本，不是真的依赖。
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) text += readFileSync(full, "utf8");
    }
  };
  walk(path.join(WEB_ROOT, "services", service, "src"));
  return text;
}

describe("凭据与业务数据边界（任务 7.4）", () => {
  it("运行单元（frontend 与各领域服务）的 manifest 不声明 COS SDK", () => {
    // 存储是扩展点：只有扩展层 cos-storage 后端插件可持有 COS SDK。
    for (const service of ["frontend", "canvas-service", "task-service", "media-service", "mcp-service", "application-service"]) {
      let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      try {
        pkg = manifest(path.join(service, "package.json"));
      } catch {
        continue; // 目录尚未建立
      }
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      expect(deps["cos-nodejs-sdk-v5"], service).toBeUndefined();
    }
    const cosStorage = manifest(path.join("extensions", "cos-storage", "package.json"));
    expect(cosStorage.dependencies?.["cos-nodejs-sdk-v5"]).toBeTruthy();
  });

  it("Canvas 源码不出现 COS 凭据或 provider 凭据", () => {
    const canvas = sourceText("canvas-service");
    for (const needle of ["COS_SECRET_ID", "COS_SECRET_KEY", "COS_BUCKET", "PPTASK_LITELLM_API_KEY", "createCosMediaStorage", "cos-nodejs-sdk-v5"]) {
      expect(canvas, needle).not.toContain(needle);
    }
  });

  it("Task 源码不出现 COS 凭据", () => {
    const task = sourceText("task-service");
    for (const needle of ["COS_SECRET_ID", "COS_SECRET_KEY", "COS_BUCKET_URL", "cos-nodejs-sdk-v5"]) {
      expect(task, needle).not.toContain(needle);
    }
  });

  it("Media 不 import Canvas/Task 业务实现", () => {
    const media = sourceText("media-service");
    for (const needle of ["@woohaa3/canvas-service", "@woohaa3/task-service", "@woohaa3/canvas-yjs", "@woohaa3/canvas-storage"]) {
      expect(media, needle).not.toContain(needle);
    }
  });

  it("统一 backend 组合根不直接持有 COS / provider 凭据", () => {
    // 组合根只 import 存储后端插件（扩展层）；凭据只在对应插件/领域模块内使用（代码级边界）。
    let text = "";
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) text += readFileSync(full, "utf8");
      }
    };
    walk(path.join(WEB_ROOT, "backend/src"));
    for (const needle of ["COS_SECRET_ID", "COS_SECRET_KEY", "COS_BUCKET_URL", "PPTASK_LITELLM_API_KEY", "ARK_VIDEO_API_KEY"]) {
      expect(text, needle).not.toContain(needle);
    }
  });

  it("Frontend 浏览器侧源码不出现 COS 凭据或 provider 凭据", () => {
    // 只扫描浏览器侧（`frontend/src`）：凭据只在服务端。
    const text = collectNonTestSource(path.join(WEB_ROOT, "frontend/src"));
    // 排除测试文件：它们为了断言“可读的阻止原因”会引用配置键名，不是凭据。
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const needle of ["COS_SECRET_ID", "COS_SECRET_KEY", "COS_BUCKET_URL", "cos-nodejs-sdk-v5"]) {
      expect(stripped, needle).not.toContain(needle);
    }
    // provider 配置键名可能出现在测试断言里；只对非注释、非测试源码断言。
    const nonTest = collectNonTestSource(path.join(WEB_ROOT, "frontend/src"));
    expect(nonTest).not.toContain("PPTASK_LITELLM_API_KEY");
  });
});

/** 只收集非测试源码。 */
function collectNonTestSource(dir: string): string {
  let text = "";
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) text += collectNonTestSource(full);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) text += readFileSync(full, "utf8");
  }
  return text;
}
