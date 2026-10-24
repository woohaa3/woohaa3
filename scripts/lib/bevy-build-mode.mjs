/**
 * Bevy WASM 构建模式策略（change: 2026-10-23-optimize-bevy-development-build，design D1）。
 *
 * 三种正式模式只在这一处解析，构建脚本与开发入口共用，避免各自拼参数后互相漂移：
 *
 * | 模式 | Cargo profile | wasm-opt | Rust 函数名 | 入口 |
 * | --- | --- | --- | --- | --- |
 * | development | dev（增量，输出目录名 `debug`） | 跳过 | 保留 | 普通 dev、build:bevy:dev |
 * | performance | release | `-Oz -g` | 保留 | 显式性能采集 |
 * | release | release | `-Oz` | 默认不保留 | build:bevy、生产 build、桌面前端发行装配 |
 *
 * 开发入口用 `WOOHAA_BEVY_DEV_MODE=development|performance` 选择；该变量只在 `--dev` 入口下
 * 读取，生产入口（不带 `--dev`）不会被它影响，也不会被它降级优化。
 *
 * 参数兼容（design D1）：
 * - `--mode development|performance|release`；未指定时保持旧默认 release。
 * - 旧 `--debug --skip-opt` 映射 development。
 * - 单独 `--debug`（debug profile + 保留符号 + 照常优化）、单独 `--skip-opt`（release + 不优化）
 *   保留为明确记录的手动组合，模式身份写成 `manual-*`，不冒充正式 performance/release 产物。
 * - 显式 `--mode performance|release` 与 `--skip-opt` / `--debug` 冲突时先报错，不启动 Cargo。
 * - 未知模式或未知参数报错，不回退默认值。
 */

/** 开发入口读取的模式变量。 */
export const DEV_MODE_ENV = "WOOHAA_BEVY_DEV_MODE";

/** 开发入口允许的值：release 只能由生产入口显式请求。 */
export const DEV_ENTRY_MODES = ["development", "performance"];

export const BUILD_MODES = ["development", "performance", "release"];

const MODE_POLICY = {
	development: { profile: "debug", release: false, optimize: false, keepNames: true },
	performance: { profile: "release", release: true, optimize: true, keepNames: true },
	release: { profile: "release", release: true, optimize: true, keepNames: false }
};

/** 构建脚本 CLI 解析；未知参数一律失败，避免拼错的开关被静默忽略。 */
export function parseBuildModeArgs(argv) {
	const flags = new Set();
	let mode;
	for (let index = 0; index < argv.length; index += 1) {
		const raw = argv[index];
		if (raw === "--") continue;
		const [name, inline] = raw.split("=", 2);
		if (name === "--mode") {
			if (mode !== undefined) throw new Error("--mode 重复出现");
			const value = inline ?? argv[index + 1];
			if (value === undefined || value === "" || (inline === undefined && value.startsWith("--"))) {
				throw new Error("--mode 需要 development、performance 或 release");
			}
			if (inline === undefined) index += 1;
			mode = value;
			continue;
		}
		if (!["--dev", "--debug", "--skip-opt", "--keep-names", "--help"].includes(name)) {
			throw new Error(`未知参数：${raw}`);
		}
		if (inline !== undefined) throw new Error(`${name} 不接受取值`);
		flags.add(name);
	}
	return {
		help: flags.has("--help"),
		devEntry: flags.has("--dev"),
	mode,
		debug: flags.has("--debug"),
		skipOpt: flags.has("--skip-opt"),
		keepNames: flags.has("--keep-names")
	};
}

/** wasm-opt 参数：符号开关只影响是否带 `-g`，不改变优化级别。 */
function optArgsFor(mode, keepNames) {
	if (mode === "development") return null;
	return keepNames ? ["-Oz", "-g"] : ["-Oz"];
}

function formalPlan(mode, { keepNames = false, legacy = false } = {}) {
	const policy = MODE_POLICY[mode];
	const effectiveKeepNames = keepNames || policy.keepNames;
	const optArgs = optArgsFor(mode, effectiveKeepNames);
	return {
		mode,
		profile: policy.profile,
		release: policy.release,
		optArgs,
		keepNames: effectiveKeepNames,
		skipOpt: optArgs === null,
		legacy
	};
}

/**
 * 解析一个构建计划。
 *
 * @param {{devEntry?: boolean, mode?: string, debug?: boolean, skipOpt?: boolean, keepNames?: boolean}} options
 * @param {{env?: NodeJS.ProcessEnv}} [context] 仅 `--dev` 入口读取 `WOOHAA_BEVY_DEV_MODE`
 * @returns {{mode: string, profile: string, release: boolean, optArgs: string[]|null, keepNames: boolean, skipOpt: boolean, legacy: boolean}}
 */
export function resolveBuildMode(options = {}, context = {}) {
	const { devEntry = false, mode, debug = false, skipOpt = false, keepNames = false } = options;

	if (mode !== undefined && !BUILD_MODES.includes(mode)) {
		throw new Error(`未知构建模式：${mode}（可选 development、performance、release）`);
	}

	if (devEntry) {
		if (mode !== undefined) throw new Error("--dev 与 --mode 不能同时指定：--dev 从开发模式变量取值");
		if (debug || skipOpt) throw new Error("--dev 不接受 --debug 或 --skip-opt：开发模式已确定 profile 与优化策略");
		return formalPlan(readDevModeEnv(context.env ?? process.env));
	}

	if (mode !== undefined) {
		if (skipOpt) {
			throw new Error(
				`--mode ${mode} 不接受 --skip-opt：模式已确定优化策略；开发迭代请用 --mode development`
			);
		}
		if (mode !== "development" && debug) {
			throw new Error(
				`--mode ${mode} 不接受 --debug：该模式使用 Cargo release profile；调试开发请用 --mode development`
			);
		}
		return formalPlan(mode, { keepNames });
	}

	// 旧参数兼容：debug + skip-opt 是旧的开发组合，其余保持各自的手动语义。
	if (debug && skipOpt) return formalPlan("development", { keepNames, legacy: true });
	if (!debug && !skipOpt) return formalPlan("release", { keepNames, legacy: true });

	const manualMode = debug ? "manual-debug" : "manual-skip-opt";
	const manualKeepNames = keepNames || debug;
	return {
		mode: manualMode,
		profile: debug ? "debug" : "release",
		release: !debug,
		optArgs: skipOpt ? null : optArgsFor("release", manualKeepNames),
		keepNames: manualKeepNames,
		skipOpt,
		legacy: true
	};
}

/** 读取并校验开发模式变量；未设置时返回 development。 */
export function readDevModeEnv(env = process.env) {
	const raw = env[DEV_MODE_ENV];
	const value = raw === undefined || String(raw).trim() === "" ? "development" : String(raw).trim();
	if (!DEV_ENTRY_MODES.includes(value)) {
		throw new Error(
			`${DEV_MODE_ENV} 只接受 development 或 performance（当前：${raw}）；release 只能由生产入口显式请求`
		);
	}
	return value;
}

/**
 * 开发入口共享选择：返回可直接拼给 `build-bevy-wasm.mjs` 的参数。
 *
 * 非法变量在入口启动阶段就报错，避免先跑一遍其它构建才发现。
 */
export function resolveDevEntryArgs(env = process.env) {
	readDevModeEnv(env);
	return ["--dev"];
}
