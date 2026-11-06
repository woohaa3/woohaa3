import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
	BATCH_SUFFIX,
	WINDOWS,
	hashKey,
	resolveSpawnTarget,
	stdioEndpoint,
	supervisorEndpoint
} from "./agent-runtime-endpoints.mjs";

const WIN = { platform: WINDOWS };
const UNIX = { platform: "linux" };

test("supervisor endpoint is a named pipe on Windows and a socket file elsewhere", () => {
	const workspaceKey = hashKey("checkout-a");
	const windows = supervisorEndpoint({ ...WIN, workspaceKey, runtimeDir: "/repo/.local/agent-runtime" });
	assert.equal(windows, `\\\\.\\pipe\\woohaa-agent-${workspaceKey}`);
	// 端点绝不能是文件路径：net.Server#listen(<文件路径>) 在 win32 恒 EACCES。
	assert.ok(windows.startsWith("\\\\.\\pipe\\"));

	const linux = supervisorEndpoint({ ...UNIX, workspaceKey, runtimeDir: "/repo/.local/agent-runtime" });
	assert.equal(linux, path.join("/repo/.local/agent-runtime", "supervisor.sock"));
});

test("supervisor pipe names are per checkout, not shared across workspaces", () => {
	const first = supervisorEndpoint({ ...WIN, workspaceKey: hashKey("checkout-a"), runtimeDir: "/a" });
	const second = supervisorEndpoint({ ...WIN, workspaceKey: hashKey("checkout-b"), runtimeDir: "/a" });
	assert.notEqual(first, second);
});

test("stdio endpoint is a named pipe on Windows and a socket file elsewhere", () => {
	const key = "codex-appserver\u0000owner\u0000connection";
	const windows = stdioEndpoint({ ...WIN, key, stdioDir: "/state/stdio" });
	assert.equal(windows, `\\\\.\\pipe\\woohaa-agent-stdio-${hashKey(key)}`);
	assert.ok(windows.startsWith("\\\\.\\pipe\\"));

	const darwin = stdioEndpoint({ platform: "darwin", key, stdioDir: "/state/stdio" });
	assert.equal(darwin, path.join("/state/stdio", `${hashKey(key)}.sock`));
});

test("stdio endpoint keys are stable and collision resistant", () => {
	const dir = "/state/stdio";
	const key = "adapter\u0000owner\u0000connection";
	assert.equal(stdioEndpoint({ ...UNIX, key, stdioDir: dir }), stdioEndpoint({ ...UNIX, key, stdioDir: dir }));
	assert.notEqual(
		stdioEndpoint({ ...UNIX, key: "adapter\u0000owner\u0000one", stdioDir: dir }),
		stdioEndpoint({ ...UNIX, key: "adapter\u0000owner\u0000two", stdioDir: dir })
	);
});

test("Windows batch shims are spawned through a shell with quoted command", () => {
	assert.match("C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd", BATCH_SUFFIX);

	const target = resolveSpawnTarget("C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd", ["app-server", "", "--flag"], WINDOWS);
	assert.equal(target.shell, true);
	assert.equal(target.command, '"C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd"');
	// shell 模式按空格拼接参数，空参数必须显式写成 "" 才不会被吞掉。
	assert.deepEqual(target.args, ["app-server", '""', "--flag"]);
});

test("real executables are spawned unchanged on Windows", () => {
	const target = resolveSpawnTarget("C:\\Program Files\\nodejs\\node.exe", ["server.js"], WINDOWS);
	assert.deepEqual(target, { command: "C:\\Program Files\\nodejs\\node.exe", args: ["server.js"], shell: false });
});

test("Unix keeps every command unchanged, including .cmd names", () => {
	const target = resolveSpawnTarget("/usr/local/bin/codex.cmd", ["app-server"], "darwin");
	assert.deepEqual(target, { command: "/usr/local/bin/codex.cmd", args: ["app-server"], shell: false });
});

test("a Windows batch shim actually starts through the resolved target", { skip: process.platform !== WINDOWS }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-agent-endpoints-"));
	const script = path.join(dir, "fake-agent.cmd");
	fs.writeFileSync(script, "@echo off\r\necho ready\r\n", "utf8");

	const { command, args, shell } = resolveSpawnTarget(script, [], WINDOWS);
	const stdout = await new Promise((resolve, reject) => {
		const child = spawn(command, args, { shell, windowsHide: true });
		let buffer = "";
		child.stdout.on("data", chunk => { buffer += String(chunk); });
		child.once("error", reject);
		child.once("close", () => resolve(buffer.trim()));
	});
	assert.equal(stdout, "ready");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("runtime directory leaves room for the longest stdio endpoint on macOS", async () => {
 const { agentRuntimeDirectory } = await import("./agent-runtime-endpoints.mjs");
 const root="/Users/developer/Documents/UGit/tx_game/woohaa3/client";
 const runtimeDir=agentRuntimeDirectory({root,platform:"darwin",tempDir:"/var/folders/aa/"+"b".repeat(60)+"/T",uid:501});
 assert.ok(Buffer.byteLength(stdioEndpoint({platform:"darwin",key:"agent",stdioDir:path.join(runtimeDir,"stdio")}))<104);
 assert.notEqual(runtimeDir,path.join(root,".local","agent-runtime"));
 assert.notEqual(runtimeDir,agentRuntimeDirectory({root:root+"-other",platform:"darwin",tempDir:"/tmp",uid:501}));
});

test("runtime directory keeps short checkouts and Windows paths unchanged", async()=>{
 const {agentRuntimeDirectory}=await import("./agent-runtime-endpoints.mjs");
 assert.equal(agentRuntimeDirectory({root:"/r",platform:"darwin"}),path.join("/r",".local","agent-runtime"));
 const root="a".repeat(180);
 assert.equal(agentRuntimeDirectory({root,platform:"win32"}),path.join(root,".local","agent-runtime"));
 const dir=agentRuntimeDirectory({root:"/"+"路径".repeat(25),platform:"darwin",tempDir:"/tmp",uid:501});
 assert.ok(Buffer.byteLength(stdioEndpoint({platform:"darwin",key:"a",stdioDir:path.join(dir,"stdio")}))<104);
});
