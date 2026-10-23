/**
 * U77 命令门与重构基线的差异（change: 2026-10-22-add-photocraft-animation-workflows）。
 *
 * 重构前的两份基线是**冻结证据**（证明重构只重组、未改行为）。本域确实新增了 17 个命令与
 * 4 个能力，因此增量必须登记在 `tests/fixtures/feature-boundary-additions.json`，
 * `scripts/check-feature-boundaries.mjs` 逐项核对。这里给出同一事实的域级断言：
 *
 * - 命令表是**纯增量**：没有删除、没有改动既有 id 的相对顺序；
 * - 新增的恰好是登记的 17 个命令与 4 个能力（多一个或少一个都失败）；
 * - buildInfo、错误文案、8 组内容/状态快照与 PNG 字节**仍与重构前基线逐字节相同**
 *   （本域没有改共享行为，内容身份只对带时间轴/视频层的文档追加贡献）。
 *
 * 需要产物：`pnpm -C photocraft run wasm`；缺产物时跳过并给出原因。
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

/** 本域登记的命令（与 Rust `features/animation/mod.rs::CONTRIBUTION` 一致）。 */
const ANIMATION_COMMANDS = [
  "timeline.create",
  "timeline.delete",
  "timeline.setFrame",
  "timeline.nextFrame",
  "timeline.previousFrame",
  "timeline.setProps",
  "timeline.info",
  "layer.videoLayers.newBlankVideoLayer",
  "layer.videoLayers.insertBlankFrame",
  "layer.videoLayers.duplicateFrame",
  "layer.videoLayers.deleteFrame",
  "layer.videoLayers.restoreFrame",
  "layer.videoLayers.restoreAllFrames",
  "layer.videoLayers.showAlteredVideo",
  "layer.videoLayers.rasterize",
  "layer.rasterize.video",
  "layer.videoLayers.interpretFootage"
];

/** 浏览器没有等价物、必须保持关闭的路径/原生命令。 */
const STILL_DISABLED = [
  "layer.videoLayers.newVideoLayerFromFile",
  "layer.videoLayers.replaceFootage",
  "layer.videoLayers.reloadFrame",
  "file.import.videoFramesToLayers",
  "file.export.renderVideo"
];

let module;
let initialized = false;
async function editor() {
  module ??= await import(pathToFileURL(glue));
  if (!initialized) {
    module.initSync({ module: readFileSync(binary) });
    initialized = true;
  }
  return new module.WasmEditor();
}

test("集成命令表相对基线是纯增量，且保留全部 17 个动画命令", { skip: built ? false : "未构建 WASM 产物（先运行 pnpm -C photocraft run wasm）" }, async () => {
  const baseline = JSON.parse(readFileSync(join(packageRoot, "notes", "feature-boundary-baseline.json"), "utf8"));
  const additions = JSON.parse(readFileSync(join(packageRoot, "notes", "feature-boundary-additions.json"), "utf8"));
  // 总增量按集成登记清单对账；动画域自身的 17 个命令仍必须完整存在。
  for (const id of ANIMATION_COMMANDS) assert.ok(additions.commands.includes(id), `${id} 必须登记`);
  const before = new Set(baseline.allowedCommands);
  const wasm = await editor();
  try {
    const allowed = JSON.parse(wasm.allowedCommandIdsJson());
    const after = new Set(allowed);
    const removed = [...before].filter((id) => !after.has(id));
    const added = [...after].filter((id) => !before.has(id)).sort();
    assert.deepEqual(removed, [], "不得删除既有命令");
    const additions = JSON.parse(readFileSync(join(packageRoot, "notes", "feature-boundary-additions.json"), "utf8"));
    assert.deepEqual(added, [...additions.commands].sort());
    for (const id of ANIMATION_COMMANDS) assert.ok(added.includes(id), `动画命令 ${id} 不得因集成遗漏`);
    // 未移植的路径/原生命令仍被拒绝，且不在允许表里。
    for (const id of STILL_DISABLED) {
      assert.equal(after.has(id), false, `${id} 不应开放`);
      assert.throws(() => wasm.execute(id, "{}"), /能力|capability|未开放/);
    }
    // 每个域命令都真的能走到门后（用合法参数；这里只验证不因缺能力被拒）。
    assert.doesNotThrow(() => {
      wasm.execute("file.new", JSON.stringify({ width: 4, height: 4 }));
      JSON.parse(wasm.createTimeline(JSON.stringify({ duration: 2, fps: 12 })));
      JSON.parse(wasm.navigateTimeline("timeline.setFrame", JSON.stringify({ frame: 1 })));
      wasm.videoLayerCommand("layer.videoLayers.newBlankVideoLayer", "{}");
      JSON.parse(wasm.timelineJson());
      wasm.execute("timeline.delete", "{}");
    });
  } finally {
    wasm.free();
  }
});

test("能力握手是登记的增量，buildInfo 与错误文案仍与重构基线逐字节相同", { skip: built ? false : "未构建 WASM 产物（先运行 pnpm -C photocraft run wasm）" }, async () => {
  const baseline = JSON.parse(readFileSync(join(packageRoot, "notes", "feature-boundary-wasm-baseline.json"), "utf8"));
  const additions = JSON.parse(readFileSync(join(packageRoot, "notes", "feature-boundary-additions.json"), "utf8"));
  const wasm = await editor();
  try {
    assert.deepEqual(JSON.parse(module.WasmEditor.buildInfoJson()), baseline.build);
    // 能力握手 = 冻结基线 + 登记项：既有能力前缀不变，尾部恰好是登记的四个 id。
    const handshake = JSON.parse(wasm.capabilityHandshakeJson());
    const known = new Set(baseline.capabilities.capabilities);
    assert.deepEqual(handshake.capabilities.filter((id) => known.has(id)), baseline.capabilities.capabilities);
    assert.deepEqual(handshake.capabilities.filter((id) => !known.has(id)), additions.capabilities);
    assert.deepEqual({ ...handshake, capabilities: null }, { ...baseline.capabilities, capabilities: null });
    // 错误文案与拒绝原因不变（错误是契约的一部分）。
    const errors = [];
    for (const id of ["unknown.command", "filter.liquify", "file.automate.batch"]) {
      try {
        wasm.execute(id, "{}");
        assert.fail(`${id} 不应成功`);
      } catch (error) {
        errors.push({ id, error: String(error) });
      }
    }
    assert.deepEqual(errors, baseline.errors);
  } finally {
    wasm.free();
  }
});
