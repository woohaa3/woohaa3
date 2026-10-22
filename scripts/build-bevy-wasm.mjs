// 构建 Woohaa3 Bevy WASM 运行时并生成 wasm-bindgen web 绑定。
//
//   node scripts/build-bevy-wasm.mjs [--debug] [--skip-opt] [--keep-names]
//
// 模式（change: optimize-bevy-wasm-build）：
//   - `--debug`      只控制 Cargo profile（debug，默认 release）；不隐含跳过优化。
//   - `--skip-opt`   跳过 `wasm-opt -Oz`，用于开发迭代；日志会标示「未优化」。
//   - `--keep-names` 保留 Rust 函数名供 DevTools 性能调用栈使用，不改变 Cargo 优化级别。
//   - 根 `build:bevy:dev` = debug + skip-opt；`build:bevy` / 根 `build` = release + 优化。
//
// 缓存（design D2/D3）：Cargo 结束后计算原始 `.wasm` 的 SHA-256，与 profile、工具版本/参数、
// glue 后处理版本和稳定 d.ts 模板版本组成指纹。仅当指纹一致且 JS/WASM/d.ts/字体全部存在时
// 复用产物；否则完整重建。产物先写临时目录再原子替换，失败/中断不会写入成功 stamp。
//
// wasm-bindgen 的 JS glue 生成到 Vite 的**源码图**（`web/frontend/src/bevy-wasm/`）：
// Vite 拒绝从 `public/` 动态 import 模块。Vite 会静态分析 glue 里的
// `new URL('./..._bg.wasm', import.meta.url)` 并把 wasm 作为带 hash 的资源产出。
// 字体资源由 Bevy 运行时按 URL 读取（不经 Vite 模块图），放在 `public/assets/fonts/`。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	renameSync,
	readFileSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { wasmCompilerEnvironment } from "./lib/wasm-compiler.mjs";
import { syncBevyAssets, BEVY_ASSETS_TARGET_DIR } from "./sync-bevy-assets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const crate = join(root, "bevy");
const outDir = join(root, "web", "frontend", "src", "bevy-wasm");

const debug = process.argv.includes("--debug");
const skipOpt = process.argv.includes("--skip-opt");
const keepNames = debug || process.argv.includes("--keep-names");
const optArgs = ["-Oz", ...(keepNames ? ["-g"] : [])];
const profile = debug ? "debug" : "release";
const release = !debug;
const modelBatchStrategy = process.env.WOOHAA_STATIC_BATCH_STRATEGY ?? "spatial";
const renderDrawDiagnostics = process.env.WOOHAA_RENDER_DRAW_DIAGNOSTICS ?? "1";

/** 可丢弃的构建指纹 stamp（与 Cargo target 一同可丢弃，不进版本控制）。 */
const stampPath = join(crate, "target", "bevy-wasm-build.stamp.json");
/** glue 后处理与稳定 d.ts 模板的版本；任一改动都必须使缓存失效。 */
const GLUE_POSTPROCESS_VERSION = "1";
// change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm —— 新增 query_* / prepare_and_register_*
// / model_asset_diagnostics 导出，模板版本提升使缓存失效。
// change: 2026-10-07-remove-residual-compatibility —— request_shot_capture/poll_shot_capture 替换
// request_capture/poll_capture 并删除 register_model_resource，模板版本提升。
// change: 2026-10-08-make-film-set-model-only —— 新增 set_model_media_texture 导出，模板版本提升。
// change: 2026-10-10-optimize-canvas-interaction-hot-path —— 新增 set_viewport /
// base_scene_generation / viewport_capability / canvas_work_diagnostics 导出，模板版本提升。
// change: 2026-10-12-align-film-set-scope-with-isometric-grid —— 新增 query_drop_target /
// query_composite_asset_scopes 导出，模板版本提升使缓存失效。
// change: 2026-10-12-optimize-canvas-model-lod-and-interactions —— 新增 set_positions /
// position_capability 导出，模板版本提升使缓存失效。
const DTS_TEMPLATE_VERSION = "9";

