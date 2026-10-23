/**
 * U77 跨语言核验：真实 WASM 保存的动画工程经**原生核验器**子进程复核
 * （change: 2026-10-22-add-photocraft-animation-workflows）。
 *
 * 证明三件事：
 * 1. 时间轴与视频帧确实写进了 `.pcraft`（不是只存在内存里）；
 * 2. 原生核验器接受这份工程，且上报的对象种类包含视频层（证明 animation 域检查真的被分派）；
 * 3. 超预算帧栈/时间轴的拒绝规则由同一条分派路径执行（见 Rust 侧用例，这里只验证合法工程）。
 *
 * 缺产物时跳过并给出原因（不静默通过）：
 *   pnpm -C photocraft run wasm && pnpm -C photocraft run verifier
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..", "..", "..");
const wasmDir = join(packageRoot, "packages", "editor", "dist", "wasm");
const glue = join(wasmDir, "photocraft_editor.js");
const binary = join(wasmDir, "photocraft_editor_bg.wasm");
const verifier = join(packageRoot, "packages", "project-verifier", "dist", "bin", "photocraft-project-verify");
const built = existsSync(glue) && existsSync(binary);
const verifierBuilt = existsSync(verifier);

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

function solid(width, height, [r, g, b, a = 255]) {
  const frame = new Uint8Array(width * height * 4);
  for (let index = 0; index < frame.length; index += 4) {
    frame[index] = r;
    frame[index + 1] = g;
    frame[index + 2] = b;
    frame[index + 3] = a;
  }
  return frame;
}

test("原生核验器接受 WASM 保存的动画工程", {
  skip: !built ? "未构建 WASM 产物（先运行 pnpm -C photocraft run wasm）"
    : !verifierBuilt ? "未构建核验器（先运行 pnpm -C photocraft run verifier）" : false
}, async () => {
  const wasm = await editor();
  let project;
  try {
    wasm.execute("file.new", JSON.stringify({ width: 8, height: 8 }));
    const frames = [
      solid(8, 8, [255, 0, 0]),
      solid(8, 8, [0, 255, 0]),
      solid(8, 8, [0, 0, 255])
    ];
    const stack = new Uint8Array(frames.reduce((total, frame) => total + frame.length, 0));
    let offset = 0;
    for (const frame of frames) {
      stack.set(frame, offset);
      offset += frame.length;
    }
    wasm.importFrames("三帧", 8, 8, 12, 3, stack);
    project = wasm.saveProject();
    assert.ok(project.length > 0);
  } finally {
    wasm.free();
  }

  let output;
  try {
    output = execFileSync(verifier, [], { input: Buffer.from(project), encoding: "utf8" });
  } catch (error) {
    // 退出码 2 = 核验失败；把它的 JSON 原因带进断言消息。
    assert.fail(`核验器拒绝了带时间轴的工程：${error.stdout || error.message}`);
  }
  const result = JSON.parse(output);
  assert.equal(result.ok, true);
  assert.ok(result.summary.layerCount >= 2, JSON.stringify(result.summary));

  // 域检查已接线：视频层由 animation 域（排在 painting 之前）认领并上报，不再被当作普通栅格。
  const kinds = new Set(result.summary.objectKinds ?? []);
  assert.ok(kinds.has("video-layer"), `核验器必须上报 video-layer：${JSON.stringify([...kinds])}`);
  assert.ok(kinds.has("raster"), JSON.stringify([...kinds]));

  // 接收边界一致性：未配置原生工具时，进程内 TS 核验就是 Media 的默认边界。它必须接受
  // **同一份真实保存的工程**并给出同样的对象种类，否则默认部署会拒绝自己保存的动画工程。
  const tsVerifier = await import(pathToFileURL(join(packageRoot, "packages", "project-verifier", "dist", "index.js")).href)
    .catch(() => null);
  if (tsVerifier) {
    const tsSummary = tsVerifier.verifyPhotocraftProject(new Uint8Array(project));
    assert.deepEqual([...tsSummary.objectKinds].sort(), [...kinds].sort(),
      `两条核验路径的对象种类必须一致：${JSON.stringify([tsSummary.objectKinds, [...kinds]])}`);
    assert.equal(tsSummary.layerCount, result.summary.layerCount);
    assert.equal(tsSummary.formatVersion, result.summary.formatVersion);
  }
});
