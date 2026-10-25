/**
 * 专用进程管理测试（注入 fake spawn；不创建真实进程）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 3.2/3.3 验收）。
 *
 * 覆盖：扫描/加载不创建进程；缺 CLI 明确报错；每 owner/连接独立目录与端口；幂等复用；
 * 停止只回收自有句柄；stopAll 幂等；不接管外部进程。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProcessManager, createLineStreams, processKey, type SpawnSpec, type SpawnedProcess } from "./process-manager.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-local-agent-"));
  dirs.push(dir);
  return dir;
}

/**
 * 取一个 OS 分配的临时回环端口，而不是写死 42xxx。
 * 共享机器上多个 worktree 可能并行跑同一套用例，固定端口段会互相抢。
 */
async function freeLoopbackPort(): Promise<number> {
  const probe = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve((probe.address() as AddressInfo).port));
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function fakeSpawn(record: SpawnSpec[]): (spec: SpawnSpec) => SpawnedProcess {
  let pid = 1000;
  return (spec) => {
    record.push(spec);
    pid += 1;
    let resolveExit: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    return {
      pid,
      exited,
      kill: () => resolveExit()
    };
  };
}

describe("专用进程管理（任务 3.2/3.3）", () => {
  it("simultaneous groups share a single process even during asynchronous configuration", async () => {
    const record: SpawnSpec[] = [];
    const port = await freeLoopbackPort();
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const manager = createProcessManager({ workDirRoot: tempDir(), portRange: { min: port, max: port + 10 }, executableFor: () => "/usr/bin/codex", spawnFn: fakeSpawn(record), prepareConfigDir: () => ready });
    const input = { adapterId: "codex-appserver", owner: "u1", connectionId: "c1", args: [], kind: "stdio" as const };
    const a = manager.ensure(input), b = manager.ensure(input);
    release();
    expect(await a).toBe(await b);
    expect(record).toHaveLength(1);
    expect(manager.activeCount()).toBe(1);
  });
  it("创建 manager 不启动任何进程（扫描/加载无副作用）", () => {
    const record: SpawnSpec[] = [];
    const manager = createProcessManager({ workDirRoot: tempDir(), portRange: { min: 42000, max: 42010 }, executableFor: () => "/usr/bin/codex", spawnFn: fakeSpawn(record) });
    expect(manager.activeCount()).toBe(0);
    expect(record).toHaveLength(0);
  });

  it("缺 CLI 时 probe 明确报 runtime-missing，ensure 抛错", async () => {
    const manager = createProcessManager({ workDirRoot: tempDir(), portRange: { min: 42000, max: 42010 }, executableFor: () => null });
    const probe = await manager.probe("codex-appserver");
    expect(probe.ok).toBe(false);
    if (!probe.ok) expect(probe.code).toBe("runtime-missing");
    await expect(manager.ensure({ adapterId: "codex-appserver", owner: "u1", connectionId: "c1", args: [], kind: "stdio" })).rejects.toThrow();
  });

  it("每 owner/连接独立目录与专用回环端口；幂等复用同一句柄", async () => {
    const record: SpawnSpec[] = [];
    const root = tempDir();
    const port = await freeLoopbackPort();
    const manager = createProcessManager({ workDirRoot: root, portRange: { min: port, max: port + 10 }, executableFor: () => "/usr/bin/opencode", spawnFn: fakeSpawn(record) });
    const first = await manager.ensure({ adapterId: "opencode-server", owner: "u1", connectionId: "c1", args: ["serve"], kind: "http" });
    const again = await manager.ensure({ adapterId: "opencode-server", owner: "u1", connectionId: "c1", args: ["serve"], kind: "http" });
    expect(again).toBe(first);
    expect(record).toHaveLength(1);
    expect(first.loopbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(existsSync(first.workDir)).toBe(true);
    if (process.platform === "win32") expect(first.configDir.length).toBeLessThan(240);
    // 不同 owner 独立目录与端口。
    const other = await manager.ensure({ adapterId: "opencode-server", owner: "u2", connectionId: "c1", args: ["serve"], kind: "http" });
    expect(other.workDir).not.toBe(first.workDir);
    expect(other.loopbackUrl).not.toBe(first.loopbackUrl);
    expect(record).toHaveLength(2);
    // HTTP agents keep the existing CLI login while cwd/port/session remain isolated.
    expect(record[0].env.HOME).toBe(process.env.HOME ?? "");
    expect(record[1].env.HOME).toBe(process.env.HOME ?? "");
    expect(record[0].args).toEqual(["serve", "--port", String(port)]);
    expect(record[0].env.OPENCODE_SERVER_PASSWORD).not.toBe(record[1].env.OPENCODE_SERVER_PASSWORD);
    expect(first.httpHeaders?.Authorization).toBe(`Basic ${Buffer.from(`opencode:${record[0].env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`);
  });

  it("进程意外退出会释放缓存和端口，下一轮可以重新启动", async () => {
    let exit!: () => void;
    let launches = 0;
    const port = await freeLoopbackPort();
    const manager = createProcessManager({ workDirRoot: tempDir(), portRange: { min: port, max: port }, executableFor: () => "/bin/opencode",
      spawnFn: () => ({ pid: ++launches, exited: new Promise<void>(resolve => { exit = resolve; }), kill: () => exit() }) });
    const request = { adapterId: "opencode-server", owner: "u1", connectionId: "c1", args: ["serve"], kind: "http" as const };
    const first = await manager.ensure(request);
    exit();
    await Promise.resolve();
    expect(manager.activeCount()).toBe(0);
    const second = await manager.ensure(request);
    expect(second.pid).not.toBe(first.pid);
    expect(second.loopbackUrl).toBe(first.loopbackUrl);
    await manager.stopAll();
  });

  it("同步启动异常也释放端口", async () => {
    let fail = true;
    const port = await freeLoopbackPort();
    const manager = createProcessManager({ workDirRoot: tempDir(), portRange: { min: port, max: port }, executableFor: () => "/bin/opencode",
      spawnFn: () => { if (fail) throw new Error("spawn EINVAL"); return { pid: 1, exited: new Promise<void>(() => {}), kill: () => undefined }; } });
    const request = { adapterId: "opencode-server", owner: "u1", connectionId: "c1", args: ["serve"], kind: "http" as const };
    await expect(manager.ensure(request)).rejects.toThrow("EINVAL");
    fail = false;
    expect((await manager.ensure(request)).loopbackUrl).toBe(`http://127.0.0.1:${port}`);
  });

  it("启动前准备专用配置目录（复用 Codex home 的链接钩子）", async () => {
    const record: SpawnSpec[] = [];
    const prepared: string[] = [];
    const manager = createProcessManager({
      workDirRoot: tempDir(),
      portRange: { min: 42000, max: 42010 },
      executableFor: () => "/usr/bin/codex",
      prepareConfigDir: ({ configDir }) => {
        prepared.push(configDir);
      },
      spawnFn: fakeSpawn(record),
    });
    const handle = await manager.ensure({ adapterId: "codex-appserver", owner: "u1", connectionId: "c1", args: ["app-server", "--stdio"], kind: "stdio" });
    expect(prepared).toEqual([handle.configDir]);
    expect(record).toHaveLength(1);
  });

  it("stdio 进程无回环 URL，且参数不含任意 shell 串", async () => {
    const record: SpawnSpec[] = [];
    const manager = createProcessManager({ workDirRoot: tempDir(), portRange: { min: 42000, max: 42010 }, executableFor: () => "/usr/bin/codex", spawnFn: fakeSpawn(record) });
    const handle = await manager.ensure({ adapterId: "codex-appserver", owner: "u1", connectionId: "c1", args: ["app-server", "--stdio"], kind: "stdio" });
    expect(handle.loopbackUrl).toBeNull();
    expect(record[0].args).toEqual(["app-server", "--stdio"]);
    expect(record[0].command).toBe("/usr/bin/codex");
  });

  it("停止只回收自有句柄并释放端口；stopAll 幂等", async () => {
    const record: SpawnSpec[] = [];
    const port = await freeLoopbackPort();
    const manager = createProcessManager({ workDirRoot: tempDir(), portRange: { min: port, max: port + 10 }, executableFor: () => "/usr/bin/opencode", spawnFn: fakeSpawn(record) });
    await manager.ensure({ adapterId: "opencode-server", owner: "u1", connectionId: "c1", args: [], kind: "http" });
    await manager.ensure({ adapterId: "opencode-server", owner: "u2", connectionId: "c1", args: [], kind: "http" });
    expect(manager.activeCount()).toBe(2);
    await manager.stop({ adapterId: "opencode-server", owner: "u1", connectionId: "c1" });
    expect(manager.activeCount()).toBe(1);
    expect(manager.get({ adapterId: "opencode-server", owner: "u1", connectionId: "c1" })).toBeNull();
    await manager.stop({ adapterId: "opencode-server", owner: "u1", connectionId: "c1" }); // 幂等
    await manager.stopAll();
    expect(manager.activeCount()).toBe(0);
    await manager.stopAll();
  });

  it("端口用尽时明确报错", async () => {
    const record: SpawnSpec[] = [];
    const port = await freeLoopbackPort();
    const manager = createProcessManager({ workDirRoot: tempDir(), portRange: { min: port, max: port }, executableFor: () => "/usr/bin/opencode", spawnFn: fakeSpawn(record) });
    await manager.ensure({ adapterId: "opencode-server", owner: "u1", connectionId: "c1", args: [], kind: "http" });
    await expect(manager.ensure({ adapterId: "opencode-server", owner: "u2", connectionId: "c1", args: [], kind: "http" })).rejects.toThrow("回环端口已用尽");
  });

  it("子进程启动失败只拒绝本次 ensure，不登记句柄也不占端口", async () => {
    // 真实缺陷：入口不可执行时 Node 抛 'error' 事件，未监听会变成未捕获异常，
    // 直接终止整个后端进程（所有 API 返回 502）。
    const record: SpawnSpec[] = [];
    const port = await freeLoopbackPort();
    const failingSpawn = (spec: SpawnSpec): SpawnedProcess => {
      record.push(spec);
      return {
        pid: undefined,
        spawned: Promise.reject(new Error("spawn codex ENOENT")),
        exited: Promise.resolve(),
        kill: () => undefined,
      };
    };
    const manager = createProcessManager({ workDirRoot: tempDir(), portRange: { min: port, max: port }, executableFor: () => "/usr/bin/codex", spawnFn: failingSpawn });
    await expect(manager.ensure({ adapterId: "opencode-server", owner: "u1", connectionId: "c1", args: [], kind: "http" })).rejects.toThrow("启动 opencode-server 失败");
    expect(manager.activeCount()).toBe(0);
    expect(manager.get({ adapterId: "opencode-server", owner: "u1", connectionId: "c1" })).toBeNull();
    // 端口必须归还，否则唯一可用端口被永久占用。
    const ok = createProcessManager({ workDirRoot: tempDir(), portRange: { min: port, max: port }, executableFor: () => "/usr/bin/opencode", spawnFn: fakeSpawn(record) });
    await expect(ok.ensure({ adapterId: "opencode-server", owner: "u1", connectionId: "c1", args: [], kind: "http" })).resolves.toBeDefined();
  });

  it("processKey 对 owner/连接/适配器互不串", () => {
    expect(processKey("a", "u1", "c1")).not.toBe(processKey("a", "u2", "c1"));
    expect(processKey("a", "u1", "c1")).not.toBe(processKey("a", "u1", "c2"));
    expect(processKey("a", "u1", "c1")).not.toBe(processKey("b", "u1", "c1"));
  });

  it("stderr 与 stdout 各自成帧：stderr 残行不得污染 JSONL 帧", () => {
    // 真实 Codex App Server 会在 stderr 输出日志。两路若共用一条帧缓冲，未以换行结尾的
    // stderr 片段会被拼到下一段 stdout 之前，JSONL 解析报「非 JSON 帧」。
    const stdout: string[] = [];
    const stderr: string[] = [];
    // 用与 defaultSpawn 相同的接线工厂，覆盖真实接线而不只是分帧算法本身。
    const streams = createLineStreams(
      (line) => stdout.push(line),
      (line) => stderr.push(line)
    );
    streams.stderr("warning: partial");
    streams.stdout('{"id":1,"result":{"ok":true}}\n');
    streams.stderr(" continues\n");
    streams.stdout('{"method":"thread/started"}');
    streams.stdout("\n");
    expect(stdout).toEqual(['{"id":1,"result":{"ok":true}}', '{"method":"thread/started"}']);
    // stderr 的两段之间没有换行，属于同一行；关键是不串到 stdout。
    expect(stderr).toEqual(["warning: partial continues"]);
    // 共用缓冲时 stdout 第二帧会变成 ' continues{"method":...}'，这里显式钉住该回归。
    expect(stdout.every((line) => line.startsWith("{"))).toBe(true);
  });

  it("清理临时目录", () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});

it("托管工具持有进程租约至退出，实际启动使用租约内的入口", async () => {
  const record: SpawnSpec[] = []; let released = 0;
  const manager = createProcessManager({ workDirRoot: tempDir(), portRange: { min: 42000, max: 42010 }, executableFor: async () => "/checked/codex", acquireExecutable: async () => ({ entry: "/leased/codex", release: () => { released++; } }), spawnFn: fakeSpawn(record) });
  const input = { adapterId: "codex-appserver", owner: "u", connectionId: "c", args: [], kind: "stdio" as const };
  expect((await manager.probe(input.adapterId)).ok).toBe(true);
  expect(released).toBe(0);
  await manager.ensure(input); expect(record[0]?.command).toBe("/leased/codex"); expect(released).toBe(0);
  await manager.stop(input); expect(released).toBe(1);
});
it("托管工具启动失败会释放租约", async () => {
  let released = 0;
  const manager = createProcessManager({ workDirRoot: tempDir(), portRange: { min: 42000, max: 42010 }, executableFor: async () => "/checked/codex", acquireExecutable: async () => ({ entry: "/leased/codex", release: () => { released++; } }), spawnFn: () => { throw new Error("不可执行"); } });
  await expect(manager.ensure({ adapterId: "codex-appserver", owner: "u", connectionId: "c", args: [], kind: "stdio" })).rejects.toThrow("不可执行");
  expect(released).toBe(1);
});
