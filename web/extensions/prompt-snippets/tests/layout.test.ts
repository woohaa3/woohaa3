/**
 * 提示词片段 dialog 样式约束（change: add-prompt-snippet-library，任务 4.5）。
 *
 * 静态断言样式表包含片段库/编辑器布局类，避免窄屏溢出与长名称/长标签换行。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../src/frontend/style.css", import.meta.url)), "utf8");

describe("片段 dialog 样式约束", () => {
  it("片段列表与编辑器类齐全", () => {
    for (const cls of [
      ".snippet-library__views",
      ".snippet-library__filters",
      ".snippet-library__list",
      ".snippet-library__item",
      ".snippet-library__tags",
      ".snippet-editor__field",
      ".snippet-editor__materials",
      ".snippet-library__hint"
    ]) {
      expect(css, cls).toContain(cls);
    }
  });

  it("长名称/长标签允许换行（overflow-wrap）", () => {
    expect(css).toMatch(/\.snippet-library__name[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/\.snippet-editor__material[^}]*overflow-wrap: anywhere/);
  });

  it("标签行允许换行，窄屏不重叠", () => {
    expect(css).toMatch(/\.snippet-library__filters[^}]*flex-wrap: wrap/);
    expect(css).toMatch(/\.snippet-library__tags li[^}]*flex-wrap: wrap/);
  });
});
