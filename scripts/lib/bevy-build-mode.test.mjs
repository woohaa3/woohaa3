import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
	BUILD_MODES,
	DEV_MODE_ENV,
	parseBuildModeArgs,
	readDevModeEnv,
	resolveBuildMode,
	resolveDevEntryArgs
} from "./bevy-build-mode.mjs";

const plan = (argv, env = {}) => resolveBuildMode(parseBuildModeArgs(argv), { env });

test("three formal modes pick the designed profile and wasm-opt strategy", () => {
	assert.deepEqual(BUILD_MODES, ["development", "performance", "release"]);

	const development = plan(["--mode", "development"]);
	assert.equal(development.mode, "development");
	assert.equal(development.profile, "debug");
	assert.equal(development.release, false);
	assert.equal(development.optArgs, null);
	assert.equal(development.keepNames, true);

	const performance = plan(["--mode", "performance"]);
	assert.equal(performance.profile, "release");
	assert.equal(performance.release, true);
	assert.deepEqual(performance.optArgs, ["-Oz", "-g"]);
	assert.equal(performance.keepNames, true);

	const release = plan(["--mode", "release"]);
	assert.equal(release.profile, "release");
	assert.equal(release.release, true);
	assert.deepEqual(release.optArgs, ["-Oz"]);
	assert.equal(release.keepNames, false);
});

test("no mode argument keeps the historical release default", () => {
	const bare = plan([]);
	assert.equal(bare.mode, "release");
	assert.equal(bare.profile, "release");
	assert.deepEqual(bare.optArgs, ["-Oz"]);
});

test("legacy --debug --skip-opt maps to development instead of a manual mode", () => {
	const legacy = plan(["--debug", "--skip-opt"]);
	assert.equal(legacy.mode, "development");
	assert.equal(legacy.profile, "debug");
	assert.equal(legacy.optArgs, null);
	assert.equal(legacy.keepNames, true);
	assert.equal(legacy.legacy, true);
});

test("legacy single switches stay documented manual combinations", () => {
	const debugOnly = plan(["--debug"]);
	assert.equal(debugOnly.mode, "manual-debug");
	assert.equal(debugOnly.profile, "debug");
	assert.deepEqual(debugOnly.optArgs, ["-Oz", "-g"]);
	assert.equal(debugOnly.keepNames, true);

	const skipOnly = plan(["--skip-opt"]);
	assert.equal(skipOnly.mode, "manual-skip-opt");
	assert.equal(skipOnly.profile, "release");
	assert.equal(skipOnly.optArgs, null);
	assert.equal(skipOnly.skipOpt, true);

	const skipNames = plan(["--skip-opt", "--keep-names"]);
	assert.equal(skipNames.keepNames, true);
});

test("--keep-names keeps symbol retention without implying performance mode", () => {
	const release = plan(["--mode", "release", "--keep-names"]);
	assert.equal(release.mode, "release");
	assert.equal(release.keepNames, true);
	// 符号开关只追加 -g，不改变优化级别，也不把 release 变成 performance。
	assert.deepEqual(release.optArgs, ["-Oz", "-g"]);

	const plain = plan(["--mode", "release"]);
	assert.deepEqual(plain.optArgs, ["-Oz"]);

	const performance = plan(["--mode", "performance"]);
	assert.deepEqual(performance.optArgs, ["-Oz", "-g"]);
});

test("conflicting or unknown arguments are rejected before any Cargo work", () => {
	assert.throws(() => plan(["--mode", "performance", "--skip-opt"]), /不接受 --skip-opt/);
	assert.throws(() => plan(["--mode", "release", "--skip-opt"]), /不接受 --skip-opt/);
	assert.throws(() => plan(["--mode", "performance", "--debug"]), /不接受 --debug/);
	assert.throws(() => plan(["--mode", "release", "--debug"]), /不接受 --debug/);
	assert.throws(() => plan(["--mode", "turbo"]), /未知构建模式：turbo/);
	assert.throws(() => plan(["--mode", "development", "--mode", "release"]), /重复/);
	assert.throws(() => plan(["--mode"]), /--mode 需要/);
	assert.throws(() => plan(["--optimize"]), /未知参数/);
	assert.throws(() => plan(["--debug=1"]), /不接受取值/);
	// --help 不是错误，但要被解析出来交给调用方打印用法。
	assert.equal(parseBuildModeArgs(["--help"]).help, true);
});

test("--dev reads the development mode variable and rejects the release mode", () => {
	assert.equal(plan(["--dev"], {}).mode, "development");
	assert.equal(plan(["--dev"], { [DEV_MODE_ENV]: "development" }).mode, "development");
	const performance = plan(["--dev"], { [DEV_MODE_ENV]: "performance" });
	assert.equal(performance.mode, "performance");
	assert.deepEqual(performance.optArgs, ["-Oz", "-g"]);
	assert.throws(() => plan(["--dev"], { [DEV_MODE_ENV]: "release" }), /只接受 development 或 performance/);
	assert.throws(() => plan(["--dev"], { [DEV_MODE_ENV]: "turbo" }), /只接受 development 或 performance/);
	// --dev 自带 profile/优化策略，不接受手写开关。
	assert.throws(() => plan(["--dev", "--skip-opt"]), /不接受 --debug 或 --skip-opt/);
	assert.throws(() => plan(["--dev", "--debug"]), /不接受 --debug 或 --skip-opt/);
	assert.throws(() => plan(["--dev", "--mode", "release"]), /不能同时指定/);
});

test("production invocations ignore the development mode variable", () => {
	// design D1：变量只由开发入口消费；生产入口显式 release 不受影响。
	const production = plan(["--mode", "release"], { [DEV_MODE_ENV]: "performance" });
	assert.equal(production.mode, "release");
	assert.deepEqual(production.optArgs, ["-Oz"]);
	assert.equal(production.keepNames, false);

	const bareProduction = plan([], { [DEV_MODE_ENV]: "development" });
	assert.equal(bareProduction.mode, "release");
});

test("development entries share one selector and fail fast on invalid values", () => {
	assert.deepEqual(resolveDevEntryArgs({}), ["--dev"]);
	assert.equal(readDevModeEnv({}), "development");
	assert.equal(readDevModeEnv({ [DEV_MODE_ENV]: "  " }), "development");
	assert.equal(readDevModeEnv({ [DEV_MODE_ENV]: "performance" }), "performance");
	assert.throws(() => resolveDevEntryArgs({ [DEV_MODE_ENV]: "release" }), /只接受 development 或 performance/);
	assert.throws(() => resolveDevEntryArgs({ [DEV_MODE_ENV]: "fast" }), /只接受 development 或 performance/);
});
