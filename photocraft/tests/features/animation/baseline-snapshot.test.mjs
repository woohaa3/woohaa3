/**
 * U77 域快照等价（change: 2026-10-22-add-photocraft-animation-workflows）。
 *
 * 单文件、单实例：内容 hash 里带图层 id，而 id 计数器在同一进程内跨实例递增，因此这些
 * 逐字节断言必须与其它用例隔离（node:test 每个文件一个子进程）。
 *
 * 断言：重构前的 8 组内容/状态快照、内容 hash、修订、工程长度与 PNG 字节仍完全一致 ——
 * 本域只做增量命令，不改变任何既有行为。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..", "..", "..");
const wasmDir = join(packageRoot, "packages", "editor", "dist", "wasm");
const glue = join(wasmDir, "photocraft_editor.js");
const binary = join(wasmDir, "photocraft_editor_bg.wasm");
const built = existsSync(glue) && existsSync(binary);

let module;
async function editor() {
  module ??= await import(pathToFileURL(glue));
  module.initSync({ module: readFileSync(binary) });
  return new module.WasmEditor();
}

test("8 组内容/状态快照与 PNG 字节仍与重构基线相同（本域不改变既有行为）", { skip: built ? false : "未构建 WASM 产物（先运行 pnpm -C photocraft run wasm）" }, async () => {
  const baseline = JSON.parse(readFileSync(join(packageRoot, "notes", "feature-boundary-wasm-baseline.json"), "utf8"));
  const wasm = await editor();
  try {
    const steps = [];
    const capture = (name) => steps.push({ name, hash: wasm.contentHash(), state: JSON.parse(wasm.stateJson()) });
    wasm.execute("file.new", JSON.stringify({ width: 32, height: 24, name: "Boundary baseline" }));
    capture("new");
    wasm.execute("select.rect", JSON.stringify({ x: 2, y: 3, width: 10, height: 8, mode: "replace" }));
    capture("selection");
    wasm.execute("layer.new.layer", JSON.stringify({ name: "paint" }));
    capture("layer");
    wasm.execute("paint.stroke", JSON.stringify({
      points: [[4, 5], [7, 9]], size: 3, hardness: 1, opacity: 1, flow: 1, color: "#ff0000", target: "pixels"
    }));
    capture("stroke");
    wasm.undo();
    capture("undo");
    wasm.redo();
    capture("redo");
    wasm.beginSelectionModify(JSON.stringify({ operation: "expand", radius: 2 }));
    wasm.cancelSelectionModify();
    capture("cancel-selection");
    const before = wasm.contentHash();
    wasm.beginFilter("filter.blur.gaussianBlur", JSON.stringify({ radius: 2 }));
    wasm.cancelFilter();
    capture("cancel-filter");
    assert.equal(wasm.contentHash(), before, "取消滤镜不得改变内容");
    assert.deepEqual(steps, baseline.steps);

    const bundle = wasm.exportBundle();
    const output = {
      hash: bundle.documentContentHash,
      revision: bundle.revision,
      projectLength: bundle.project.length,
      png: crypto.createHash("sha256").update(bundle.output).digest("hex")
    };
    bundle.free();
    assert.deepEqual(output, baseline.output);
  } finally {
    wasm.free();
  }
});
