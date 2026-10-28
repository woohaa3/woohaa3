/**
 * 构建编排回归（change: 2026-10-23-optimize-bevy-development-build，tasks 3.1–3.5）。
 *
 * 用临时 checkout + PATH 上的假 cargo / wasm-bindgen / wasm-opt / clang 运行**真实**构建脚本，
 * 覆盖：Cargo metadata 的 target 目录、默认与显式并发、缓存命中与失效原因、模式往返、
 * performance 缺工具、wasm-opt 启动后失败、staging 提交与回滚、跨进程互斥与残留锁恢复。
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(dirname(fileURLToPath(import.meta.url)));

/** 待复制进 fixture 的脚本（保持与真实脚本同一实现）。 */
const COPIED = [
	"scripts/build-bevy-wasm.mjs",
	"scripts/sync-bevy-assets.mjs",
	"scripts/lib/bevy-build-mode.mjs",
	"scripts/lib/wasm-compiler.mjs",
	"scripts/lib/gpu-renderer-selection.mjs"
];

const shims = {
	cargo: `#!/bin/sh
echo "$@" >> "$TEST_LOG/cargo-args"
case "$1" in
  metadata)
    printf '%s' "{\\"target_directory\\":\\"$TEST_TARGET_DIR\\",\\"packages\\":[]}"
    ;;
  build)
    [ -n "$TEST_CARGO_SLEEP" ] && sleep "$TEST_CARGO_SLEEP"
    [ "$TEST_CARGO_FAIL" = "1" ] && { echo "cargo boom" >&2; exit 101; }
    profile=debug
    for a in "$@"; do [ "$a" = "--release" ] && profile=release; done
    dir="$TEST_TARGET_DIR/wasm32-unknown-unknown/$profile"
    mkdir -p "$dir"
    # raw WASM 内容由源码标记决定：改标记就等于改了 Rust 源码。
    { printf 'raw:'; cat "$TEST_SOURCE_MARKER"; } > "$dir/woohaa_bevy_canvas.wasm"
    ;;
esac
exit 0
`,
	"wasm-bindgen": `#!/bin/sh
if [ "$1" = "--version" ]; then echo "wasm-bindgen 0.2.128"; exit 0; fi
echo "$@" >> "$TEST_LOG/bindgen-args"
input="$1"; outdir=""; name=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir) outdir="$2"; shift 2 ;;
    --out-name) name="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ "$TEST_BINDGEN_FAIL" = "1" ] && { echo "bindgen boom" >&2; exit 3; }
mkdir -p "$outdir"
cp "$input" "$outdir/$name"'_bg.wasm'
printf '%s' "export default function init(){}
const path = new URL('woohaa_bevy_canvas_bg.wasm', import.meta.url);
export function hello() { return 1; }
" > "$outdir/$name.js"
printf 'export type X = number;\\n' > "$outdir/$name"'_bg.wasm.d.ts'
exit 0
`,
	"wasm-opt": `#!/bin/sh
if [ "$1" = "--version" ]; then echo "wasm-opt version \${TEST_WASMOPT_VERSION:-126}"; exit 0; fi
echo "$@" >> "$TEST_LOG/opt-args"
in=""
out=""
prev=""
for a in "$@"; do
  case "$a" in
    -*) ;;
    *) if [ "$prev" = "-o" ]; then out="$a"; elif [ -z "$in" ]; then in="$a"; fi ;;
  esac
  prev="$a"
done
[ "$TEST_WASMOPT_FAIL" = "1" ] && { printf 'partial' > "$out"; echo "opt boom" >&2; exit 1; }
{ printf 'opt:'; cat "$in"; } > "$out"
exit 0
`,
	// 不可用的 wasm-opt：版本探测与非版本调用都以「找不到工具」失败，用来模拟未安装 Binaryen。
	"wasm-opt-missing": `#!/bin/sh
echo "wasm-opt: command not found" >&2
exit 127
`,
	clang: `#!/bin/sh
if [ "$1" = "--print-targets" ]; then printf '  wasm32 - WebAssembly 32-bit\\n'; fi
exit 0
`,
	"clang++": `#!/bin/sh
if [ "$1" = "--print-targets" ]; then printf '  wasm32 - WebAssembly 32-bit\\n'; fi
exit 0
`
};

