#!/usr/bin/env node
/**
 * U45 工程往返冒烟：真实 WASM 保存 → 原生核验器接受 → 重新打开仍是索引色/双色调
 * （change: 2026-10-22-add-photocraft-image-mode-workflows，任务 4.1/4.3）。
 *
 *   pnpm -C photocraft run wasm
 *   pnpm -C photocraft run verifier
 *   node photocraft/tests/features/modes/project-roundtrip.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const glue = resolve(root, "packages/editor/dist/wasm/photocraft_editor.js");
const verifier = resolve(root, `packages/project-verifier/dist/bin/photocraft-project-verify`);

const module = await import(pathToFileURL(glue).href);
await module.default({ module_or_path: await readFile(glue.replace(/\.js$/, "_bg.wasm")) });
const directory = await mkdtemp(join(tmpdir(), "photocraft-modes-"));
const results = [];

const run = (name, fn) => {
  try {
    results.push({ name, ok: true, value: fn() });
  } catch (error) {
    results.push({ name, ok: false, value: String(error?.message ?? error) });
  }
};

async function roundTrip(label, convert) {
  const editor = new module.WasmEditor();
  editor.execute("file.new", JSON.stringify({ width: 16, height: 8, mode: "rgb" }));
  convert(editor);
  const expected = JSON.parse(editor.modeInfo());
  const bytes = editor.saveProject();
  const file = join(directory, `${label}.pcraft`);
  await writeFile(file, bytes);
  const verified = spawnSync(verifier, [file], { encoding: "utf8" });
  const reopened = new module.WasmEditor();
  reopened.openProject(bytes, "");
  const actual = JSON.parse(reopened.modeInfo());
  reopened.free();
  editor.free();
  results.push({
    name: `${label}: project verify + reopen`,
    ok: verified.status === 0 && actual.mode === expected.mode
      && JSON.stringify(actual.colorTable) === JSON.stringify(expected.colorTable)
      && JSON.stringify(actual.duotone) === JSON.stringify(expected.duotone),
    value: {
      verifierStatus: verified.status,
      verifierStdout: verified.stdout.trim().slice(0, 300),
      verifierStderr: verified.stderr.trim().slice(0, 200),
      expected: { mode: expected.mode, colorTable: expected.colorTable, duotone: expected.duotone },
      actual: { mode: actual.mode, colorTable: actual.colorTable, duotone: actual.duotone }
    }
  });
}

await roundTrip("indexed", (editor) => {
  editor.applyMode("indexed", JSON.stringify({ colors: 4, dither: "none" }));
  const plan = JSON.parse(editor.planColorTable(JSON.stringify({ entries: { 0: "#00ff00" } })));
  editor.applyColorTable(JSON.stringify({
    entries: { 0: "#00ff00" },
    baseRevision: plan.baseRevision,
    baseContentHash: plan.baseContentHash
  }));
});

await roundTrip("duotone", (editor) => {
  editor.applyMode("grayscale", JSON.stringify({}));
  editor.applyMode("duotone", JSON.stringify({
    type: "tritone",
    inks: [
      { name: "Black", color: "#101010", curve: [[0, 0], [100, 100]] },
      { name: "Warm", color: "#aa5522" },
      { name: "Blue", color: "#2244aa" }
    ]
  }));
});

await roundTrip("bitmap", (editor) => {
  editor.applyMode("grayscale", JSON.stringify({}));
  editor.applyMode("bitmap", JSON.stringify({ method: "threshold" }));
});

/**
 * 核验器不得比编辑器更严：编辑器能创建并保存的工程，原生核验必须仍然通过。
 *
 * 这些状态来自真实 `file.new`（接受 `mode:cmyk|lab`、`depth:16`）。`validate_document` 若把
 * 「16 位」或「像素格式必须等于模式展开格式」写成拒绝规则，接入 `verify_container_with` 后这里
 * 就会从 exit 0 变成假失败——本步把该不变量钉在真实二进制上。
 */
const saveAndVerify = async (label, params) => {
  const editor = new module.WasmEditor();
  editor.execute("file.new", JSON.stringify(params));
  const bytes = editor.saveProject();
  const info = JSON.parse(editor.modeInfo());
  editor.free();
  const file = join(directory, `${label}.pcraft`);
  await writeFile(file, bytes);
  const verified = spawnSync(verifier, [file], { encoding: "utf8" });
  results.push({
    name: `${label}: editor can save, verifier must accept`,
    ok: verified.status === 0,
    value: { rawMode: info.rawMode, verifierStatus: verified.status, stdout: verified.stdout.trim().slice(0, 200) }
  });
};

await saveAndVerify("cmyk-u8", { width: 8, height: 8, mode: "cmyk" });
await saveAndVerify("lab-u8", { width: 8, height: 8, mode: "lab" });
await saveAndVerify("rgb-u16", { width: 8, height: 8, mode: "rgb", depth: 16 });
await saveAndVerify("gray-u16", { width: 8, height: 8, mode: "grayscale", depth: 16 });

console.log(JSON.stringify(results, null, 2));
if (results.some((entry) => !entry.ok)) process.exitCode = 1;
