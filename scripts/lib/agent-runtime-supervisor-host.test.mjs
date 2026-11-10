import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAgentSupervisorHost, readRuntimeIdentity, supervisorRpc } from "./agent-runtime-supervisor-host.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);

function fixture({ workspaceKey = "workspace-a", identity } = {}) {
	const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-runtime-host-"));
	const calls = [];
	const spawns = [];
	const host = createAgentSupervisorHost({
		root: ROOT,
		runtimeDir,
		workspaceKey,
		rpc: async (config, method) => {
			calls.push({ method, token: config.token, socketPath: config.socketPath });
			if (method === "ping") return { workspaceKey: config.workspaceKey, pid: 4242 };
			throw new Error(`unexpected method ${method}`);
		},
		spawnProcess: (command, args) => {
			spawns.push({ command, args });
			return { unref() {} };
		},
		startupTimeoutMs: 300
	});
	if (identity !== null) {
		fs.writeFileSync(path.join(runtimeDir, "executor.json"), JSON.stringify({
			schemaVersion: 2,
			workspaceKey,
			pid: 4242,
			socketPath: path.join(runtimeDir, "executor.sock"),
			token: "persisted-token",
			startedAt: Date.now(),
			runtimeVersion: "0.1.0",
			...identity
		}), { mode: 0o600 });
	}
	return { runtimeDir, calls, spawns, host };
}

test("reuses a matching healthy runtime and its persisted token", async () => {
	const { runtimeDir, calls, spawns, host } = fixture();
	const config = await host.ensure();
	assert.equal(config.reused, true);
	assert.equal(config.pid, 4242);
	assert.equal(config.token, "persisted-token");
	assert.equal(spawns.length, 0);
	assert.equal(calls[0].method, "ping");
	assert.equal(fs.existsSync(path.join(runtimeDir, "token")), false);
});

test("a healthy instance is never restarted by the watch", async () => {
	const { spawns, host } = fixture();
	await host.ensure();
	await host.check();
	await host.check();
	assert.equal(spawns.length, 0);
});

test("a foreign workspace is reported, not reused or killed", async () => {
	const { runtimeDir, calls, spawns, host } = fixture({ identity: { workspaceKey: "workspace-b" } });
	await assert.rejects(() => host.ensure(), /其它 workspace/);
	assert.equal(spawns.length, 0);
	// 不向对方端点发任何请求，也不改写快照。
	assert.equal(calls.length, 0);
	assert.ok(fs.existsSync(path.join(runtimeDir, "executor.json")));
});

test("a legacy snapshot is not adopted and is left untouched", async () => {
	const { runtimeDir, spawns, host } = fixture({ identity: null });
	fs.writeFileSync(path.join(runtimeDir, "executor.json"), JSON.stringify({ workspaceKey: "workspace-a", pid: 1, socketPath: "/tmp/x", token: "t", startedAt: 1 }));
	await assert.rejects(() => host.ensure(), /缺少身份版本/);
	assert.equal(spawns.length, 0);
	assert.equal(readRuntimeIdentity(runtimeDir).status, "legacy");
});

test("stopping the watch never shuts the runtime down", async () => {
	const { calls, host } = fixture();
	await host.ensure();
	await host.stop();
	assert.equal(calls.some(call => call.method === "shutdown"), false);
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readState = (runtimeDir) => JSON.parse(fs.readFileSync(path.join(runtimeDir, "executor.json"), "utf8"));

async function stopRuntime(runtimeDir, workspaceKey) {
	try {
		const identity = readState(runtimeDir);
		await supervisorRpc({ socketPath: identity.socketPath, token: identity.token, workspaceKey }, "shutdown");
	} catch { /* already stopped */ }
	await wait(200);
}

test("restarts a runtime that was killed externally, reusing the same endpoint", async () => {
	const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-supervisor-restart-"));
	fs.chmodSync(runtimeDir, 0o700);
	const workspaceKey = "workspace-restart";
	const logs = [];
	const host = createAgentSupervisorHost({ root: ROOT, runtimeDir, workspaceKey, watchIntervalMs: 50, log: (message) => logs.push(message) });
	try {
		const first = await host.ensure();
		const firstState = await host.ping();
		assert.equal(firstState.workspaceKey, workspaceKey);
		assert.equal(readState(runtimeDir).pid, firstState.pid);
		host.startWatch();
		// 模拟外部清理：进程消失，socket 文件残留。
		if (process.platform === "win32") process.kill(firstState.pid);
		else process.kill(firstState.pid, "SIGKILL");
		await wait(100);
		const deadline = Date.now() + 10_000;
		let restarted = null;
		while (Date.now() < deadline) {
			try {
				const state = await host.ping();
				if (state.pid !== firstState.pid) { restarted = state; break; }
			} catch { /* restart in progress */ }
			await wait(100);
		}
		assert.ok(restarted, `运行时未自动恢复；日志：${logs.join(" | ")}`);
		assert.equal(restarted.workspaceKey, workspaceKey);
		assert.equal(readState(runtimeDir).pid, restarted.pid);
	} finally {
		await host.stop();
		await stopRuntime(runtimeDir, workspaceKey);
		fs.rmSync(runtimeDir, { recursive: true, force: true });
	}
});

test("stop only ends the watch: the runtime and its pid remain", async () => {
	const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-supervisor-stop-"));
	fs.chmodSync(runtimeDir, 0o700);
	const workspaceKey = "workspace-stop";
	const host = createAgentSupervisorHost({ root: ROOT, runtimeDir, workspaceKey, watchIntervalMs: 20 });
	try {
		const config = await host.ensure();
		host.startWatch();
		const pid = readState(runtimeDir).pid;
		await host.stop();
		// 宿主不再探活，但运行时仍健康且 pid 不变。
		assert.equal(readState(runtimeDir).pid, pid);
		const identity = readState(runtimeDir);
		const state = await supervisorRpc({ socketPath: identity.socketPath, token: identity.token, workspaceKey }, "ping");
		assert.equal(state.pid, pid);
		assert.ok(config.socketPath);
	} finally {
		await stopRuntime(runtimeDir, workspaceKey);
		fs.rmSync(runtimeDir, { recursive: true, force: true });
	}
});
