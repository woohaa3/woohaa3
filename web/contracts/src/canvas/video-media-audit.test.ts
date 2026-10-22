/**
 * canonical state / task history 临时媒体表示静态审计
 * （change: port-video-editing-dialogs，任务 6.2；design D6）。
 *
 * 扫描源码与序列化 fixtures，确认 canonical state（Y.Doc / nodeData）与 task history
 * 不包含 `data:` / `blob:` / 临时签名 URL（`?sign=`）或 Blob 字段。
 *
 * 允许例外：仅在打开的 dialog session、上传前校验、或工具/测试的负向断言中出现的
 * 模式（例如 `isAllowedMediaUrl` 拒绝 `blob:`）。因此这里只断言**规范契约模块**与
 * **fixtures**，不做全仓粗扫，避免把防御性拒绝代码误报为泄漏。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CONTRACTS_SRC = fileURLToPath(new URL("../", import.meta.url));

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

function walk(dir: string, match: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, match));
    else if (match.test(entry.name)) out.push(full);
  }
  return out;
}

/** 去掉注释（解释性提及不应触发误报）。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const CANONICAL_MODULES = [
  "canvas/domain/normalization.ts",
  "canvas/domain/runtime-node-data.ts",
  "canvas/command-reducer.ts",
  "canvas/command-reducer/node-data-validation.ts",
  "canvas/command-reducer/node-commands.ts",
  "canvas/command-reducer/edit-command.ts",
  "canvas/domain/types.ts",
  "task/history.ts",
  "video/video-edit.ts"
];

describe("canonical / history 无临时媒体表示", () => {
  it("规范契约模块不把 data URL / blob URL / Blob 作为持久化值写出", () => {
    for (const relative of CANONICAL_MODULES) {
      const file = path.join(CONTRACTS_SRC, relative);
      const source = stripComments(readFileSync(file, "utf8"));
      // 允许出现 `data:` / `blob:` 作为**拒绝**模式（startsWith / 判定）；
      // 不允许把它们写进赋值或作为默认值。这里检查危险写入模式。
      expect(source, `${relative} 不应把 data URL 写入规范值`).not.toMatch(/=\s*["'`]data:/);
      expect(source, `${relative} 不应把 blob URL 写入规范值`).not.toMatch(/=\s*["'`]blob:/);
      // 不允许 Blob 类型进入 canonical 契约。
      expect(source, `${relative} 不应在 canonical 契约中引用 Blob 类型`).not.toMatch(/\bBlob\b/);
    }
  });

  it("序列化 fixtures 不含 data/blob/sign/Blob 字段", () => {
    const fixtures = walk(path.join(CONTRACTS_SRC, "canvas"), /\.(json|ts)$/).filter(
      (file) => file.includes("__fixtures__")
    );
    expect(fixtures.length).toBeGreaterThan(0);
    for (const file of fixtures) {
      const source = readFileSync(file, "utf8");
      for (const needle of ["data:image", "blob:", "?sign=", "annotationImageDataUrl", '"bytes"']) {
        expect(source, `${path.relative(CONTRACTS_SRC, file)} 不应包含 ${needle}`).not.toContain(needle);
      }
    }
  });

  it("video-edit 契约模块显式拒绝危险 preview 表示", () => {
    const source = stripComments(readFileSync(path.join(CONTRACTS_SRC, "video/video-edit.ts"), "utf8"));
    // 防御性拒绝必须存在（否则上面的“不写入”前提没有保障）。
    expect(source).toContain("isValidStorageKey");
    expect(source).toMatch(/startsWith\(["']data:/);
    expect(source).toMatch(/startsWith\(["']blob:/);
  });
});
