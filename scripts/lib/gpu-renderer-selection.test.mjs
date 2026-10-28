import { test } from "node:test";
import { strict as assert } from "node:assert";
import { probeBuildGpu, resolveRendererBackend } from "./gpu-renderer-selection.mjs";

test("macOS uses system_profiler and recognizes Apple GPU", () => {
	const result = probeBuildGpu({
		platform: "darwin",
		exec: () => "Displays:\n  Chipset Model: Apple M4 Pro\n"
	});
	assert.equal(result.hasGpu, true);
	assert.equal(result.evidence, "system_profiler SPDisplaysDataType");
});

test("Linux only recognizes renderD devices", () => {
	assert.equal(probeBuildGpu({ platform: "linux", readDir: () => ["card0", "renderD128"] }).hasGpu, true);
	assert.equal(probeBuildGpu({ platform: "linux", readDir: () => ["card0"] }).hasGpu, false);
});

test("Windows ignores virtual display adapters", () => {
	const exec = () => "Microsoft Remote Display Adapter\nMicrosoft Basic Display Adapter\n";
	assert.equal(probeBuildGpu({ platform: "win32", exec }).hasGpu, false);
});

test("automatic selection maps build-machine GPU to the requested backend", () => {
	assert.equal(resolveRendererBackend({ env: {}, probe: () => ({ hasGpu: true, evidence: "test" }) }).backend, "webgpu");
	assert.equal(resolveRendererBackend({ env: {}, probe: () => ({ hasGpu: false, evidence: "test" }) }).backend, "webgl2");
});

test("explicit renderer override wins over GPU probing", () => {
	let probed = false;
	const result = resolveRendererBackend({
		env: { WOOHAA_BEVY_RENDERER: "webgl2" },
		probe: () => {
			probed = true;
			return { hasGpu: true, evidence: "test" };
		}
	});
	assert.equal(result.backend, "webgl2");
	assert.equal(result.source, "override");
	assert.equal(probed, false);
});

test("invalid renderer override fails loudly", () => {
	assert.throws(
		() => resolveRendererBackend({ env: { WOOHAA_BEVY_RENDERER: "vulkan" } }),
		/WOOHAA_BEVY_RENDERER/
	);
});
