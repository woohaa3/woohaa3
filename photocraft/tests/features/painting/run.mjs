/**
 * 绘画域真实 WASM 验收套件的入口。
 *
 * 用法（在 `photocraft/` 下）：
 *   node scripts/build-wasm.mjs              # 先构建真实内核
 *   node tests/features/painting/run.mjs     # 跑全部
 *   node tests/features/painting/run.mjs u27 # 只跑文件名含 u27 的
 *
 * 退出码：全部通过 0，否则 1。任何一个子文件失败都会让整体失败，不会被后面的成功掩盖。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, "../../..");
const filter = process.argv[2];

// 顺序即依赖顺序：content-roundtrip 会留下工程文件给 psd-cross-format 复用。
const SUITE = [
  "panel-commands.mjs",
  "u27-tools.mjs",
  "u28-gradient-bucket.mjs",
  "u29-erasers.mjs",
  "u30-dynamics.mjs",
  "u31-pen-pose.mjs",
  "u32-brush-library.mjs",
  "u33-symmetry.mjs",
  "u34-eyedropper.mjs",
  "u35-swatches-gradients.mjs",
  "u36-tool-presets.mjs",
  "content-roundtrip.mjs",
  "psd-cross-format.mjs",
  "cross-domain.mjs",
];

const wasmDir = path.join(workspaceRoot, "packages/editor/dist/wasm");
if (!fs.existsSync(path.join(wasmDir, "photocraft_editor_bg.wasm"))) {
  console.error(`找不到 WASM 产物：${wasmDir}\n先运行：node scripts/build-wasm.mjs（在 photocraft/ 下）`);
  process.exit(1);
}

const selected = filter ? SUITE.filter((file) => file.includes(filter)) : SUITE;
if (selected.length === 0) {
  console.error(`没有匹配 "${filter}" 的用例。可用：\n  ${SUITE.join("\n  ")}`);
  process.exit(1);
}

const failed = [];
// 所有子进程共用同一输出目录：`content-roundtrip.mjs` 产出的工程供 `psd-cross-format.mjs` 复用。
const sharedOut = fs.mkdtempSync(path.join(os.tmpdir(), "photocraft-painting-run-"));
console.log(`产物目录：${sharedOut}`);
for (const file of selected) {
  console.log(`\n=== ${file}`);
  const result = spawnSync(process.execPath, [path.join(here, file)], {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: { ...process.env, PHOTOCRAFT_PAINTING_OUT: sharedOut },
  });
  if (result.status !== 0) failed.push(file);
}

console.log(`\n${"=".repeat(60)}`);
if (failed.length > 0) {
  console.error(`${selected.length - failed.length}/${selected.length} 个用例文件通过；失败：${failed.join(", ")}`);
  process.exit(1);
}
console.log(`${selected.length}/${selected.length} 个用例文件全部通过`);
