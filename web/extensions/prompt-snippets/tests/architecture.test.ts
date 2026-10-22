/**
 * Prompt Snippets 架构边界审计
 * （change: add-prompt-snippet-library，任务 2.2 / 6.2）。
 *
 * 静态保证：
 * - Plugin/UI 不直接 fetch、不创建 WebSocket、不拼 Canvas/Media API path；
 * - 不 import Task Execution 内部 mutable singleton（nodeDraftStore / 内部 hook）；
 * - 不新增 document-level keydown/overlay listener；
 * - 不把目录写入 Y.Doc（不 import yjs）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../src/frontend", import.meta.url));

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

describe("Prompt Snippets 架构审计", () => {
  it("不直接 fetch、不创建 WebSocket、不拼 Canvas/Media API path", () => {
    for (const { file, source } of productionSources()) {
      expect(source, file).not.toMatch(/\bfetch\s*\(/);
      expect(source, file).not.toMatch(/\bnew WebSocket\b/);
      expect(source, file).not.toMatch(/["'`]\/api\//);
    }
  });

  it("不 import Task Execution 的 mutable store 或内部 hook", () => {
    for (const { file, source } of productionSources()) {
      expect(source, file).not.toContain("nodeDraftStore");
      expect(source, file).not.toContain("use-task-state");
      expect(source, file).not.toMatch(/node-execution-panel/);
    }
  });

  it("不新增 document-level keydown 或 overlay listener", () => {
    for (const { file, source } of productionSources()) {
      expect(source, file).not.toMatch(/document\.addEventListener/);
      expect(source, file).not.toMatch(/globalThis\.addEventListener/);
    }
  });

  it("目录不写入 Y.Doc（不 import yjs，不直接 transact）", () => {
    for (const { file, source } of productionSources()) {
      expect(source, file).not.toMatch(/from\s+["']yjs["']/);
      expect(source, file).not.toMatch(/\bY\.Doc\b/);
    }
  });
});
