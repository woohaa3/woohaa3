/**
 * 插件入口构建隔离测试
 * （change: 2026-10-05-extract-application-plugin-host，任务 1.4 / design D2）。
 *
 * 验证：样例插件的浏览器入口构建图只含 frontend/shared，Node 后端入口只含 backend/shared；
 * 两端运行时代码不互相加载，宿主类型导入在构建时消除。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, "..");

async function buildGraph(entry: string): Promise<string[]> {
  const result = await esbuild.build({
    entryPoints: [path.join(PLUGIN_DIR, "src", entry)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    metafile: true,
    external: ["@woohaa3/contracts"]
  });
  return Object.keys(result.metafile.inputs).map((file) => path.basename(file));
}

describe("插件入口构建隔离（任务 1.4）", () => {
  it("浏览器入口构建图只含 frontend/shared", async () => {
    const inputs = await buildGraph("frontend.ts");
    expect(inputs).toContain("frontend.ts");
    expect(inputs).toContain("shared.ts");
    expect(inputs).not.toContain("backend.ts");
  });

  it("Node 后端入口构建图只含 backend/shared", async () => {
    const inputs = await buildGraph("backend.ts");
    expect(inputs).toContain("backend.ts");
    expect(inputs).toContain("shared.ts");
    expect(inputs).not.toContain("frontend.ts");
  });

  it("shared 入口不含两端运行时实现", async () => {
    const inputs = await buildGraph("shared.ts");
    expect(inputs).toEqual(["shared.ts"]);
  });

  it("shared.ts 不导入任一端实现", () => {
    const source = readFileSync(path.join(PLUGIN_DIR, "src", "shared.ts"), "utf8");
    expect(source).not.toMatch(/from\s*["'].*frontend/);
    expect(source).not.toMatch(/from\s*["'].*backend/);
  });
});
