import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { hashKey } from "./agent-runtime-endpoints.mjs";
import { createAgentSupervisorHost, supervisorRpc } from "./agent-runtime-supervisor-host.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const CLI = path.join(ROOT, "packages", "execution-runtime", "dist", "cli.js");

function readIdentity(runtimeDir) {
	return JSON.parse(fs.readFileSync(path.join(runtimeDir, "executor.json"), "utf8"));
}

function cli(runtimeDir, workspaceKey, command) {
	return JSON.parse(execFileSync(process.execPath, [CLI, "runtime", command, "--state", runtimeDir, "--workspace", workspaceKey, "--json"], { encoding: "utf8" }));
}

test("devsvr restart reuses the same executor runtime and only explicit stop ends it", async () => {
	const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-runtime-lifecycle-"));
	fs.chmodSync(runtimeDir, 0o700);
	const workspaceKey = hashKey(path.join(runtimeDir, "workspace"));
	const first = createAgentSupervisorHost({ root: ROOT, runtimeDir, workspaceKey, startupTimeoutMs: 10_000 });
	let pid;
	try {
		const ensured = await first.ensure();
		assert.equal(ensured.reused, false);
		pid = ensured.pid;
		assert.equal(readIdentity(runtimeDir).pid, pid);
		assert.equal(readIdentity(runtimeDir).schemaVersion, 2);

		// 模拟 devsvr 正常退出：只停止探活，不 shutdown。
		await first.stop();

		// 运行时仍健康；新 devsvr 直接复用同一 pid，不产生第二个 daemon。
		assert.equal((await supervisorRpc({ socketPath: ensured.socketPath, token: ensured.token, workspaceKey }, "ping")).workspaceKey, workspaceKey);
		const second = createAgentSupervisorHost({ root: ROOT, runtimeDir, workspaceKey, startupTimeoutMs: 10_000 });
		const reused = await second.ensure();
		assert.equal(reused.reused, true);
		assert.equal(reused.pid, pid);
		assert.equal(readIdentity(runtimeDir).pid, pid);

		const status = cli(runtimeDir, workspaceKey, "status");
		assert.equal(status.status, "healthy");
		assert.equal(status.pid, pid);

		// 只有显式 runtime stop 终止运行时；之后下一次启动按需拉起新实例。
		const stopped = cli(runtimeDir, workspaceKey, "stop");
		assert.equal(stopped.stopped, true);
		assert.equal(fs.existsSync(path.join(runtimeDir, "executor.json")), false);
		await second.stop();
	} finally {
		if (pid) {
			try {
				const identity = readIdentity(runtimeDir);
				await supervisorRpc({ socketPath: identity.socketPath, token: identity.token, workspaceKey }, "shutdown");
			} catch { /* already stopped */ }
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		fs.rmSync(runtimeDir, { recursive: true, force: true });
	}
});

test("desktop supervisor starts the CLI with workspace and protected paths", async () => {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-desktop-workspace-"));
	const runtimeDir = path.join(temp, "runtime");
	const workspaceRoot = path.join(temp, "workspaces");
	const protectedPaths = [path.join(temp, "secrets"), path.join(temp, "media")];
	fs.mkdirSync(runtimeDir, { mode: 0o700 });
	for (const dir of protectedPaths) fs.mkdirSync(dir);
	const workspaceKey = hashKey(temp);
	const supervisor = createAgentSupervisorHost({ root: ROOT, runtimeDir, workspaceKey, canvasWorkspaceRoot: workspaceRoot, canvasWorkspaceProtectedPaths: protectedPaths, startupTimeoutMs: 10_000 });
	let started = false;
	try {
		const runtime = await supervisor.ensure();
		started = true;
		const rpc = (method, params = {}) => supervisorRpc(runtime, method, params);
		const settings = await rpc("workspace.settings");
		assert.equal(settings.available, true);
		assert.equal(settings.rootPath, workspaceRoot);
		const handle = await rpc("workspace.acquire", { owner: "owner", canvasId: "canvas", requestId: "request" });
		assert.equal(handle.canvasId, "canvas");
		for (const [index, targetPath] of protectedPaths.entries()) {
			await assert.rejects(rpc("workspace.migrate", { operationId: `protected-${index}`, targetPath, expectedRootRevision: settings.rootRevision }), /目标位置与应用运行数据重叠/);
		}
	} finally {
		await supervisor.stop();
		if (started) cli(runtimeDir, workspaceKey, "stop");
		fs.rmSync(temp, { recursive: true, force: true });
	}
});
