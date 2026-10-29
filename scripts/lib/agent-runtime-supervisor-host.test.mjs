/**
 * Agent Supervisor 宿主的自动修复回归（2026-10-29）。
 *
 * 实际故障：dev 启动器拉起的 Supervisor 被外部清理后，后端仍持着原 socket 路径，
 * 每次生成只报裸的 `connect ENOENT .../supervisor.sock`，且不会自己恢复。
 * 这里用真实 Supervisor 脚本验证：进程消失后宿主会重新拉起，端点重新可用。
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSupervisorHost } from "./agent-runtime-supervisor-host.mjs";

/** client/ 仓库根：Supervisor 脚本与运行时依赖都相对它解析。 */
const root = fileURLToPath(new URL("../../", import.meta.url));

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const readState = runtimeDir => JSON.parse(fs.readFileSync(path.join(runtimeDir, "supervisor.json"), "utf8"));

test("Supervisor 进程被清理后宿主自动重启并保持端点可用", async () => {
	const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa3-supervisor-host-"));
	const logs = [];
	const host = createAgentSupervisorHost({
		root,
		runtimeDir,
		watchIntervalMs: 50,
		log: message => logs.push(message)
	});
	try {
		const first = await host.ensure();
		const firstState = await host.ping();
		assert.equal(firstState.workspaceKey, first.workspaceKey);
		assert.equal(readState(runtimeDir).pid, firstState.pid);
		host.startWatch();

		// 模拟外部清理（清理脚本 / OOM / kill -9）：socket 文件留在磁盘上，监听已消失。
		if (process.platform === "win32") process.kill(firstState.pid);
		else process.kill(firstState.pid, "SIGKILL");
		await wait(100);

		const deadline = Date.now() + 10_000;
		let restarted = null;
		while (Date.now() < deadline) {
			try {
				const state = await host.ping();
				if (state.pid !== firstState.pid) { restarted = state; break; }
			} catch { /* supervisor 正在重启 */ }
			await wait(100);
		}
		assert.ok(restarted, `Supervisor 未被自动重启；日志：${logs.join(" | ")}`);
		assert.equal(restarted.workspaceKey, first.workspaceKey);
		assert.equal(readState(runtimeDir).pid, restarted.pid);
	} finally {
		await host.stop();
		fs.rmSync(runtimeDir, { recursive: true, force: true });
	}
});

test("stop 会先停掉探活，不再重启已关闭的 Supervisor", async () => {
	const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa3-supervisor-host-"));
	const host = createAgentSupervisorHost({ root, runtimeDir, watchIntervalMs: 20 });
	try {
		const config = await host.ensure();
		host.startWatch();
		const pid = readState(runtimeDir).pid;
		await host.stop();

		await assert.rejects(host.ping(), /尚未启动/);
		await wait(300);
		assert.equal(readState(runtimeDir).pid, pid, "stop 之后不应再拉起新的 Supervisor");
		await assert.rejects(
			new Promise((resolve, reject) => {
				const socket = net.createConnection(config.socketPath);
				socket.once("connect", () => { socket.destroy(); resolve(); });
				socket.once("error", reject);
			}),
			error => error.code === "ECONNREFUSED" || error.code === "ENOENT"
		);
	} finally {
		await host.stop();
		fs.rmSync(runtimeDir, { recursive: true, force: true });
	}
});