const OUT_NAME = "woohaa_bevy_canvas";
const glueName = `${OUT_NAME}.js`;
const wasmName = `${OUT_NAME}_bg.wasm`;
const dtsName = `${OUT_NAME}.d.ts`;
const rawArtifact = join(crate, "target", "wasm32-unknown-unknown", profile, `${OUT_NAME}.wasm`);

const env = { ...process.env, PATH: `${join(homedir(), ".cargo", "bin")}${delimiter}${process.env.PATH}` };

/** 手工维护的稳定类型面；与 Rust `#[wasm_bindgen]` 导出一致。 */
const STABLE_DTS = `// wasm-bindgen 生成的 Bevy 运行时 glue 的稳定类型面
// （由 scripts/build-bevy-wasm.mjs 生成 \`woohaa_bevy_canvas.js\` / \`_bg.wasm\`）。
//
// 本 \`.d.ts\` **手工维护**，保证未运行 wasm 构建时 \`tsc\` 仍可解析模块。导出签名必须与
// Rust \`bevy/src/lib.rs\` 的 \`#[wasm_bindgen]\` 导出保持一致。

export function seed_runtime_generation(previous: number): void;
export function runtime_health(): string;
export function is_ready(): boolean;
export function rendered_revision(): number;
export function set_scene(json: string): number;
export function set_texture(id: string, width: number, height: number, rgba: Uint8Array): void;
export function set_image_focus_details(manifest:string,pixels:Uint8Array):void;
export function set_model_media_texture(id: string, width: number, height: number, rgba: Uint8Array): void;
export function request_shot_capture(json: string): void;
export function poll_shot_capture(requestId: number, generation: number): Uint8Array;
export function shot_diagnostics(): string;
export function start(): void;
export function query_point_hit(json: string): string;
export function query_marquee(json: string): string;
export function query_probe(json: string): string;
export function query_drop_target(json: string): string;
export function query_composite_asset_scopes(json: string): string;
export function query_model_pick(json: string): string;
export function query_composite_asset_item_pick(json: string): string;
export function query_composite_asset_item_bounds(json: string): string;
export function query_gizmo_hit(json: string): string;
export function prepare_and_register_model_resource(json: string): string;
export function model_asset_diagnostics(): string;
export function set_viewport(json: string): number;
export function set_observer(json: string): number;
export function observer_capability(): string;
export function set_positions(json: string): number;
export function position_capability(): string;
export function base_scene_generation(): number;
export function viewport_capability(): string;
export function scene_capability(): string;
export function canvas_work_diagnostics(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;
export type SyncInitInput = BufferSource | WebAssembly.Module;

export function initSync(module: { module: SyncInitInput } | SyncInitInput): unknown;

export default function init(
  module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>
): Promise<unknown>;
`;

// ── 计时（单调时钟）────────────────────────────────────────────────────────────

function now() {
	return process.hrtime.bigint();
}

function secondsSince(start) {
	return Number(process.hrtime.bigint() - start) / 1e9;
}

function fmt(seconds) {
	return `${seconds.toFixed(2)}s`;
}

// ── 命令执行 ──────────────────────────────────────────────────────────────────

/** 同步运行命令；失败抛出（调用方决定是否致命）。返回耗时秒。 */
function run(command, args, cwd) {
	const start = now();
	const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
	const elapsed = secondsSince(start);
	if (result.error) {
		throw new Error(
			`未找到命令 \`${command}\`，请安装 Rust（rustup target add wasm32-unknown-unknown）与 wasm-bindgen-cli 0.2.128。`,
			{ cause: result.error }
		);
	}
	if (result.status !== 0) {
		const error = new Error(`命令失败（exit ${result.status}）：${command} ${args.join(" ")}`);
		error.exitCode = result.status ?? 1;
		throw error;
	}
	return elapsed;
}

/** 捕获命令 stdout（用于探测工具版本）；失败返回 null。 */
function capture(command, args) {
	const result = spawnSync(command, args, { cwd: crate, env, encoding: "utf8" });
	if (result.error || result.status !== 0) return null;
	return (result.stdout ?? "").trim();
}

