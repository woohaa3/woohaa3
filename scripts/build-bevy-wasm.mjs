// 构建 Woohaa3 Bevy WASM 运行时并生成 wasm-bindgen web 绑定。
//
//   node scripts/build-bevy-wasm.mjs [--mode development|performance|release] [--keep-names]
//   node scripts/build-bevy-wasm.mjs --dev        # 开发入口：读 WOOHAA_BEVY_DEV_MODE，缺省 development
//
// 模式（change: 2026-10-23-optimize-bevy-development-build，design D1/D2）：
//   - `development`  Cargo dev profile（增量）+ 跳过 wasm-opt，普通开发默认。
//   - `performance`  Cargo release + `wasm-opt -Oz -g`，保留 Rust 函数名，用于性能采集。
//   - `release`      Cargo release + `wasm-opt -Oz`，生产发布默认。
//   旧参数继续可用：`--debug --skip-opt` = development；单独 `--debug`、`--skip-opt` 保留为
//   明确记录的手动组合（stamp 记作 `manual-*`，不冒充正式产物）。显式 performance/release
//   与 `--debug` / `--skip-opt` 冲突时在启动 Cargo 前失败。
//
// 缓存（design D4/D5）：Cargo 结束后计算原始 `.wasm` 的 SHA-256，与模式、profile、符号开关、
// 工具版本/参数、glue 后处理版本和稳定 d.ts 模板版本组成指纹；stamp 另记 JS/WASM/d.ts 的
// 内容摘要。命中要求指纹一致 **且** 当前输出摘要与记录一致，损坏或缺字段一律 miss。
// 产物先写 staging，再在进程互斥内提交；提交失败回滚旧产物，stamp 最后发布。
//
// 路径与并发（design D3）：raw WASM 与 stamp 位置取自与构建同 cwd/环境/工具链的 Cargo
// metadata `target_directory`，不硬编码 `bevy/target`；不传固定 `-j`，遵循 Cargo 默认与
// `CARGO_BUILD_JOBS` 的原生语义。
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
	readdirSync
} from "node:fs";
import { homedir, hostname } from "node:os";
import { delimiter, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { wasmCompilerEnvironment } from "./lib/wasm-compiler.mjs";
import { parseBuildModeArgs, resolveBuildMode, DEV_MODE_ENV } from "./lib/bevy-build-mode.mjs";
import { resolveRendererBackend, RENDERER_OVERRIDE_ENV } from "./lib/gpu-renderer-selection.mjs";
import { syncBevyAssets, BEVY_ASSETS_TARGET_DIR } from "./sync-bevy-assets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const crate = join(root, "bevy");
const outDir = join(root, "web", "frontend", "src", "bevy-wasm");
/** 跨进程互斥目录：与产物同仓但被 Git 忽略（`.local/`），按输出目录区分。 */
const lockRoot = join(root, ".local", "locks");

/** stamp 结构版本；旧版缺失模式/输出摘要时一次性失效，不迁移成命中。 */
const STAMP_VERSION = 3;
/** glue 后处理与稳定 d.ts 模板的版本；任一改动都必须使缓存失效。 */
const GLUE_POSTPROCESS_VERSION = "3";
// change: 2026-10-26-move-generation-history-to-ai-center —— 新增
// request_history_thumbnail / poll_history_thumbnail 导出，模板版本提升。
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
// change: 2026-10-28-fix-stuck-shot-capture-pin —— 新增 cancel_shot_capture 导出，模板版本提升。
// change: 2026-11-04-page-render-world-capture —— 新增 request_world_capture / poll_world_capture
// 导出，模板版本提升使缓存失效。
// 2026-11-05：移除随片场组下线的 query_composite_asset_* / overview_cache_* 声明。
const DTS_TEMPLATE_VERSION = "16";

const OUT_NAME = "woohaa_bevy_canvas";
const glueName = `${OUT_NAME}.js`;
const wasmName = `${OUT_NAME}_bg.wasm`;
const dtsName = `${OUT_NAME}.d.ts`;
const REQUIRED_OUTPUTS = [glueName, wasmName, dtsName];

const modelBatchStrategy = process.env.WOOHAA_STATIC_BATCH_STRATEGY ?? "spatial";
const renderDrawDiagnostics = process.env.WOOHAA_RENDER_DRAW_DIAGNOSTICS ?? "1";

/** 手工维护的稳定类型面；与 Rust `#[wasm_bindgen]` 导出一致。 */
const STABLE_DTS = `// wasm-bindgen 生成的 Bevy 运行时 glue 的稳定类型面
// （由 scripts/build-bevy-wasm.mjs 生成 \`woohaa_bevy_canvas.js\` / \`_bg.wasm\`）。
//
// 本 \`.d.ts\` **手工维护**，保证未运行 wasm 构建时 \`tsc\` 仍可解析模块。导出签名必须与
// Rust \`bevy/src/lib.rs\` 的 \`#[wasm_bindgen]\` 导出保持一致。

export function seed_runtime_generation(previous: number): void;
export function runtime_health(): string;
export function benchmark_frames(enabled?: boolean): string;
export function benchmark_media(enabled?: boolean): string;
export function is_ready(): boolean;
export function rendered_revision(): number;
export function set_scene(json: string): number;
export function set_texture(id: string, width: number, height: number, rgba: Uint8Array, content: string): void;
export function set_image_focus_details(manifest:string,pixels:Uint8Array):void;
export function set_model_media_texture(id: string, width: number, height: number, rgba: Uint8Array): void;
export function poll_texture_receipts(): string;
export function set_resource_states(json: string): number;
export function set_idle_frame_pacing(enabled?: boolean): void;
export function request_shot_capture(json: string): void;
export function poll_shot_capture(requestId: number, generation: number): Uint8Array;
export function cancel_shot_capture(requestId: number): void;
export function request_history_thumbnail(json: string): void;
export function poll_history_thumbnail(requestId: number, generation: number): Uint8Array;
export function request_world_capture(json: string): void;
export function poll_world_capture(requestId: number, generation: number): Uint8Array;
export function shot_diagnostics(): string;
export function start(): void;
export function query_point_hit(json: string): string;
export function query_marquee(json: string): string;
export function query_probe(json: string): string;
export function query_drop_target(json: string): string;
export function query_model_pick(json: string): string;
export function query_model_marquee(json: string): string;
export function query_gizmo_hit(json: string): string;
export function prepare_and_register_model_resource(json: string): string;
export function declare_model_resource(json: string): string;
export function set_model_payload_leases(json: string): string;
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

const env = { ...process.env, PATH: `${join(homedir(), ".cargo", "bin")}${delimiter}${process.env.PATH ?? ""}` };

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

/** 捕获命令 stdout；失败返回 null（用于工具版本与 metadata 探测）。 */
function capture(command, args, cwd = crate) {
	const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
	if (result.error || result.status !== 0) return null;
	return (result.stdout ?? "").trim();
}

/** 工具版本探测：缺失或失败返回稳定标记。 */
function toolVersion(command, args) {
	const output = capture(command, args);
	return output === null ? "unavailable" : output;
}

// ── Cargo 事实 ────────────────────────────────────────────────────────────────

/**
 * 用与 build 相同 cwd、环境与工具链的 Cargo metadata 解析实际 target 目录。
 *
 * 支持 `CARGO_TARGET_DIR` 与 Cargo 配置里的相对/绝对 `target-dir`，解析失败时明确失败，
 * 不回退读取默认目录下的旧产物（design D3）。
 */
function resolveTargetDirectory() {
	const stdout = capture("cargo", ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", join(crate, "Cargo.toml")], crate);
	if (stdout === null) {
		throw new Error("无法解析 Cargo metadata：请确认 Rust 工具链可用（cargo metadata 失败）");
	}
	let metadata;
	try {
		metadata = JSON.parse(stdout);
	} catch {
		throw new Error("Cargo metadata 输出不是合法 JSON，无法确定 target 目录");
	}
	if (typeof metadata.target_directory !== "string" || metadata.target_directory.length === 0) {
		throw new Error("Cargo metadata 未给出 target_directory，拒绝回退到默认 target 目录");
	}
	return metadata.target_directory;
}

/** 并发配置：不传固定 `-j`；显式值只用于日志。 */
function jobsLabel() {
	const configured = process.env.CARGO_BUILD_JOBS;
	if (configured === undefined || configured === "") return "Cargo 默认";
	return `CARGO_BUILD_JOBS=${configured}`;
}

// ── 跨进程互斥 ────────────────────────────────────────────────────────────────

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

/** 同步等待；共享前端输出目录的争用发生在启动阶段，阻塞等待比轮询定时器更简单可靠。 */
function sleepSync(milliseconds) {
	Atomics.wait(sleepBuffer, 0, 0, milliseconds);
}

function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

function lockPath() {
	const key = createHash("sha256").update(outDir).digest("hex").slice(0, 12);
	return join(lockRoot, `bevy-wasm-${key}.lock`);
}

/**
 * 取得输出目录的独占锁。
 *
 * 锁是 `mkdir` 出来的目录（原子创建），owner 文件记录 pid/host/时间。持有者被杀后：
 * 同主机按 pid 判活恢复；跨主机或 pid 复用无法判定时，超过过期时间也回收，避免无限等待。
 */
function acquireLock({ staleAfterMs = 30 * 60 * 1000 } = {}) {
	const path = lockPath();
	mkdirSync(lockRoot, { recursive: true });
	const ownerFile = join(path, "owner.json");
	const started = now();
	let waited = 0;
	for (;;) {
		try {
			mkdirSync(path);
			writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
			if (waited > 0) console.log(`[bevy-wasm] 取得构建锁（等待 ${fmt(secondsSince(started))}）`);
			return { path, waited: secondsSince(started) };
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			const recovered = recoverStaleLock(path, ownerFile, staleAfterMs);
			if (recovered) {
				console.warn(`[bevy-wasm] 回收残留构建锁：${recovered}`);
				continue;
			}
			if (waited === 0) console.log("[bevy-wasm] 另一个构建正在写入同一输出目录，等待其完成…");
			waited += 1;
			sleepSync(200);
		}
	}
}

function recoverStaleLock(path, ownerFile, staleAfterMs) {
	let owner;
	try {
		owner = JSON.parse(readFileSync(ownerFile, "utf8"));
	} catch {
		// 目录已建立但 owner 尚未写入：持有者刚启动，交给下一次轮询。
		return null;
	}
	if (owner.host === hostname() && Number.isInteger(owner.pid) && !processAlive(owner.pid)) {
		rmSync(path, { recursive: true, force: true });
		return `持有进程 ${owner.pid} 已退出`;
	}
	if (Date.now() - Date.parse(owner.startedAt ?? 0) > staleAfterMs) {
		rmSync(path, { recursive: true, force: true });
		return `锁记录过期（owner ${owner.host}/${owner.pid}）`;
	}
	return null;
}

function releaseLock(lock) {
	rmSync(lock.path, { recursive: true, force: true });
}

// ── 指纹与 stamp ──────────────────────────────────────────────────────────────

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(value) {
	return createHash("sha256").update(value).digest("hex");
}

function hashString(value) {
	return sha256Text(value).slice(0, 16);
}

/** 当前输出目录里各产物的内容摘要；缺失记 null。 */
function outputDigests() {
	const digests = {};
	for (const name of REQUIRED_OUTPUTS) {
		const path = join(outDir, name);
		digests[name] = existsSync(path) ? sha256File(path) : null;
	}
	return digests;
}

/** 组装影响输出字节的已知输入并求指纹（design D4）。 */
function buildFingerprint({ rawWasmSha256, plan, bindgenVersion, optIdentity, renderer }) {
	const inputs = {
		rawWasmSha256,
		mode: plan.mode,
		profile: plan.profile,
		keepNames: plan.keepNames,
		modelBatchStrategy,
		renderDrawDiagnostics,
		rendererBackend: renderer.backend,
		bindgenVersion,
		bindgenArgs: ["--target", "web", "--out-name", OUT_NAME],
		opt: optIdentity,
		gluePostprocess: GLUE_POSTPROCESS_VERSION,
		dtsTemplate: DTS_TEMPLATE_VERSION,
		outName: OUT_NAME
	};
	return { inputs, fingerprint: hashString(JSON.stringify(inputs)) };
}

function readStamp() {
	if (!existsSync(stampPath())) return null;
	try {
		return JSON.parse(readFileSync(stampPath(), "utf8"));
	} catch (error) {
		return { unreadable: error.message };
	}
}

// 由 target 目录解析后填值（见 main）。
let targetDirectory;
function stampPath() {
	return join(targetDirectory, "bevy-wasm-build.stamp.json");
}

/**
 * 判定缓存。
 *
 * 命中条件：stamp 结构版本/模式/指纹一致，且当前 JS/WASM/d.ts 摘要与 stamp 记录逐项一致。
 * 任一缺失、损坏或记录不完整都返回可操作的 miss 原因。
 *
 * 优化状态不参与「是否命中」的额外判定：工具缺失时指纹本来就不同，工具恢复后必然 miss 并重新优化。
 */
function evaluateCache({ stamp, fingerprint, plan }) {
	if (!stamp) return "缺少 stamp";
	if (stamp.unreadable) return `stamp 无法解析（${stamp.unreadable}）`;
	if (stamp.version !== STAMP_VERSION) return `stamp 版本过期（${stamp.version ?? "无"} → ${STAMP_VERSION}）`;
	if (stamp.mode !== plan.mode) return `模式变化（${stamp.mode ?? "无"} → ${plan.mode}）`;
	if (stamp.fingerprint !== fingerprint) return "指纹变化（raw wasm/模式/工具版本/参数）";
	const current = outputDigests();
	const missing = REQUIRED_OUTPUTS.filter((name) => current[name] === null);
	if (missing.length > 0) return `缺少产物：${missing.join(", ")}`;
	const changed = REQUIRED_OUTPUTS.filter((name) => stamp.outputs?.[name] !== current[name]);
	if (changed.length > 0) return `产物内容与成功记录不一致：${changed.join(", ")}`;
	return null;
}

// ── 产物生成 ──────────────────────────────────────────────────────────────────

/** Vite 只对 `new URL('./relative', import.meta.url)` 做静态资源改写：补上 `./`。 */
function postprocessGlue(source) {
	return source.replace(
		/new URL\((['"])woohaa_bevy_canvas_bg\.wasm\1, import\.meta\.url\)/,
		"new URL('./woohaa_bevy_canvas_bg.wasm', import.meta.url)"
	);
}

/** 跑 wasm-opt，区分「未安装」「已启动但失败」与「手动跳过」（design D5）。 */
function optimize({ plan, input }) {
	if (!plan.optArgs) {
		return { skipped: true, reason: plan.mode === "development" ? "development" : "manual", args: null, version: "skipped" };
	}
	const version = toolVersion("wasm-opt", ["--version"]);
	if (version === "unavailable") {
		if (plan.mode === "performance") {
			throw new Error("performance 模式需要 wasm-opt（Binaryen），当前未安装；拒绝发布未优化产物作为性能采集基线");
		}
		console.warn("⚠ 未运行 wasm-opt（缺失），保留未优化产物；安装 Binaryen 后重新构建以取得优化产物");
		return { skipped: true, reason: "missing-tool", args: plan.optArgs, version };
	}
	const output = `${input}.optimized.wasm`;
	const start = now();
	const result = spawnSync("wasm-opt", [...plan.optArgs, input, "-o", output], { env, stdio: "inherit" });
	const elapsed = secondsSince(start);
	if (result.error) {
		throw new Error(`wasm-opt 启动失败：${result.error.message}`, { cause: result.error });
	}
	if (result.status !== 0) {
		rmSync(output, { force: true });
		const error = new Error(`wasm-opt 返回 exit ${result.status}；不发布未优化产物`);
		error.exitCode = result.status ?? 1;
		throw error;
	}
	renameSync(output, input);
	return { skipped: false, reason: null, args: plan.optArgs, version, elapsed };
}

/** 清掉上次中断留下的 staging 目录；只有在持锁时才调用（此时没有其它构建在写）。 */
function clearStaleStaging() {
	const removed = [];
	for (const entry of readdirSync(outDir)) {
		if (!entry.startsWith(".staging-")) continue;
		if (entry === `.staging-${process.pid}`) continue;
		rmSync(join(outDir, entry), { recursive: true, force: true });
		removed.push(entry);
	}
	return removed;
}

/**
 * 生成到 staging，最后在互斥内提交。
 *
 * 失败或中断时保留上一次完整产物（staging 被清理），且不写 stamp；提交中途失败则回滚。
 */
function generate({ plan, renderer, rawWasmSha256, fingerprint, timings }) {
	const staging = join(outDir, `.staging-${process.pid}`);
	const rollback = join(staging, ".rollback");
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
			OUT_NAME
		]);

		const optimized = optimize({ plan, input: join(staging, wasmName) });
		timings.opt = optimized.elapsed ?? 0;
		timings.optSkipped = optimized.skipped;
		timings.optReason = optimized.reason;

		// glue 后处理：稳定 URL 改写。
		const stagedGlue = join(staging, glueName);
		writeFileSync(stagedGlue, postprocessGlue(readFileSync(stagedGlue, "utf8")));
		// 稳定 d.ts（不被 wasm-bindgen 覆盖）。
		writeFileSync(join(staging, dtsName), STABLE_DTS);

		// 提交：先把旧产物挪进 rollback，再 rename 新产物；任一失败整体回滚。
		const syncStart = now();
		mkdirSync(rollback, { recursive: true });
		const committed = [];
		try {
			for (const name of REQUIRED_OUTPUTS) {
				const target = join(outDir, name);
				if (existsSync(target)) {
					renameSync(target, join(rollback, name));
					committed.push(name);
				}
				renameSync(join(staging, name), target);
			}
		} catch (error) {
			for (const name of REQUIRED_OUTPUTS) {
				const target = join(outDir, name);
				const saved = join(rollback, name);
				if (existsSync(saved)) {
					rmSync(target, { force: true });
					renameSync(saved, target);
				} else if (!committed.includes(name)) {
					// 新产物已写入但旧产物不存在：删掉半成品，保持「没有完整输出」而不是半套。
					rmSync(target, { force: true });
				}
			}
			throw error;
		}
		// 字体等运行资源由共享同步模块复制（与 dev/config 入口同一份实现）。
		syncBevyAssets();
		timings.sync = secondsSince(syncStart);

		const committedDigests = outputDigests();
		rmSync(rollback, { recursive: true, force: true });

		// stamp 最后发布：写临时文件再 rename，避免读到半个 JSON。临时文件必须落在 stamp 的
		// 同一目录：stamp 位于 Cargo target 目录，目标目录与输出目录可能不在同一挂载点（例如
		// CARGO_TARGET_DIR 指向另一块盘），跨设备 rename 会 EXDEV。
		const stampTarget = stampPath();
		mkdirSync(dirname(stampTarget), { recursive: true });
		const stagingStamp = join(dirname(stampTarget), `.stamp-${process.pid}.json`);
		writeFileSync(
			stagingStamp,
			JSON.stringify(
				{
					version: STAMP_VERSION,
					mode: plan.mode,
					rendererBackend: renderer.backend,
					rendererSelection: renderer.source,
					buildMachineGpu: renderer.hasGpu,
					rendererEvidence: renderer.evidence,
					profile: plan.profile,
					keepNames: plan.keepNames,
					release: plan.release,
					modelBatchStrategy,
					renderDrawDiagnostics,
					optEnabled: plan.optArgs !== null,
					optSkipped: timings.optSkipped,
					optReason: timings.optReason,
					opt: { args: plan.optArgs, version: optimized.version },
					fingerprint,
					rawWasmSha256,
					targetDirectory,
					outputs: committedDigests,
					createdAt: new Date().toISOString()
				},
				null,
				2
			) + "\n"
		);
		renameSync(stagingStamp, stampTarget);
		return { digests: committedDigests, optimized };
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}


// ── 主流程 ────────────────────────────────────────────────────────────────────

let rawArtifact;

const USAGE = `构建 Woohaa3 Bevy WASM 运行时并生成前端绑定。

  node scripts/build-bevy-wasm.mjs [--mode development|performance|release] [--keep-names]
  node scripts/build-bevy-wasm.mjs --dev     # 开发入口：读 WOOHAA_BEVY_DEV_MODE，缺省 development

模式：
  development  Cargo dev profile（增量）+ 跳过 wasm-opt，保留 Rust 函数名；普通开发默认。
  performance  Cargo release + wasm-opt -Oz -g，保留函数名；用于本地性能采集。
  release      Cargo release + wasm-opt -Oz；生产发布默认（不指定 --mode 时仍是 release）。

兼容参数：
  --debug --skip-opt            等价于 --mode development。
  --debug                       手动组合：debug profile、保留符号、照常 wasm-opt -Oz -g。
  --skip-opt                    手动组合：release profile、不优化（stamp 记作 manual-skip-opt）。
  --keep-names                  只追加 -g 保留符号，不改变优化级别、不切换模式。

开发入口：
  WOOHAA_BEVY_DEV_MODE=performance pnpm dev     # 本地性能采集，等价于 performance 模式
  WOOHAA_BEVY_DEV_MODE 只接受 development / performance；release 只能由生产入口显式请求。

渲染后端：
  默认先探测构建机真实 GPU：有 GPU 编译 WebGPU，没有 GPU 编译 WebGL2。
  ${RENDERER_OVERRIDE_ENV}=webgpu|webgl2 可显式覆盖；auto 或未设置恢复自动探测。

缓存与诊断：
  相同模式与相同 raw WASM 命中时跳过 bindgen/wasm-opt；日志报告模式、profile、实际 target、
  并发配置、互斥等待和各阶段耗时。缓存记录与当前输出摘要不一致时必须重建。
`;

function main() {
	const parsed = parseBuildModeArgs(process.argv.slice(2));
	if (parsed.help) {
		console.log(USAGE);
		return;
	}
	const plan = resolveBuildMode(parsed, { env: process.env });
	const renderer = resolveRendererBackend({ env: process.env });
	if (!["automatic", "spatial", "explicit"].includes(modelBatchStrategy)) {
		throw new Error("WOOHAA_STATIC_BATCH_STRATEGY must be automatic, spatial or explicit");
	}
	if (!["0", "1"].includes(renderDrawDiagnostics)) {
		throw new Error("WOOHAA_RENDER_DRAW_DIAGNOSTICS must be 0 or 1");
	}

	const timings = { cargo: 0, bindgen: 0, opt: 0, sync: 0, optSkipped: false, optReason: null, lockWait: 0 };
	/** 本次产物的实际优化状态：命中时取自成功记录，重建时来自实际执行结果。 */
	let optimized = null;
	const totalStart = now();

	console.log(
		`[bevy-wasm] 模式=${plan.mode}（profile=${plan.profile}，names=${plan.keepNames ? "retained" : "default"}，` +
			`optimize=${plan.optArgs ? `wasm-opt ${plan.optArgs.join(" ")}` : "skipped"}，jobs=${jobsLabel()}` +
			`${parsed.devEntry ? `，来源=${DEV_MODE_ENV}` : ""}${plan.legacy ? "，legacy 参数" : ""}）`
	);
	console.log(
		`[bevy-wasm] renderer=${renderer.backend}（来源=${renderer.source}，构建机 GPU=${renderer.hasGpu === null ? "override" : renderer.hasGpu ? "yes" : "no"}，探测=${renderer.evidence}）`
	);
	Object.assign(env, wasmCompilerEnvironment({ env }));

	// performance 必须真正优化过：缺工具时在 Cargo 之前失败，不浪费一次 release 编译。
	if (plan.mode === "performance" && toolVersion("wasm-opt", ["--version"]) === "unavailable") {
		throw new Error("performance 模式需要 wasm-opt（Binaryen），当前未安装；拒绝发布未优化产物作为性能采集基线");
	}

	// 1. 解析实际 target 目录（与 build 同 cwd/环境/工具链）。
	const metadataStart = now();
	targetDirectory = resolveTargetDirectory();
	rawArtifact = join(targetDirectory, "wasm32-unknown-unknown", plan.profile, `${OUT_NAME}.wasm`);
	console.log(`[bevy-wasm] target=${targetDirectory}（解析 ${fmt(secondsSince(metadataStart))}）`);

	// 2. 从 Cargo 到 stamp 都在输出目录的跨进程锁内（design D4）。
	const lock = acquireLock();
	try {
		timings.lockWait = lock.waited;

		// 3. Cargo（增量）；不传固定 -j，遵循 Cargo 默认与 CARGO_BUILD_JOBS。
		timings.cargo = run(
			"cargo",
			[
				"build",
				"--target",
				"wasm32-unknown-unknown",
				"--no-default-features",
				"--features",
				[
					renderer.backend === "webgpu" ? "wasm-webgpu" : "wasm-webgl2",
					...(modelBatchStrategy === "explicit" ? ["explicit-instancing"] : [])
				].join(","),
				...(plan.release ? ["--release"] : [])
			],
			crate
		);
		if (!existsSync(rawArtifact)) {
			throw new Error(`缺少 WASM 产物 ${rawArtifact}（target 目录由 Cargo metadata 解析）`);
		}

		// 4. 指纹（Cargo 之后，raw wasm 已确定）。
		const rawWasmSha256 = sha256File(rawArtifact);
		const bindgenVersion = toolVersion("wasm-bindgen", ["--version"]);
		const normalizedBindgen = describeBindgen(bindgenVersion);
		const optIdentity = plan.optArgs
			? { command: "wasm-opt", args: plan.optArgs, version: toolVersion("wasm-opt", ["--version"]) }
			: { skipped: true, reason: plan.mode === "development" ? "development" : "manual" };
		const { fingerprint } = buildFingerprint({
			rawWasmSha256,
			plan,
			renderer,
			bindgenVersion: normalizedBindgen,
			optIdentity
		});

		// 5. 缓存判定。残留 staging 只可能是上次中断/被杀留下的，持锁时清掉，避免被误当产物。
		mkdirSync(outDir, { recursive: true });
		const stale = clearStaleStaging();
		if (stale.length > 0) console.log(`[bevy-wasm] 清理残留 staging：${stale.join(", ")}`);
		const missReason = evaluateCache({ stamp: readStamp(), fingerprint, plan });
		if (missReason === null) {
			// 命中时优化状态来自记录：release 缺工具时写过降级记录，这里不能报成优化成功。
			const stamp = readStamp();
			optimized = { skipped: stamp?.optSkipped === true, reason: stamp?.optReason ?? null, version: stamp?.opt?.version ?? "unknown" };
			console.log(
				`[bevy-wasm] cache hit（mode=${plan.mode}，opt=${optimized.skipped ? `skipped(${optimized.reason ?? "未优化"})` : `wasm-opt ${plan.optArgs.join(" ")}`}，fingerprint=${fingerprint}）`
			);
		} else {
			console.log(`[bevy-wasm] cache miss：${missReason}`);
			const generated = generate({ plan, renderer, rawWasmSha256, fingerprint, timings });
			optimized = generated.optimized;
		}
	} finally {
		releaseLock(lock);
	}

	const total = secondsSince(totalStart);
	const optLabel = timings.optSkipped ? `skipped${timings.optReason ? `(${timings.optReason})` : ""}` : fmt(timings.opt);
	console.log(
		`[bevy-wasm] 耗时：cargo=${fmt(timings.cargo)} bindgen=${fmt(timings.bindgen)} ` +
			`opt=${optLabel} sync=${fmt(timings.sync)} lock-wait=${fmt(timings.lockWait)} total=${fmt(total)}`
	);
	const isOptimized = plan.optArgs !== null && optimized?.skipped !== true;
	console.log(
		`✓ Bevy WASM 就绪 → ${outDir}（模式=${plan.mode}，字体 → ${BEVY_ASSETS_TARGET_DIR}，` +
			`优化=${isOptimized ? "on" : "off"}）`
	);
	// release 缺工具的降级必须能被调用方明确识别，不能只靠一行警告。
	if (plan.optArgs !== null && !isOptimized) {
		console.warn(
			`⚠ ${plan.mode} 产物未优化（${optimized?.reason ?? "未知原因"}）：该产物不是本次模式的优化成功结果，安装 wasm-opt 后重新构建`
		);
	}
}

/** `wasm-bindgen 0.2.129` → `0.2.129`；保持与旧 stamp 的可读性，不影响命中语义。 */
function describeBindgen(version) {
	return version.replace(/^wasm-bindgen\s+/, "");
}

try {
	main();
} catch (error) {
	console.error(`✗ Bevy WASM 构建失败：${error?.message ?? error}`);
	process.exit(error?.exitCode ?? 1);
}
