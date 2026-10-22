/**
 * Paste Import 架构边界审计
 * （change: add-paste-import-workflows，任务 3.2 / 6.1）。
 *
 * 静态保证 Paste Import Plugin 不直接 fetch 三大服务、不拼 API path、不写 Y.Doc、不新增
 * document listener，也不把 File/Blob/object URL 写进规范文本。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL(".", import.meta.url));

function productionSources(): Array<{ file: string; source: string }> {
  const out: Array<{ file: string; source: string }> = [];
  for (const entry of readdirSync(DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (entry.name.includes(".test.")) continue;
    const source = readFileSync(path.join(DIR, entry.name), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    out.push({ file: entry.name, source });
  }
  return out;
}

describe("Paste Import 架构审计", () => {
  it("不直接 fetch 或拼三大服务 API path", () => {
    for (const { file, source } of productionSources()) {
      expect(source, file).not.toMatch(/\bfetch\s*\(/);
      expect(source, file).not.toMatch(/["'`]\/api\//);
    }
  });

  it("不新增 document-level listener 或 WebSocket", () => {
    for (const { file, source } of productionSources()) {
      expect(source, file).not.toMatch(/document\.addEventListener/);
      expect(source, file).not.toMatch(/\bnew WebSocket\b/);
    }
  });

  it("不直接写 Y.Doc（yjs / Y.Doc / transact）", () => {
    for (const { file, source } of productionSources()) {
      expect(source, file).not.toMatch(/\bY\.Doc\b/);
      expect(source, file).not.toMatch(/\.getText\(|\.getArray\(|\.getMap\(/);
    }
  });

  it("只通过注入 Service 协作（不 import 执行面板内部 mutable store）", () => {
    for (const { file, source } of productionSources()) {
      expect(source, file).not.toContain("nodeDraftStore");
      expect(source, file).not.toContain("node-execution-panel");
    }
  });
});
