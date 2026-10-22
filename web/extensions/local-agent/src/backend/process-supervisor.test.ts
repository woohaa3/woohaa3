import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { AGENT_PROCESS_SUPERVISOR } from "./process-supervisor.js";
import { createProcessManager } from "./process-manager.js";

it("reaps its own listening agent after the host abruptly exits", async () => {
  const agent = `const server=require('node:net').createServer(); server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port,pid:process.pid})));`;
  const host = spawn(process.execPath, ["-e", `const {spawn}=require('node:child_process'); const g=spawn(process.execPath,['-e',${JSON.stringify(AGENT_PROCESS_SUPERVISOR)},${JSON.stringify(JSON.stringify({ command: process.execPath, args: ["-e", agent] }))}],{stdio:['pipe','pipe','pipe','ipc'],windowsHide:true}); g.stdout.pipe(process.stdout); g.stderr.pipe(process.stderr);`], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let pid: number | undefined;
  try {
    const ready = await new Promise<{port:number;pid:number}>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("agent startup timeout")), 7000);
      let output = "";
      host.stdout!.on("data", chunk => { output += String(chunk); if (output.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(output.trim())); } });
      host.once("error", reject);
    });
    pid = ready.pid;
    const exited = new Promise<void>(resolve => host.once("exit", () => resolve()));
    host.kill("SIGKILL");
    await exited;
    await expect.poll(() => { try { process.kill(ready.pid, 0); return true; } catch { return false; } }, { timeout: 8000 }).toBe(false);
    // Windows can release the process before its listening socket is reusable.
    await expect.poll(async () => {
      const probe = createServer();
      try {
        await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(ready.port, "127.0.0.1", resolve); });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
        return false;
      } finally {
        if (probe.listening) await new Promise<void>(resolve => probe.close(() => resolve()));
      }
    }, { timeout: 8000 }).toBe(true);
  } finally {
    host.kill("SIGKILL");
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
}, 20000);

it("skips an occupied OS port and reserves distinct ports for concurrent connections", async () => {
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
  const port = (occupied.address() as import("node:net").AddressInfo).port;
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa-port-"));
  const manager = createProcessManager({ workDirRoot: dir, executableFor: () => process.execPath, portRange: { min: port, max: Math.min(port + 20, 65535) }, spawnFn: () => {
    let exit!: () => void;
    return { pid: 1, exited: new Promise<void>(resolve => { exit = resolve; }), kill: () => exit() };
  } });
  try {
    const handles = await Promise.all(["a", "b"].map(connectionId => manager.ensure({ adapterId: "test", owner: "test", connectionId, args: [], kind: "http" })));
    expect(new Set(handles.map(handle => handle.loopbackUrl)).size).toBe(2);
    expect(handles.every(handle => Number(new URL(handle.loopbackUrl!).port) !== port)).toBe(true);
  } finally { await manager.stopAll(); await new Promise<void>(resolve => occupied.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

it("reports a real CLI spawn failure without registering a process", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa-spawn-"));
  const manager = createProcessManager({ workDirRoot: dir, executableFor: () => path.join(dir, "missing-executable"), portRange: { min: 42000, max: 42010 } });
  try {
    await expect(manager.ensure({ adapterId: "test", owner: "test", connectionId: "test", args: [], kind: "stdio" })).rejects.toThrow(/ENOENT/);
    expect(manager.activeCount()).toBe(0);
  } finally { await manager.stopAll(); rmSync(dir, { recursive: true, force: true }); }
});
