import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

export const RENDERER_OVERRIDE_ENV = "WOOHAA_BEVY_RENDERER";
export const RENDERER_BACKENDS = ["webgpu", "webgl2"];

function windowsGraphicsAdapters({ exec = execFileSync } = {}) {
	try {
		const output = exec(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				"Get-CimInstance Win32_VideoController -Property Name | ForEach-Object { $_.Name }"
			],
			{ encoding: "utf8", timeout: 15_000 }
		);
		return String(output)
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * 探测构建机是否有真实 GPU。
 *
 * 规则与 ATC 的 probeEnvironment 保持一致：macOS 用 system_profiler，Linux 只认
 * renderD*，Windows 排除远程/虚拟显示适配器。这里的结果只影响构建产物选择，不能
 * 代替浏览器运行时的 WebGPU 能力探测。
 */
export function probeBuildGpu({
	platform = process.platform,
	readDir = readdirSync,
	exec = execFileSync
} = {}) {
	if (platform === "darwin") {
		try {
			const output = exec("/usr/sbin/system_profiler", ["SPDisplaysDataType"], { encoding: "utf8", timeout: 10_000 });
			return {
				hasGpu: /Apple (M\d|GPU)|AMD Radeon|Intel (Iris|HD|UHD)/i.test(String(output)),
				evidence: "system_profiler SPDisplaysDataType"
			};
		} catch {
			return { hasGpu: false, evidence: "system_profiler unavailable or returned no display data" };
		}
	}
	if (platform === "linux") {
		try {
			const devices = readDir("/dev/dri");
			return {
				hasGpu: devices.some((name) => /^renderD\d+$/.test(name)),
				evidence: "/dev/dri/renderD*"
			};
		} catch {
			return { hasGpu: false, evidence: "/dev/dri/renderD* unavailable" };
		}
	}
	if (platform === "win32") {
		const virtual = /Microsoft (Basic|Remote) Display|Hyper-V|VMware|VirtualBox|Parallels|Citrix|Remote Display Adapter/i;
		const adapters = windowsGraphicsAdapters({ exec });
		return {
			hasGpu: adapters.some((name) => !virtual.test(name)),
			evidence: "Win32_VideoController",
			adapters
		};
	}
	return { hasGpu: false, evidence: `unsupported platform: ${platform}` };
}

export function resolveRendererBackend({ env = process.env, probe = probeBuildGpu } = {}) {
	const override = env[RENDERER_OVERRIDE_ENV]?.trim().toLowerCase();
	if (override && override !== "auto" && !RENDERER_BACKENDS.includes(override)) {
		throw new Error(`${RENDERER_OVERRIDE_ENV} 只接受 auto、webgpu 或 webgl2（当前：${override}）`);
	}
	if (override && override !== "auto") {
		return { backend: override, source: "override", hasGpu: null, evidence: "explicit override" };
	}
	const gpu = probe();
	return {
		backend: gpu.hasGpu ? "webgpu" : "webgl2",
		source: "build-machine-gpu",
		hasGpu: gpu.hasGpu,
		evidence: gpu.evidence,
		...(gpu.adapters ? { adapters: gpu.adapters } : {})
	};
}
