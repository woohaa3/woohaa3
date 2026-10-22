/**
 * Pending/working 不落盘守卫（change: add-frontend-speculative-canvas-state，任务 2.4 / design D10）。
 *
 * working projection 与 pending batch 只能存在于内存：不得写 IndexedDB、localStorage、
 * sessionStorage 或本地 Y.Doc。本测试对实现源码做结构性扫描，防止后续无意引入持久化。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const files = [
  "working-projection.ts"
];

describe("pending/working 不落盘（任务 2.4）", () => {
  it("working-projection 源码不引用任何持久化 API", () => {
    const forbidden = ["localStorage", "sessionStorage", "indexedDB", "IDBFactory", "Y.applyUpdate", "new Y.Doc"];
    for (const file of files) {
      // 去掉注释，避免文档里的「禁止概念」文本误报（与 storage 依赖边界测试同一做法）。
      const source = readFileSync(resolve(here, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const needle of forbidden) {
        expect(source, `${file} 不应出现 ${needle}`).not.toContain(needle);
      }
    }
  });
});
