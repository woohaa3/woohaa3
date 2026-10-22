/**
 * 核心包依赖边界（任务 2.6）。
 *
 * 这条测试是**结构性守卫**：核心包不得依赖任何具体数据库驱动、COS SDK、HTTP 框架、
 * 浏览器运行时或 Yjs。一旦有人加了这类 import，构建产物会悄悄把依赖内联进来（或让
 * server-only 代码进入浏览器 bundle），因此用源码扫描 + 构建产物扫描双重拦截。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL("../../..", import.meta.url));

const FORBIDDEN_SPECIFIERS = [
  "node:sqlite",
  "node:fs",
  "node:path",
  "mongodb",
  "cos-nodejs-sdk-v5",
  "yjs",
  "y-protocols",
  "lib0",
  "react",
  "react-dom",
  "vite",
  "zustand"
];

const FORBIDDEN_SUBSTRINGS = [
  "GridFS",
  "gridfs",
  "BlobRepository",
  "canvas_asset_blobs",
  "state-vector",
  "stateVector",
  "checkpoint"
];

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__fixtures__") return [];
      return collectSourceFiles(full);
    }
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

/** 去掉注释，避免文档/说明里的「禁止概念」文本造成误报。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("核心 storage 包依赖边界（任务 2.6）", () => {
  // 只扫描会进入构建产物的生产源码；测试文件允许 import node:fs 等。
  const files = collectSourceFiles(SRC_DIR)
    .filter((file) => !/\.test\.ts$/.test(file));

  it("源码不 import 任何禁止的裸依赖", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const importPattern = /(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
      let match: RegExpExecArray | null;
      while ((match = importPattern.exec(source))) {
        const specifier = match[1] ?? match[2] ?? match[3];
        for (const forbidden of FORBIDDEN_SPECIFIERS) {
          if (specifier === forbidden || specifier.startsWith(`${forbidden}/`)) {
            offenders.push(`${path.relative(PACKAGE_DIR, file)} -> ${specifier}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("源码不出现 GridFS / BlobRepository / checkpoint 等禁止概念", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const needle of FORBIDDEN_SUBSTRINGS) {
        if (source.includes(needle)) offenders.push(`${path.relative(PACKAGE_DIR, file)} contains ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("core 只依赖 contracts（不反向依赖 canvas-service 的 sync/storage adapter）", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const importPattern = /(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"']+)["']/g;
      let match: RegExpExecArray | null;
      while ((match = importPattern.exec(source))) {
        const specifier = match[1];
        // 允许：其它 @woohaa3 包一律不允许（迁移后共享契约统一走 contracts）。
        if (specifier.startsWith("@woohaa3/") && specifier !== "@woohaa3/contracts") {
          offenders.push(`${path.relative(PACKAGE_DIR, file)} -> ${specifier}`);
        }
        if (specifier.includes("/storage/sqlite/") || specifier.includes("/storage/mongo/") || specifier.includes("/sync/")) {
          offenders.push(`${path.relative(PACKAGE_DIR, file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("canvas-service manifest 声明 domain 契约所需运行时依赖且无数据库/COS 直连泄漏", () => {
    const manifest = JSON.parse(readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8"));
    const deps = { ...(manifest.dependencies ?? {}) };
    // 迁移后 storage 核心并入 canvas-service：core 的契约经 @woohaa3/contracts。
    expect(deps["@woohaa3/contracts"]).toBeDefined();
    expect(deps["@woohaa3/canvas-domain"]).toBeUndefined();
    expect(deps["@woohaa3/media-storage"]).toBeUndefined();
  });

  it("构建产物不内联 COS SDK / GridFS（若已构建）", () => {
    const distPath = path.join(PACKAGE_DIR, "dist", "index.js");
    let exists = true;
    try {
      statSync(distPath);
    } catch {
      exists = false;
    }
    if (!exists) return;
    const bundle = readFileSync(distPath, "utf8");
    // 迁移后 canvas-service 单元同时承载 storage adapter 与 Yjs 运行时，因此
    // `node:sqlite` / `mongodb` 作为**声明依赖被 external**（保留为 import）是合法的；
    // 真正要禁止的是 COS SDK 与 GridFS 概念进入画布权威。
    for (const needle of ["cos-nodejs-sdk-v5", "new GridFSBucket", "gridfs-stream"]) {
      expect(bundle).not.toContain(needle);
    }
  });
});
