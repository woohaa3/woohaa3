/**
 * 运行：`node --test scripts/lib/dev-port-guard.test.mjs`
 *
 * 覆盖端口解析（lsof / ss / netstat 输出）、bind 探测，以及 `--free-port` 的真实结束进程路径
 * （起一个只监听端口的子进程，再让守卫收掉它）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";

import {
  canBindPort,
  findPortOwners,
  freePort,
  parseLsofPids,
  parseSsListeners,
  parseWindowsNetstat,
  waitForPortFree
} from "./dev-port-guard.mjs";

/** 取一个当前空闲的端口：bind 0 后立即释放。 */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test("parseLsofPids：每行一个 PID，去重并忽略非数字", () => {
  assert.deepEqual(parseLsofPids("3695537\n1234\n3695537\n\n"), [3695537, 1234]);
  assert.deepEqual(parseLsofPids(""), []);
});

test("parseSsListeners：只取 LISTEN 行的 pid/进程名", () => {
  const output = [
    "State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
    'LISTEN 0 511 0.0.0.0:5300 0.0.0.0:* users:(("MainThread",pid=3695537,fd=30))',
    'ESTAB  0 0 127.0.0.1:5300 127.0.0.1:50111 users:(("node",pid=42,fd=12))'
  ].join("\n");
  assert.deepEqual(parseSsListeners(output), [{ pid: 3695537, name: "MainThread" }]);
});

test("parseWindowsNetstat：按端口过滤 LISTENING 行", () => {
  const output = [
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:5300           0.0.0.0:0              LISTENING       1234",
    "  TCP    0.0.0.0:5301           0.0.0.0:0              LISTENING       5678",
    "  TCP    127.0.0.1:5300         127.0.0.1:50111        ESTABLISHED     1234"
  ].join("\n");
  assert.deepEqual(parseWindowsNetstat(output, 5300), [{ pid: 1234, name: "" }]);
});

test("findPortOwners：lsof 缺失时退回 ss 并补全命令行", async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "lsof") {
      const error = new Error("spawn lsof ENOENT");
      error.code = "ENOENT";
      throw error;
    }
    if (command === "ss") return 'LISTEN 0 511 0.0.0.0:5300 0.0.0.0:* users:(("MainThread",pid=3695537,fd=30))';
    if (command === "ps") return "/usr/bin/node scripts/dev.mjs --frontend-port 5300\n";
    throw new Error(`unexpected command ${command}`);
  };
  const owners = await findPortOwners(5300, { platform: "darwin", run });
  assert.deepEqual(owners, [{ pid: 3695537, name: "MainThread", command: "/usr/bin/node scripts/dev.mjs --frontend-port 5300" }]);
  assert.match(calls[0], /^lsof -nP -iTCP:5300 -sTCP:LISTEN -t$/);
  assert.match(calls[1], /^ss -ltnp sport = :5300$/);
});

test("canBindPort / waitForPortFree：按真实 bind 判定占用", async () => {
  const port = await pickFreePort();
  assert.equal(await canBindPort(port), true);
  const server = net.createServer();
  await new Promise((resolve) => server.listen(port, "0.0.0.0", resolve));
  try {
    assert.equal(await canBindPort(port), false);
    assert.equal(await waitForPortFree(port, 200), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await canBindPort(port), true);
  assert.equal(await waitForPortFree(port, 200), true);
});

test("freePort：结束监听端口的残留进程并释放端口", async (t) => {
  const port = await pickFreePort();
  const child = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${port}, "0.0.0.0")`], {
    stdio: "ignore"
  });
  t.after(() => child.kill("SIGKILL"));
  const exited = new Promise((resolve) => child.once("close", resolve));

  const deadline = Date.now() + 5000;
  while (await canBindPort(port)) {
    if (Date.now() > deadline) throw new Error("子进程未在预期时间内监听端口");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const logs = [];
  let result;
  try {
    result = await freePort(port, { log: (message) => logs.push(message) });
  } catch (error) {
    // 缺少 lsof/ss/netstat 的环境无法解析占用进程：守卫仍会拒绝启动，这里只跳过结束路径。
    t.skip(`无法解析占用进程：${error.message}`);
    return;
  }

  assert.equal(result.freed, true);
  assert.deepEqual(result.killed, [child.pid]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], new RegExp(`结束占用 ${port} 的进程 pid ${child.pid}`));
  assert.equal(await canBindPort(port), true);
  await exited;
});

test("freePort：端口空闲时什么都不做", async () => {
  const port = await pickFreePort();
  const logs = [];
  const result = await freePort(port, { log: (message) => logs.push(message) });
  assert.deepEqual(result, { port, freed: true, killed: [] });
  assert.deepEqual(logs, []);
});
