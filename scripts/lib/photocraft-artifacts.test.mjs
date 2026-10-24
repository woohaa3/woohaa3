/**
 * PhotoCraft 产物新鲜度预检（2026-10-24 录制阻塞项 B14）。
 *
 * 回归：dev 启动曾只判断「文件存在」，于是旧 WASM 缺 `capabilityHandshakeJson`、
 * `protocol/dist` 缺 `verifyPhotocraftHandshake`、`project-verifier/dist` 白名单缺
 * `PhotoFilter` 都不被发现，直到运行时才以「内核缺少能力协商」「首期未开放的调整类型」
 * 这类误导性错误暴露。
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkArtifact, checkPhotocraftArtifacts, describeArtifactFailures } from "./photocraft-artifacts.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "photocraft-artifacts-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(path, contents, mtimeSeconds) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
  if (mtimeSeconds !== undefined) utimesSync(path, mtimeSeconds, mtimeSeconds);
}

const WASM = {
  id: "wasm",
  label: "内核 WASM",
  files: ["photocraft_editor.js", "photocraft_editor_bg.wasm"],
  output: "photocraft/packages/editor/dist/wasm",
  sources: ["photocraft/rust/crates"],
  markerFile: "photocraft_editor.js",
  markers: ["capabilityHandshakeJson"],
  buildHint: "pnpm photocraft:wasm"
};

describe("checkArtifact", () => {
  it("产物缺失时明确报缺哪个文件", () => {
    const root = fixture();
    const result = checkArtifact(root, WASM);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing");
    assert.match(result.detail, /photocraft_editor\.js/);
  });

  it("文件都在但缺必需导出 → 判旧构建（不看 mtime）", () => {
    // 真实事故：10-22 的 WASM 时间戳比源码新，但没有能力握手。
    const root = fixture();
    write(join(root, WASM.output, "photocraft_editor.js"), "export function init(){}", 2_000);
    write(join(root, WASM.output, "photocraft_editor_bg.wasm"), "binary", 2_000);
    write(join(root, "photocraft/rust/crates/editor-core/src/lib.rs"), "// src", 1_000);
    const result = checkArtifact(root, WASM);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "outdated");
    assert.match(result.detail, /capabilityHandshakeJson/);
    assert.match(result.detail, /pnpm photocraft:wasm/);
  });

  it("导出齐全但源码更新 → 判过期", () => {
    const root = fixture();
    write(join(root, WASM.output, "photocraft_editor.js"), "capabilityHandshakeJson", 1_000);
    write(join(root, WASM.output, "photocraft_editor_bg.wasm"), "binary", 1_000);
    write(join(root, "photocraft/rust/crates/editor-core/src/lib.rs"), "// newer src", 5_000);
    const result = checkArtifact(root, WASM);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "stale");
  });

  it("导出齐全且产物不比源码旧 → 通过", () => {
    const root = fixture();
    write(join(root, "photocraft/rust/crates/editor-core/src/lib.rs"), "// src", 1_000);
    write(join(root, WASM.output, "photocraft_editor.js"), "capabilityHandshakeJson", 2_000);
    write(join(root, WASM.output, "photocraft_editor_bg.wasm"), "binary", 2_000);
    assert.deepEqual(checkArtifact(root, WASM), { ok: true });
  });

  it("构建缓存目录不参与新鲜度判定（否则每次构建都会自我判过期）", () => {
    const root = fixture();
    write(join(root, WASM.output, "photocraft_editor.js"), "capabilityHandshakeJson", 2_000);
    write(join(root, WASM.output, "photocraft_editor_bg.wasm"), "binary", 2_000);
    write(join(root, "photocraft/rust/crates/editor-core/src/lib.rs"), "// src", 1_000);
    write(join(root, "photocraft/rust/crates/.local/wasm-target/cache.bin"), "cache", 9_000);
    assert.deepEqual(checkArtifact(root, WASM), { ok: true });
  });
});

describe("checkPhotocraftArtifacts", () => {
  it("一次报出三条产物的全部问题，错误文案指向真正的构建命令", () => {
    const root = fixture();
    const results = checkPhotocraftArtifacts(root);
    assert.equal(results.length, 3);
    assert.ok(results.every((entry) => !entry.ok));
    const text = describeArtifactFailures(results);
    assert.match(text, /wasm/);
    assert.match(text, /protocol/);
    assert.match(text, /verifier/);
    assert.match(text, /pnpm photocraft:setup/);
  });

  it("没有失败项时不渲染错误块", () => {
    assert.equal(describeArtifactFailures([]), "");
  });
});