/** 工具版本探测：缺失或失败返回稳定标记。 */
function toolVersion(command, args) {
	const output = capture(command, args);
	return output === null ? "unavailable" : output;
}

// ── 指纹与 stamp ──────────────────────────────────────────────────────────────

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hashString(value) {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** 组装影响输出字节的已知输入并求指纹。 */
function buildFingerprint({ rawWasmSha256, bindgenVersion, optVersion, optEnabled }) {
	const inputs = {
		rawWasmSha256,
		profile,
		keepNames,
		modelBatchStrategy,
		renderDrawDiagnostics,
		bindgenVersion,
		bindgenArgs: ["--target", "web", "--out-name", OUT_NAME],
		opt: optEnabled ? { command: "wasm-opt", args: optArgs, version: optVersion } : { skipped: true },
		gluePostprocess: GLUE_POSTPROCESS_VERSION,
		dtsTemplate: DTS_TEMPLATE_VERSION,
		outName: OUT_NAME,
	};
	const fingerprint = hashString(JSON.stringify(inputs));
	return { inputs, fingerprint };
}

function readStamp() {
	if (!existsSync(stampPath)) return null;
	try {
		return JSON.parse(readFileSync(stampPath, "utf8"));
	} catch {
		return null;
	}
}

/** 必需输出是否齐全（字体由独立同步脚本补齐，不在此判定）。 */
function missingOutputs() {
	const missing = [];
	if (!existsSync(join(outDir, glueName))) missing.push(glueName);
	if (!existsSync(join(outDir, wasmName))) missing.push(wasmName);
	if (!existsSync(join(outDir, dtsName))) missing.push(dtsName);
	return missing;
}

// ── 产物生成 ──────────────────────────────────────────────────────────────────

/** Vite 只对 `new URL('./relative', import.meta.url)` 做静态资源改写：补上 `./`。 */
function postprocessGlue(source) {
	return source.replace(
		/new URL\((['"])woohaa_bevy_canvas_bg\.wasm\1, import\.meta\.url\)/,
		"new URL('./woohaa_bevy_canvas_bg.wasm', import.meta.url)"
	);
}

/**
 * 生成到临时目录后原子替换到输出目录。
 *
 * 失败或中断时保留上一次完整产物（临时目录被清理），且不写 stamp。
 */
function generate({ optEnabled, rawWasmSha256, fingerprint, timings }) {
	const staging = join(outDir, `.staging-${process.pid}`);
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	try {
		timings.bindgen = run("wasm-bindgen", [
			rawArtifact,
			"--target",
			"web",
			"--out-dir",
			staging,
			"--out-name",
			OUT_NAME,
		]);

		const stagedWasm = join(staging, wasmName);
		if (optEnabled) {
			const optimized = join(staging, `${OUT_NAME}_bg.optimized.wasm`);
			const start = now();
			const result = spawnSync("wasm-opt", [...optArgs, stagedWasm, "-o", optimized], { stdio: "inherit" });
			timings.opt = secondsSince(start);
			if (result.error || result.status !== 0) {
				timings.optSkipped = true;
				console.warn("⚠ 未运行 wasm-opt（缺失或失败），保留未优化产物");
			} else {
				timings.optSkipped = false;
				renameSync(optimized, stagedWasm);
			}
		} else {
			timings.opt = 0;
			timings.optSkipped = true;
		}

		// glue 后处理：稳定 URL 改写。
		const stagedGlue = join(staging, glueName);
		writeFileSync(stagedGlue, postprocessGlue(readFileSync(stagedGlue, "utf8")));
		// 稳定 d.ts（不被 wasm-bindgen 覆盖）。
		writeFileSync(join(staging, dtsName), STABLE_DTS);

		// 原子替换：同文件系统 rename。
		const syncStart = now();
		for (const name of [glueName, wasmName, dtsName]) {
			renameSync(join(staging, name), join(outDir, name));
		}
		// 字体等运行资源由共享同步模块复制（与 dev/config 入口同一份实现）。
		syncBevyAssets();
		timings.sync = secondsSince(syncStart);

		writeFileSync(
			stampPath,
			JSON.stringify(
				{
					version: 1,
					fingerprint,
					profile,
					keepNames,
					modelBatchStrategy,
					renderDrawDiagnostics,
					optEnabled,
					optSkipped: timings.optSkipped,
					rawWasmSha256,
					createdAt: new Date().toISOString(),
				},
				null,
				2
			) + "\n"
		);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

function main() {
	if (!["automatic", "spatial", "explicit"].includes(modelBatchStrategy)) {
		throw new Error("WOOHAA_STATIC_BATCH_STRATEGY must be automatic, spatial or explicit");
	}
	if (!["0", "1"].includes(renderDrawDiagnostics)) {
		throw new Error("WOOHAA_RENDER_DRAW_DIAGNOSTICS must be 0 or 1");
	}
	const timings = { cargo: 0, bindgen: 0, opt: 0, sync: 0, optSkipped: false };
	const totalStart = now();

	console.log(`[bevy-wasm] 模式：profile=${profile}，staticBatchStrategy=${modelBatchStrategy}，names=${keepNames ? "retained" : "default"}，optimize=${skipOpt ? "skipped" : `wasm-opt ${optArgs.join(" ")}`}`);

	Object.assign(env, wasmCompilerEnvironment({ env }));

	// 1. Cargo（增量）。
	timings.cargo = run(
		"cargo",
		["build", "--target", "wasm32-unknown-unknown", "-j", process.env.CARGO_BUILD_JOBS ?? "8", ...(modelBatchStrategy === "explicit" ? ["--features", "explicit-instancing"] : []), ...(release ? ["--release"] : [])],
		crate
	);
	if (!existsSync(rawArtifact)) throw new Error(`缺少 WASM 产物 ${rawArtifact}`);

	// 2. 指纹（Cargo 之后，raw wasm 已确定）。
	const rawWasmSha256 = sha256File(rawArtifact);
	const bindgenVersion = toolVersion("wasm-bindgen", ["--version"]);
	const optEnabled = !skipOpt;
	const optVersion = optEnabled ? toolVersion("wasm-opt", ["--version"]) : "skipped";
	const { fingerprint } = buildFingerprint({ rawWasmSha256, bindgenVersion, optVersion, optEnabled });

	// 3. 缓存判定。
	const stamp = readStamp();
	const missing = missingOutputs();
	let missReason = null;
	if (!stamp) missReason = "缺少 stamp";
	else if (stamp.fingerprint !== fingerprint) missReason = "指纹变化（raw wasm/模式/工具版本/参数）";
	else if (missing.length > 0) missReason = `缺少产物：${missing.join(", ")}`;

	mkdirSync(outDir, { recursive: true });

	if (missReason === null) {
		// 命中：绑定产物已就绪；仅在字体缺失时补齐（上面已把字体计入 missing，故此处仅日志）。
		console.log(
			`[bevy-wasm] cache hit（profile=${profile}，names=${keepNames ? "retained" : "default"}，opt=${stamp.optEnabled && !stamp.optSkipped ? `wasm-opt ${optArgs.join(" ")}` : "skipped"}，` +
				`fingerprint=${fingerprint}）`
		);
	} else {
		console.log(`[bevy-wasm] cache miss：${missReason}`);
		generate({ optEnabled, rawWasmSha256, fingerprint, timings });
	}

	const total = secondsSince(totalStart);
	const optLabel = timings.optSkipped ? "skipped" : fmt(timings.opt);
	console.log(
		`[bevy-wasm] 耗时：cargo=${fmt(timings.cargo)} bindgen=${fmt(timings.bindgen)} ` +
			`opt=${optLabel} sync=${fmt(timings.sync)} total=${fmt(total)}`
	);
	console.log(`✓ Bevy WASM 就绪 → ${outDir}（字体 → ${BEVY_ASSETS_TARGET_DIR}，优化=${optEnabled && !timings.optSkipped ? "on" : "off"}）`);
}

try {
	main();
} catch (error) {
	console.error(`✗ Bevy WASM 构建失败：${error?.message ?? error}`);
	process.exit(error?.exitCode ?? 1);
}