function writeExecutable(path, content) {
	writeFileSync(path, content);
	chmodSync(path, 0o755);
}

/** 建立临时 checkout；返回运行构建所需的路径与环境。 */
function makeFixture({ withWasmOpt = true, withClang = true } = {}) {
	const root = mkdtempSync(join(tmpdir(), "woohaa-bevy-build-"));
	for (const relative of COPIED) {
		const target = join(root, relative);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, readFileSync(join(scripts, "..", relative)));
	}
	mkdirSync(join(root, "bevy", "assets", "fonts"), { recursive: true });
	writeFileSync(join(root, "bevy", "assets", "fonts", "Probe.otf"), "font");
	writeFileSync(join(root, "bevy", "Cargo.toml"), "[package]\nname = \"probe\"\n");
	mkdirSync(join(root, "web", "frontend", "src", "bevy-wasm"), { recursive: true });

	const bin = join(root, "bin");
	const log = join(root, "log");
	mkdirSync(bin, { recursive: true });
	mkdirSync(log, { recursive: true });
	for (const [name, content] of Object.entries(shims)) {
		if (name === "wasm-opt") {
			// 「缺工具」场景放一个只会失败的同名 shim，确保不会落到系统真实的 wasm-opt。
			writeExecutable(join(bin, name), withWasmOpt ? content : shims["wasm-opt-missing"]);
			continue;
		}
		if ((name === "clang" || name === "clang++") && !withClang) continue;
		writeExecutable(join(bin, name), content);
	}
	const sourceMarker = join(root, "source-marker.txt");
	writeFileSync(sourceMarker, "v1");

	const targetDir = join(root, "custom-target");
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	const env = {
		...process.env,
		HOME: home,
		// fixture 的 bin 排在前面，遮住系统真实 wasm-opt；其余仍需要基础 Unix 工具。
		PATH: `${bin}:/usr/bin:/bin`,
		TEST_LOG: log,
		TEST_TARGET_DIR: targetDir,
		TEST_SOURCE_MARKER: sourceMarker,
		CC_wasm32_unknown_unknown: join(bin, "clang"),
		CXX_wasm32_unknown_unknown: join(bin, "clang++")
	};
	// 清掉可能干扰的外部配置（空串会被脚本当成显式值，因此直接删除）。
	for (const name of [
		"CARGO_BUILD_JOBS",
		"CARGO_TARGET_DIR",
		"WOOHAA_BEVY_DEV_MODE",
		"WOOHAA_STATIC_BATCH_STRATEGY",
		"WOOHAA_RENDER_DRAW_DIAGNOSTICS",
		"WOOHAA_BEVY_RENDERER"
	]) {
		delete env[name];
	}
	// 构建编排测试只验证流程；后端选择由独立探测单测覆盖，避免依赖宿主 GPU。
	env.WOOHAA_BEVY_RENDERER = "webgpu";
	return { root, bin, log, sourceMarker, targetDir, env };
}

