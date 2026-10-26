import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExtensionHostManager, ExtensionHostLimitError, type ExtensionHostManager } from "./manager.js";

/**
 * 真实 fork 的最小子进程：只用原始 IPC 说 JSON-RPC（不依赖构建产物）。
 * 行为由 argv 之外的环境不可得（环境被白名单裁掉），因此按 cwd 里的 mode.txt 选择。
 */
const CHILD = `
const fs = require("node:fs");
const mode = fs.readFileSync("mode.txt", "utf8").trim();
const out = { env: Object.keys(process.env).sort(), cwd: process.cwd(), execArgv: process.execArgv };
let id = 1;
process.on("message", (frame) => {
  if (frame.id === 1 && "result" in frame) {
    process.send({ jsonrpc: "2.0", method: "ctx.ready", params: { start: frame.result, out } });
    if (mode === "exit-after-ready") setTimeout(() => process.exit(3), 20);
    if (mode === "bad-frame") process.send({ nope: true });
    return;
  }
  if (frame.method === "$/ping" && mode !== "no-pong") process.send({ jsonrpc: "2.0", id: frame.id, result: "pong" });
  if (frame.method === "host.stop") { process.send({ jsonrpc: "2.0", id: frame.id, result: null }); if (mode !== "ignore-stop") setTimeout(() => process.exit(0), 5); }
});
process.send({ jsonrpc: "2.0", id: id++, method: "$/hello", params: { protocol: mode === "bad-protocol" ? 99 : 1, sdkAbi: 1, pid: process.pid } });
setInterval(() => {}, 1000);
`;

const dirs: string[] = [];
const managers: ExtensionHostManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stopAll(500);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(mode: string, overrides: Partial<Parameters<typeof createExtensionHostManager>[0]> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-manager-"));
  dirs.push(dir);
  const entry = path.join(dir, "child.cjs");
  fs.writeFileSync(entry, CHILD);
  fs.writeFileSync(path.join(dir, "mode.txt"), mode);
  const events: Record<string, unknown>[] = [];
  const manager = createExtensionHostManager({
    childEntry: entry,
    log: (event) => events.push(event),
    settings: () => ({ maxOldSpaceMb: 96, maxProcesses: 2 }),
    tmpRoot: path.join(dir, "tmp"),
    baseEnv: { NODE_ENV: "test", WOOHAA3_SECRET: "leak", HTTPS_PROXY: "x", TZ: "UTC" },
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 200,
    ...overrides
  });
  managers.push(manager);
  const spawn = () => manager.spawn({
    extensionId: "fixture",
    directory: dir,
    start: { entry: "backend-dist/entry.mjs", factory: "create", kind: "provider", values: { apiKey: "k" }, capabilities: { extensionId: "fixture", routePrefixes: [], storageNamespaces: [], network: [] } }
  });
  return { dir, manager, events, spawn };
}

function ready(instance: { rpc: { onNotification(method: string, fn: (params: unknown) => void): () => void } }) {
  return new Promise<{ start: Record<string, unknown>; out: { env: string[]; cwd: string; execArgv: string[] } }>((resolve) => {
    instance.rpc.onNotification("ctx.ready", (params) => resolve(params as never));
  });
}

describe("Extension Host 管理器", () => {
  it("fork：环境白名单 + TMPDIR、cwd 为版本目录、堆上限 execArgv；hello 后下发带 instanceId 的启动参数", async () => {
    const { dir, spawn } = setup("normal");
    const instance = spawn();
    const info = await ready(instance);
    await instance.started;
    expect(info.out.env).toEqual(["NODE_ENV", "TEMP", "TMP", "TMPDIR", "TZ", "WOOHAA3_EXTENSION_HOST_CHILD"]);
    expect(fs.realpathSync(info.out.cwd)).toBe(fs.realpathSync(dir));
    expect(info.out.execArgv).toEqual(expect.arrayContaining(["--max-old-space-size=96", "--disable-proto=throw"]));
    expect(info.start).toMatchObject({ instanceId: instance.instanceId, values: { apiKey: "k" }, factory: "create" });
    expect(instance.pid).not.toBe(process.pid);
    const exit = await instance.stop(1000);
    expect(exit.reason).toBe("stopped");
  });

  it("进程数上限：超限 spawn 抛 extension-host-limit，不影响已运行实例", async () => {
    const { spawn, manager } = setup("normal");
    const a = spawn();
    const b = spawn();
    expect(() => spawn()).toThrow(ExtensionHostLimitError);
    await Promise.all([a.started, b.started]);
    expect(manager.size()).toBe(2);
  });

  it("子进程自行退出 → exit 崩溃，在途请求以 extension-crashed 失败", async () => {
    const { spawn } = setup("exit-after-ready");
    const instance = spawn();
    await instance.started;
    const pending = instance.rpc.request("provider.model.call", {}, { timeoutMs: 0 });
    pending.catch(() => undefined);
    const exit = await instance.exited;
    expect(exit).toMatchObject({ reason: "exit", exitCode: 3 });
    await expect(pending).rejects.toMatchObject({ code: "extension-crashed" });
  });

  it("心跳超时判死并杀进程，只回报一次", async () => {
    const { spawn, events } = setup("no-pong");
    const instance = spawn();
    await instance.started;
    const exit = await instance.exited;
    expect(exit.reason).toBe("heartbeat-timeout");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events.filter((event) => event.event === "extension-host-instance-crashed")).toHaveLength(1);
  });

  it("协议错误（非法帧）按崩溃处理", async () => {
    const { spawn } = setup("bad-frame");
    const instance = spawn();
    expect((await instance.exited).reason).toBe("protocol-error");
  });

  it("协议版本不兼容：握手失败、实例结束", async () => {
    const { spawn } = setup("bad-protocol");
    const instance = spawn();
    await expect(instance.started).rejects.toMatchObject({ code: "MARKETPLACE_ENGINES_INCOMPATIBLE" });
    expect((await instance.exited).reason).toBe("hello-failed");
  });

  it("停止时子进程不退出：超时 SIGKILL，仍按 stopped 收尾", async () => {
    const { spawn } = setup("ignore-stop");
    const instance = spawn();
    await instance.started;
    const exit = await instance.stop(150);
    expect(exit.reason).toBe("stopped");
    expect(exit.signal).toBe("SIGKILL");
  });

  it("stdout/stderr 逐行转结构化日志", async () => {
    const { dir, events } = setup("normal");
    const entry = path.join(dir, "child.cjs");
    fs.writeFileSync(entry, `console.log("hello line"); console.error("oops");\n` + CHILD);
    const manager = createExtensionHostManager({ childEntry: entry, log: (event) => events.push(event), settings: () => ({ maxOldSpaceMb: 96, maxProcesses: 2 }), tmpRoot: path.join(dir, "tmp2") });
    managers.push(manager);
    const instance = manager.spawn({ extensionId: "fixture", directory: dir, start: { entry: "e", factory: "f", kind: "provider", values: {}, capabilities: { extensionId: "fixture", routePrefixes: [], storageNamespaces: [], network: [] } } });
    await instance.started;
    await expect.poll(() => events.filter((event) => event.event === "extension-host-output").map((event) => [event.stream, event.line])).toEqual(
      expect.arrayContaining([["stdout", "hello line"], ["stderr", "oops"]])
    );
  });
});
