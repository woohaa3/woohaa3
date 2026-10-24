/**
 * 开发/生产入口的模式接线回归（change: 2026-10-23-optimize-bevy-development-build，
 * tasks 2.1 / 4.1 / 4.2）。
 *
 * 这里不启动 Vite 或后端：直接对入口脚本的静态接线做断言（子进程实际启动代价太大，
 * 且入口真正的模式决策已在 `bevy-build-mode.test.mjs` 与 `bevy-wasm-build.test.mjs`
 * 用真实子进程覆盖）。断言失败说明入口把模式又写死回 `--keep-names` 或旧参数。
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FRONTEND_BUILD_STEPS } from "./desktop-release.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const read = (relative) => readFileSync(join(root, relative), "utf8");
const pkg = JSON.parse(read("package.json"));

test("every development entry goes through the shared mode selector", () => {
  for (const entry of ["scripts/dev.mjs", "scripts/dev-desktop.mjs"]) {
    const source = read(entry);
    assert.match(source, /resolveDevEntryArgs/, `${entry} 必须调用共享选择器`);
    assert.match(source, /"scripts\/build-bevy-wasm\.mjs", \.\.\.bevyModeArgs/, `${entry} 必须把选择结果传给构建`);
    // 旧的写死符号参数不能再出现在 Bevy 构建调用里。
    assert.equal(
      /"scripts\/build-bevy-wasm\.mjs", "--keep-names"/.test(source),
      false,
      `${entry} 仍在写死 --keep-names`
    );
  }
});

test("dev:frontend and build:bevy:dev select the development mode", () => {
  assert.match(pkg.scripts["dev:frontend"], /build-bevy-wasm\.mjs --dev/);
  assert.equal(pkg.scripts["build:bevy:dev"], "node scripts/build-bevy-wasm.mjs --mode development");
});

test("production entries request release explicitly and ignore the dev mode variable", () => {
  assert.equal(pkg.scripts["build:bevy"], "node scripts/build-bevy-wasm.mjs --mode release");
  assert.equal(pkg.scripts["build:wasm"].includes("build-bevy-wasm.mjs --mode release"), true);
  // 根生产 build 通过 build:bevy 走 release；生产脚本里不得出现 --dev。
  assert.match(pkg.scripts.build, /build:bevy/);
  assert.equal(/build-bevy-wasm\.mjs --dev/.test(pkg.scripts.build), false);

  const bevyStep = FRONTEND_BUILD_STEPS.find((step) => step.includes("scripts/build-bevy-wasm.mjs"));
  assert.ok(bevyStep, "桌面前端发行装配必须包含 Bevy 构建");
  assert.ok(bevyStep.includes("--mode") && bevyStep.includes("release"), `桌面前端发行装配必须显式 release：${bevyStep}`);
  assert.equal(bevyStep.includes("--dev"), false);
});

test("a performance build entry exists for explicit profiling", () => {
  assert.equal(pkg.scripts["build:bevy:perf"], "node scripts/build-bevy-wasm.mjs --mode performance");
});

test("Bevy dev profile keeps incrementality, drops LTO and optimizes dependencies", () => {
  const manifest = read("bevy/Cargo.toml");
  const dev = /\[profile\.dev\]([\s\S]*?)(?=\n\[|$)/.exec(manifest)?.[1] ?? "";
  assert.match(dev, /incremental\s*=\s*true/);
  assert.match(dev, /lto\s*=\s*false/);
  assert.match(dev, /debug\s*=\s*0/);
  assert.match(dev, /opt-level\s*=\s*1/);
  assert.match(dev, /codegen-units\s*=\s*16/);
  assert.match(manifest, /\[profile\.dev\.package\."\*"\]\s*\nopt-level\s*=\s*3/);

  // release 仍是 s / thin / 8，本项目 z / 1：本 change 不动发布优化。
  const release = /\[profile\.release\]([\s\S]*?)(?=\n\[|$)/.exec(manifest)?.[1] ?? "";
  assert.match(release, /opt-level\s*=\s*"s"/);
  assert.match(release, /lto\s*=\s*"thin"/);
  assert.match(release, /codegen-units\s*=\s*8/);
  const releasePackage = /\[profile\.release\.package\.woohaa_bevy_canvas\]([\s\S]*?)(?=\n\[|$)/.exec(manifest)?.[1] ?? "";
  assert.match(releasePackage, /opt-level\s*=\s*"z"/);
  assert.match(releasePackage, /codegen-units\s*=\s*1/);

  // 原生桌面继续用 desktop/Cargo.toml 自己的 profile。
  const desktop = read("desktop/Cargo.toml");
  assert.match(desktop, /\[profile\.dev\]\s*\ndebug\s*=\s*0\s*\nopt-level\s*=\s*1/);
  assert.match(desktop, /\[profile\.dev\.package\."\*"\]\s*\nopt-level\s*=\s*3/);
});