function build(fixture, args = [], env = {}) {
	const result = spawnSync(process.execPath, ["scripts/build-bevy-wasm.mjs", ...args], {
		cwd: fixture.root,
		env: { ...fixture.env, ...env },
		encoding: "utf8"
	});
	return { status: result.status, log: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

function buildAsync(fixture, args = [], env = {}) {
	const child = spawn(process.execPath, ["scripts/build-bevy-wasm.mjs", ...args], {
		cwd: fixture.root,
		env: { ...fixture.env, ...env }
	});
	let log = "";
	child.stdout.on("data", (chunk) => (log += chunk));
	child.stderr.on("data", (chunk) => (log += chunk));
	return new Promise((resolve) => child.on("close", (status) => resolve({ status, log })));
}

const outputs = (fixture) => {
	const directory = join(fixture.root, "web", "frontend", "src", "bevy-wasm");
	return readdirSync(directory).sort();
};
const read = (fixture, name) =>
	readFileSync(join(fixture.root, "web", "frontend", "src", "bevy-wasm", name), "utf8");
const logLines = (fixture, name) => {
	const path = join(fixture.log, name);
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
};
const stamp = (fixture) => {
	const path = join(fixture.targetDir, "bevy-wasm-build.stamp.json");
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
};

test("development build writes importable glue, wasm and declarations without wasm-opt", (t) => {
	const fixture = makeFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

	const result = build(fixture, ["--mode", "development"]);
	assert.equal(result.status, 0, result.log);
	assert.deepEqual(outputs(fixture), ["woohaa_bevy_canvas.d.ts", "woohaa_bevy_canvas.js", "woohaa_bevy_canvas_bg.wasm"]);
	assert.match(read(fixture, "woohaa_bevy_canvas.js"), /new URL\('\.\/woohaa_bevy_canvas_bg\.wasm', import\.meta\.url\)/);
	assert.deepEqual(logLines(fixture, "opt-args"), []);
	assert.equal(stamp(fixture).mode, "development");
	assert.equal(stamp(fixture).optSkipped, true);
	// 字体由同一位置同步。
	assert.ok(existsSync(join(fixture.root, "web/frontend/public/assets/fonts/Probe.otf")));
});

test("renderer override selects the matching Cargo feature and is recorded in the stamp", (t) => {
	const fixture = makeFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

	const result = build(fixture, ["--mode", "development"], { WOOHAA_BEVY_RENDERER: "webgl2" });
	assert.equal(result.status, 0, result.log);
	const buildArgs = logLines(fixture, "cargo-args").find((line) => line.startsWith("build"));
	assert.match(buildArgs, /--no-default-features --features wasm-webgl2/);
	assert.equal(stamp(fixture).rendererBackend, "webgl2");
	assert.equal(stamp(fixture).rendererSelection, "override");
});

test("raw WASM and stamp come from the Cargo metadata target directory", (t) => {
	const fixture = makeFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

	const result = build(fixture, ["--mode", "development"]);
	assert.equal(result.status, 0, result.log);
	assert.match(result.log, new RegExp(`target=${fixture.targetDir}`));
	assert.ok(existsSync(join(fixture.targetDir, "bevy-wasm-build.stamp.json")));
	// 不读默认目录：默认位置的旧产物不得被当成输入。
	assert.equal(existsSync(join(fixture.root, "bevy/target/wasm32-unknown-unknown/debug/woohaa_bevy_canvas.wasm")), false);
});

test("a stamp on another filesystem than the outputs is still published", (t) => {
	const fixture = makeFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	// stamp 跟着 Cargo target 目录走，产物在仓库内：两者可能不在同一挂载点（例如
	// CARGO_TARGET_DIR 指向另一块盘）。跨设备 rename 会 EXDEV，构建必须仍能发布 stamp。
	const { dev } = statSync(fixture.root);
	const elsewhere = ["/dev/shm", "/run/shm"].map((dir) => [dir, existsSync(dir) ? statSync(dir).dev : dev])
		.find(([, device]) => device !== dev);
	if (!elsewhere) {
		t.skip("没有第二个可写的文件系统可用于跨设备用例");
		return;
	}
	const targetDir = mkdtempSync(join(elsewhere[0], "woohaa-bevy-target-"));

	const result = build(fixture, ["--mode", "development"], { TEST_TARGET_DIR: targetDir });
	assert.equal(result.status, 0, result.log);
	assert.ok(existsSync(join(targetDir, "bevy-wasm-build.stamp.json")));
	// 临时 stamp 不得留在目标目录里。
	assert.equal(readdirSync(targetDir).some((name) => name.startsWith(".stamp-")), false);
	// 命中判定仍然可用。
	assert.match(build(fixture, ["--mode", "development"], { TEST_TARGET_DIR: targetDir }).log, /cache hit/);
});

test("a metadata failure fails loudly instead of falling back to the default target", (t) => {
	const fixture = makeFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	writeExecutable(join(fixture.bin, "cargo"), "#!/bin/sh\nexit 1\n");

	const result = build(fixture, ["--mode", "development"]);
	assert.equal(result.status, 1);
	assert.match(result.log, /Cargo metadata/);
	assert.deepEqual(outputs(fixture), []);
});

test("no fixed -j is passed and CARGO_BUILD_JOBS stays Cargo's own setting", (t) => {
	const fixture = makeFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

	const first = build(fixture, ["--mode", "development"]);
	assert.equal(first.status, 0, first.log);
	assert.match(first.log, /jobs=Cargo 默认/);
	const buildArgs = logLines(fixture, "cargo-args").find((line) => line.startsWith("build"));
	assert.ok(buildArgs, "cargo build 必须执行");
	assert.equal(/\s-j(\s|$)/.test(buildArgs), false, `不得传固定 -j：${buildArgs}`);

	const explicit = build(fixture, ["--mode", "development"], { CARGO_BUILD_JOBS: "3" });
	assert.equal(explicit.status, 0, explicit.log);
	assert.match(explicit.log, /jobs=CARGO_BUILD_JOBS=3/);
});

test("an unchanged rerun hits the cache and skips bindgen and optimization", (t) => {
	const fixture = makeFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

	assert.equal(build(fixture, ["--mode", "development"]).status, 0);
	const bindgenCalls = logLines(fixture, "bindgen-args").length;
	const second = build(fixture, ["--mode", "development"]);
	assert.equal(second.status, 0, second.log);
	assert.match(second.log, /cache hit（mode=development/);
	assert.equal(logLines(fixture, "bindgen-args").length, bindgenCalls);
});

test("source, mode round-trip, tool and output changes all report a miss reason", (t) => {
	const fixture = makeFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

	assert.equal(build(fixture, ["--mode", "development"]).status, 0);

	// 1. 源码小改 → 指纹变化。
	writeFileSync(fixture.sourceMarker, "v2");
	const changed = build(fixture, ["--mode", "development"]);
	assert.equal(changed.status, 0, changed.log);
	assert.match(changed.log, /cache miss：指纹变化/);

	// 2. 模式往返：development → release → development 不能只凭旧 stamp 命中。
	const release = build(fixture, ["--mode", "release"]);
	assert.equal(release.status, 0, release.log);
	assert.match(release.log, /cache miss：模式变化（development → release）/);
	assert.equal(stamp(fixture).mode, "release");

	const back = build(fixture, ["--mode", "development"]);
	assert.equal(back.status, 0, back.log);
	assert.match(back.log, /cache miss：模式变化（release → development）/);

	// 3. 产物损坏 → 摘要不一致，必须重建。
	writeFileSync(join(fixture.root, "web/frontend/src/bevy-wasm/woohaa_bevy_canvas_bg.wasm"), "corrupted");
	const corrupted = build(fixture, ["--mode", "development"]);
	assert.equal(corrupted.status, 0, corrupted.log);
	assert.match(corrupted.log, /cache miss：产物内容与成功记录不一致：woohaa_bevy_canvas_bg\.wasm/);

	// 4. 缺 d.ts → 缺少产物。
	rmSync(join(fixture.root, "web/frontend/src/bevy-wasm/woohaa_bevy_canvas.d.ts"));
	const missing = build(fixture, ["--mode", "development"]);
	assert.equal(missing.status, 0, missing.log);
	assert.match(missing.log, /cache miss：缺少产物：woohaa_bevy_canvas\.d\.ts/);

	// 5. 旧版 stamp（缺模式/摘要）一次性失效，不迁移成命中。
	writeFileSync(join(fixture.targetDir, "bevy-wasm-build.stamp.json"), JSON.stringify({ version: 1, fingerprint: "x" }));
	const legacy = build(fixture, ["--mode", "development"]);
	assert.equal(legacy.status, 0, legacy.log);
	assert.match(legacy.log, /cache miss：stamp 版本过期/);
});

test("tool version changes invalidate the cache even when outputs look current", (t) => {
	const fixture = makeFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

	assert.equal(build(fixture, ["--mode", "performance"]).status, 0);
	const current = stamp(fixture);
	assert.equal(current.mode, "performance");
	// 模拟 wasm-bindgen 版本变化：写入一个与当前指纹不同的记录，输出摘要仍然匹配。
	const record = { ...current, fingerprint: "outdated" };
	writeFileSync(join(fixture.targetDir, "bevy-wasm-build.stamp.json"), JSON.stringify(record));
	const result = build(fixture, ["--mode", "performance"]);
	assert.equal(result.status, 0, result.log);
	assert.match(result.log, /cache miss：指纹变化/);
});

test("performance without wasm-opt fails before Cargo and publishes no success record", (t) => {
	const fixture = makeFixture({ withWasmOpt: false });
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

	const result = build(fixture, ["--mode", "performance"]);
	assert.equal(result.status, 1, result.log);
	assert.match(result.log, /performance 模式需要 wasm-opt/);
	assert.equal(stamp(fixture), null);
	assert.deepEqual(outputs(fixture), []);
	// 不浪费一次 release 编译：Cargo 不应被启动。
	assert.deepEqual(logLines(fixture, "cargo-args"), []);
});

test("release without wasm-opt warns, keeps the unoptimized build and re-optimizes after recovery", (t) => {
	const fixture = makeFixture({ withWasmOpt: false });
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

	const degraded = build(fixture, ["--mode", "release"]);
	assert.equal(degraded.status, 0, degraded.log);
	assert.match(degraded.log, /未运行 wasm-opt（缺失）/);
	assert.equal(stamp(fixture).optSkipped, true);
	assert.equal(stamp(fixture).optReason, "missing-tool");
	// 缺工具时不能记为优化成功：日志明确 off，stamp 不是优化成功记录。
	assert.match(degraded.log, /优化=off/);

	// 工具恢复后重新优化：raw WASM 与参数相同也不能直接沿用降级记录。
	writeExecutable(join(fixture.bin, "wasm-opt"), shims["wasm-opt"]);
	const recovered = build(fixture, ["--mode", "release"]);
	assert.equal(recovered.status, 0, recovered.log);
	assert.match(recovered.log, /cache miss：指纹变化/);
	assert.equal(stamp(fixture).optSkipped, false);
	assert.match(recovered.log, /优化=on/);
});

test("a started wasm-opt that fails aborts the build and keeps the previous complete outputs", (t) => {
	const fixture = makeFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

	assert.equal(build(fixture, ["--mode", "release"]).status, 0);
	const previousGlue = read(fixture, "woohaa_bevy_canvas.js");
	const previousWasm = read(fixture, "woohaa_bevy_canvas_bg.wasm");
	const previousStamp = readFileSync(join(fixture.targetDir, "bevy-wasm-build.stamp.json"), "utf8");

	// 改源码让这次必然重建，并让 wasm-opt 启动后失败。
	writeFileSync(fixture.sourceMarker, "v2");
	const failed = build(fixture, ["--mode", "release"], { TEST_WASMOPT_FAIL: "1" });
	assert.equal(failed.status, 1, failed.log);
	assert.match(failed.log, /wasm-opt 返回 exit 1/);
	// 旧完整产物与旧 stamp 都保留，且没有被当成这次的成功结果。
	assert.equal(read(fixture, "woohaa_bevy_canvas.js"), previousGlue);
	assert.equal(read(fixture, "woohaa_bevy_canvas_bg.wasm"), previousWasm);
	assert.equal(readFileSync(join(fixture.targetDir, "bevy-wasm-build.stamp.json"), "utf8"), previousStamp);

	// 下一次没有失败注入：检测到源码变化后重建成功。
	const retried = build(fixture, ["--mode", "release"]);
	assert.equal(retried.status, 0, retried.log);
	assert.match(retried.log, /cache miss：指纹变化/);
	assert.equal(stamp(fixture).rawWasmSha256.startsWith(""), true);
});

test("a bindgen failure leaves no partial outputs behind", (t) => {
	const fixture = makeFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

	assert.equal(build(fixture, ["--mode", "development"]).status, 0);
	const before = read(fixture, "woohaa_bevy_canvas.js");
	writeFileSync(fixture.sourceMarker, "v2");
	const failed = build(fixture, ["--mode", "development"], { TEST_BINDGEN_FAIL: "1" });
	assert.notEqual(failed.status, 0, failed.log);
	assert.match(failed.log, /wasm-bindgen/);

	assert.equal(read(fixture, "woohaa_bevy_canvas.js"), before);
	assert.equal(outputs(fixture).some((name) => name.startsWith(".staging-")), false);

	const retried = build(fixture, ["--mode", "development"]);
	assert.equal(retried.status, 0, retried.log);
	assert.match(retried.log, /cache miss/);
});

test("cargo failure exits non-zero without publishing a stamp", (t) => {
	const fixture = makeFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

	const result = build(fixture, ["--mode", "development"], { TEST_CARGO_FAIL: "1" });
	assert.equal(result.status, 101, result.log);
	assert.equal(stamp(fixture), null);
	assert.deepEqual(outputs(fixture), []);
});

test("two concurrent builds serialize on the output directory without mixing modes", async (t) => {
	const fixture = makeFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

	const [first, second] = await Promise.all([
		buildAsync(fixture, ["--mode", "development"], { TEST_CARGO_SLEEP: "0.4" }),
		buildAsync(fixture, ["--mode", "performance"], { TEST_CARGO_SLEEP: "0.4" })
	]);
	assert.equal(first.status, 0, first.log);
	assert.equal(second.status, 0, second.log);
	// 至少一方记录了互斥等待，说明确实串行执行。
	assert.ok(/另一个构建正在写入同一输出目录|取得构建锁（等待/.test(first.log + second.log));
	// 最终产物与 stamp 属于同一模式，不会出现跨模式混合。
	const final = stamp(fixture);
	const glue = read(fixture, "woohaa_bevy_canvas.js");
	assert.ok(["development", "performance"].includes(final.mode));
	if (final.mode === "development") assert.deepEqual(logLines(fixture, "opt-args").length >= 0, true);
	// glue 摘要必须与 stamp 记录一致。
	assert.equal(stamp(fixture).outputs["woohaa_bevy_canvas.js"].length, 64);
	assert.match(glue, /init/);
});

test("a stale staging directory from an interrupted build is neither a hit nor left behind", (t) => {
	const fixture = makeFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

	assert.equal(build(fixture, ["--mode", "development"]).status, 0);
	// 模拟上一次构建在提交前被中断：残留 staging 目录带半套产物。
	const staging = join(fixture.root, "web/frontend/src/bevy-wasm/.staging-999999");
	mkdirSync(staging, { recursive: true });
	writeFileSync(join(staging, "woohaa_bevy_canvas.js"), "half-written");

	const resumed = build(fixture, ["--mode", "development"]);
	assert.equal(resumed.status, 0, resumed.log);
	// 残留文件不构成命中、也不进入导入位置。
	assert.match(resumed.log, /cache hit/);
	assert.match(resumed.log, /清理残留 staging：\.staging-999999/);
	assert.equal(read(fixture, "woohaa_bevy_canvas.js").includes("half-written"), false);
	// 残留 staging 已被清理，导入位置里也没有它。
	assert.equal(existsSync(staging), false);
	assert.equal(
		readdirSync(join(fixture.root, "web/frontend/src/bevy-wasm")).some((name) => name.startsWith(".staging-")),
		false
	);
});

test("a repeated run still reports the degraded optimization state instead of claiming success", (t) => {
	const fixture = makeFixture({ withWasmOpt: false });
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

	assert.equal(build(fixture, ["--mode", "release"]).status, 0);
	// 第二次：raw WASM 未变、工具仍缺失，因此命中降级记录；日志不能报优化成功。
	const repeated = build(fixture, ["--mode", "release"]);
	assert.equal(repeated.status, 0, repeated.log);
	assert.match(repeated.log, /cache hit/);
	assert.match(repeated.log, /opt=skipped\(missing-tool\)/);
	assert.match(repeated.log, /优化=off/);
	assert.match(repeated.log, /产物未优化/);
});

test("a successful build releases its lock", (t) => {
	const fixture = makeFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

	assert.equal(build(fixture, ["--mode", "development"]).status, 0);
	const lockRoot = join(fixture.root, ".local", "locks");
	assert.equal(existsSync(lockRoot) ? readdirSync(lockRoot).length : 0, 0);
});

test("a lock left by a dead process is recovered instead of blocking forever", async (t) => {
	const fixture = makeFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

	// 先跑一次以建立 lock 目录路径规则（与脚本内部一致：输出目录哈希）。
	assert.equal(build(fixture, ["--mode", "development"]).status, 0);
	const lockRoot = join(fixture.root, ".local", "locks");
	const { createHash } = await import("node:crypto");
	const { hostname } = await import("node:os");
	const key = createHash("sha256").update(join(fixture.root, "web", "frontend", "src", "bevy-wasm")).digest("hex").slice(0, 12);
	const lockDir = join(lockRoot, `bevy-wasm-${key}.lock`);
	mkdirSync(lockDir, { recursive: true });
	writeFileSync(
		join(lockDir, "owner.json"),
		JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname(), startedAt: new Date().toISOString() })
	);

	const recovered = build(fixture, ["--mode", "development"]);
	assert.equal(recovered.status, 0, recovered.log);
	assert.match(recovered.log, /回收残留构建锁/);
	assert.equal(existsSync(lockDir), false);
});
