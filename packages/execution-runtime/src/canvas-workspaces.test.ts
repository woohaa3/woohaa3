import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { CanvasWorkspaces } from "./canvas-workspaces.js";
import type { CanvasWorkspaceHandle } from "@woohaa3/contracts";

const fixtures: Array<{ root: string; service: CanvasWorkspaces }> = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-workspaces-"));
  const options = { stateDir: path.join(root, "state"), defaultRoot: path.join(root, "files"), profileKey: "profile" };
  const service = new CanvasWorkspaces(options);
  fixtures.push({ root, service });
  return { root, service, options };
}
const input = { owner: "alice", canvasId: "canvas", requestId: "turn" };
async function waitFor<T>(read: () => Promise<T> | T, accept: (value: T) => boolean) {
  for (let i = 0; i < 300; i++) { const value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("状态未收敛");
}
afterEach(async () => { vi.restoreAllMocks(); for (const { root, service } of fixtures.splice(0)) { await service.close(); fs.rmSync(root, { recursive: true, force: true }); } });

describe("desktop canvas workspaces: real files, commands and journal", () => {
  it("shares one canvas while isolating turn and owner identities, preserves data after restart", async () => {
    const { service, options } = fixture();
    const a = await service.acquire(input), b = await service.acquire({ ...input, requestId: "other" });
    expect(a.directoryKey).toBe(b.directoryKey); expect(a.runKey).not.toBe(b.runKey);
    expect((await service.acquire({ ...input, owner: "bob" })).directoryKey).not.toBe(a.directoryKey);
    await service.write(a, { path: "shared/result.txt", content: "计算结果" });
    expect((await service.read(b, "shared/result.txt")).content).toBe("计算结果");
    await service.release(a, "terminal"); await service.release(b, "terminal"); await service.close();
    const restored = new CanvasWorkspaces(options);
    try {
      const c = await restored.acquire({ ...input, requestId: "after-restart" });
      expect(c.directoryKey).toBe(a.directoryKey);
      expect((await restored.read(c, "shared/result.txt")).content).toBe("计算结果");
    } finally { await restored.close(); }
  });
  it("rejects forged handles, traversal, absolute and symlink paths and stale shared writes", async () => {
    const { root, service } = fixture(), h = await service.acquire(input);
    for (const relative of ["../escape", "/tmp/escape", "C:/escape", "shared/../../escape", "shared\\escape", ".woohaa-workspace.json"]) await expect(service.write(h, { path: relative, content: "x" })).rejects.toHaveProperty("code", "workspace-path-invalid");
    const reordered = Object.fromEntries(Object.entries(h).reverse()) as CanvasWorkspaceHandle;
    await service.write(reordered, { path: "shared/value", content: "first", expectedHash: null });
    await expect(service.write(h, { path: "shared/value", content: "stale", expectedHash: null })).rejects.toHaveProperty("code", "workspace-conflict");
    fs.symlinkSync(root, path.join(service.location(input), "shared", "link"), "junction");
    await expect(service.read(h, "shared/link/state/canvas-workspaces.json")).rejects.toHaveProperty("code", "workspace-path-invalid");
    await expect(service.list({ ...h, owner: "bob" })).rejects.toHaveProperty("code", "workspace-forbidden");
  });
  it("runs real bundled Node, captures both output streams, isolates env and deduplicates lost responses", async () => {
    const { service } = fixture(), h = await service.acquire(input);
    process.env.WOOHAA_TEST_SECRET = "never-in-child";
    try {
      await service.write(h, { path: `runs/${h.runKey}/script.cjs`, content: "require('fs').appendFileSync('count','1'); console.log('中文输出'); console.error('stderr'); console.log(process.env.WOOHAA_TEST_SECRET ?? 'clean');" });
      const command = { operationId: "run-1", command: "node", args: ["script.cjs"] };
      const first = await service.execute(h, command), replay = await service.execute(h, command);
      expect(first.executionId).toBe(replay.executionId);
      const result = await waitFor(() => service.query(h, { executionId: first.executionId }), value => ["exited", "failed"].includes(value.execution.status));
      expect(result.execution.exitCode).toBe(0);
      expect(result.events.map(e => e.text).join("")).toContain("中文输出");
      expect(result.events.some(e => e.stream === "stderr" && e.text.includes("stderr"))).toBe(true);
      expect(result.events.map(e => e.text).join("")).toContain("clean");
      expect((await service.read(h, `runs/${h.runKey}/count`)).content).toBe("1");
      expect((await service.query(h, { executionId: first.executionId, after: result.events.at(-1)!.cursor })).events).toEqual([]);
      await expect(service.execute(h, { ...command, args: ["different"] })).rejects.toHaveProperty("code", "workspace-conflict");
    } finally { delete process.env.WOOHAA_TEST_SECRET; }
  });
  it("reports missing runtimes and real nonzero exit codes", async () => {
    const { service } = fixture(), h = await service.acquire(input);
    const absent = await service.execute(h, { operationId: "missing", command: "woohaa-missing-runtime-000000" });
    const missing = await waitFor(() => service.query(h, { executionId: absent.executionId }), x => x.execution.status === "failed");
    expect(missing.execution.error).toBe("runtime-missing");
    const bad = await service.execute(h, { operationId: "bad", command: "node", args: ["-e", "process.exit(7)"] });
    const failed = await waitFor(() => service.query(h, { executionId: bad.executionId }), x => x.execution.status === "failed");
    expect(failed.execution.exitCode).toBe(7);
  });
  it("cancels a real long command and revokes further use, retains other turns and shared files", async () => {
    const { service } = fixture(), h = await service.acquire(input), other = await service.acquire({ ...input, requestId: "other" });
    const e = await service.execute(h, { operationId: "long", command: "node", args: ["-e", "setInterval(()=>{},1000)"] });
    await service.cancel(h);
    const stopped = await service.query(h, { executionId: e.executionId });
    expect(stopped.execution.status).toBe("failed");
    await expect(service.execute(h, { operationId: "new", command: "node" })).rejects.toHaveProperty("code", "workspace-forbidden");
    await service.write(other, { path: "shared/preserve", content: "shared" });
    await service.clean(input);
    expect((await service.read(other, "shared/preserve")).content).toBe("shared");
    expect((await service.clean(input)).retained).toContain(other.runKey);
  });
  it("gates new users during migration, lets existing users drain, verifies and commits once", async () => {
    const { root, service } = fixture(), h = await service.acquire(input);
    await service.write(h, { path: "shared/file", content: "before" });
    const target = path.join(root, "new-files"); fs.mkdirSync(target); fs.writeFileSync(path.join(target, "unrelated"), "keep");
    const migration = { operationId: "move", targetPath: target, expectedRootRevision: 1 };
    expect((await service.migrate(migration)).phase).toBe("waiting-for-idle");
    await expect(service.acquire({ ...input, requestId: "new" })).rejects.toHaveProperty("code", "workspace-migrating");
    await service.write(h, { path: "shared/file", content: "drained" }); await service.release(h, "terminal");
    await waitFor(() => service.settings(), x => x.migration?.phase === "completed" && !x.migration.cleanupPending);
    const next = await service.acquire({ ...input, requestId: "after" });
    expect(next.generation).toBe(2); expect((await service.read(next, "shared/file")).content).toBe("drained");
    expect(fs.readFileSync(path.join(target, "unrelated"), "utf8")).toBe("keep");
    await expect(service.list(h)).rejects.toHaveProperty("code", "workspace-stale");
    expect((await service.migrate(migration)).phase).toBe("completed"); expect(service.settings().rootRevision).toBe(2);
    await expect(service.migrate({ ...migration, targetPath: path.join(root, "other") })).rejects.toHaveProperty("code", "workspace-conflict");
  });
  it("cancels migration waiting without stopping users; rejects overlaps and conflicting targets without switching", async () => {
    const { root, service } = fixture(), h = await service.acquire(input), source = service.settings().rootPath;
    await expect(service.migrate({ operationId: "nested", targetPath: path.join(source, "nested"), expectedRootRevision: 1 })).rejects.toHaveProperty("code", "workspace-path-invalid");
    await service.migrate({ operationId: "cancel", targetPath: path.join(root, "cancel"), expectedRootRevision: 1 }); await service.cancelMigration("cancel");
    await service.write(h, { path: "shared/still-active", content: "ok" }); await service.release(h, "terminal");
    const target = path.join(root, "conflict"); fs.mkdirSync(path.join(target, h.directoryKey), { recursive: true });
    await service.migrate({ operationId: "conflict", targetPath: target, expectedRootRevision: 1 });
    await waitFor(() => service.settings(), x => x.migration?.phase === "failed");
    expect(service.settings().rootPath).toBe(source); expect(fs.existsSync(path.join(target, h.directoryKey))).toBe(true);
  });
  it("does not re-run commands with unknown durable state or release migration on an unknown user", async () => {
    const { root, service, options } = fixture(), h = await service.acquire(input);
    await service.close();
    const stateFile = path.join(options.stateDir, "canvas-workspaces.json"), state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.executions["c".repeat(64)] = { executionId: "c".repeat(64), requestId: input.requestId, handle: h, digest: "d".repeat(64), status: "running", createdAt: "", updatedAt: "", cursor: 0, pid: 99999999 };
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const restored = new CanvasWorkspaces(options);
    try {
      expect((await restored.query(h, { executionId: "c".repeat(64) })).execution.status).toBe("unknown");
      expect((await restored.stop(h, "c".repeat(64))).status).toBe("unknown");
      await restored.settle({ ...input, outcome: "terminal" });
      await restored.migrate({ operationId: "blocked", targetPath: path.join(root, "new"), expectedRootRevision: 1 });
      expect(restored.settings().migration?.phase).toBe("waiting-for-idle");
      expect(restored.settings().migration?.error).toContain("状态未知");
    } finally { await restored.close(); }
  });
});


describe("workspace migration fault boundaries", () => {
  it.each(["ENOSPC", "EACCES"])("preserves the source on %s and allows a new migration", async code => {
    const { root, service } = fixture(), h = await service.acquire(input);
    await service.write(h, { path: "shared/file", content: "original" });
    await service.release(h, "terminal");
    const source = service.settings().rootPath;
    const copy = vi.spyOn(fs.promises, "cp").mockRejectedValueOnce(Object.assign(new Error(code), { code }));
    await service.migrate({ operationId: "failed", targetPath: path.join(root, "failed"), expectedRootRevision: 1 });
    await waitFor(() => service.settings(), s => s.migration?.phase === "failed");
    expect(service.settings().rootPath).toBe(source);
    expect(fs.readFileSync(path.join(source, h.directoryKey, "shared/file"), "utf8")).toBe("original");
    copy.mockRestore();
    await service.migrate({ operationId: "retry", targetPath: path.join(root, "retry"), expectedRootRevision: 1 });
    await waitFor(() => service.settings(), s => s.migration?.phase === "completed");
  });
  it("rejects a source changed by an external writer during copy", async () => {
    const { root, service } = fixture(), h = await service.acquire(input);
    await service.write(h, { path: "shared/file", content: "original" }); await service.release(h, "terminal");
    const source = service.settings().rootPath, copy = fs.promises.cp.bind(fs.promises);
    vi.spyOn(fs.promises, "cp").mockImplementationOnce(async (...args) => {
      await copy(...args); fs.writeFileSync(path.join(source, h.directoryKey, "shared/file"), "external");
    });
    await service.migrate({ operationId: "changed", targetPath: path.join(root, "target"), expectedRootRevision: 1 });
    await waitFor(() => service.settings(), s => s.migration?.phase === "failed");
    expect(service.settings().rootPath).toBe(source);
    expect(fs.readFileSync(path.join(source, h.directoryKey, "shared/file"), "utf8")).toBe("external");
  });
  it("rolls back published copies when the atomic root commit fails", async () => {
    const { root, service } = fixture(), h = await service.acquire(input);
    await service.write(h, { path: "shared/file", content: "original" }); await service.release(h, "terminal");
    const source = service.settings().rootPath, target = path.join(root, "target"), rename = fs.renameSync;
    let injected = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!injected && String(to).endsWith("canvas-workspaces.json") && JSON.parse(fs.readFileSync(from, "utf8")).rootPath === target) {
        injected = true; throw Object.assign(new Error("commit disk full"), { code: "ENOSPC" });
      }
      return rename(from, to);
    });
    await service.migrate({ operationId: "commit-failure", targetPath: target, expectedRootRevision: 1 });
    await waitFor(() => service.settings(), s => s.migration?.phase === "failed");
    expect(injected).toBe(true); expect(service.settings().rootPath).toBe(source);
    expect(fs.existsSync(path.join(target, h.directoryKey))).toBe(false);
    expect(fs.readFileSync(path.join(source, h.directoryKey, "shared/file"), "utf8")).toBe("original");
  });
  it("keeps the committed root authoritative if cleanup fails, and retries cleanup after restart", async () => {
    const { root, service, options } = fixture(), h = await service.acquire(input);
    await service.write(h, { path: "shared/file", content: "original" }); await service.release(h, "terminal");
    const source = service.settings().rootPath, target = path.join(root, "target"), remove = fs.rmSync;
    const failure = vi.spyOn(fs, "rmSync").mockImplementation((p, opts) => {
      if (String(p) === path.join(source, h.directoryKey)) throw Object.assign(new Error("file in use"), { code: "EACCES" });
      return remove(p, opts);
    });
    await service.migrate({ operationId: "cleanup-failure", targetPath: target, expectedRootRevision: 1 });
    await waitFor(() => service.settings(), s => s.migration?.phase === "completed" && !!s.migration.error);
    expect(service.settings().rootPath).toBe(target); expect(service.settings().migration?.cleanupPending).toBe(true);
    expect(fs.existsSync(path.join(source, h.directoryKey))).toBe(true);
    failure.mockRestore(); await service.close();
    const restored = new CanvasWorkspaces(options);
    try {
      await waitFor(() => restored.settings(), s => s.migration?.cleanupPending === false);
      expect(restored.settings().rootPath).toBe(target);
      expect(fs.existsSync(path.join(source, h.directoryKey))).toBe(false);
    } finally { await restored.close(); }
  });
  it("cancels an in-flight copy without changing the root or stopping a newly admitted turn", async () => {
    const { root, service } = fixture(), h = await service.acquire(input);
    await service.write(h, { path: "shared/file", content: "original" }); await service.release(h, "terminal");
    const source = service.settings().rootPath, copy = fs.promises.cp.bind(fs.promises);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(r => { release = r; }), copying = new Promise<void>(r => { started = r; });
    vi.spyOn(fs.promises, "cp").mockImplementationOnce(async (...args) => { started(); await gate; return copy(...args); });
    await service.migrate({ operationId: "cancel-copy", targetPath: path.join(root, "target"), expectedRootRevision: 1 });
    await copying; await service.cancelMigration("cancel-copy");
    const next = await service.acquire({ ...input, requestId: "next" });
    await service.write(next, { path: "shared/file", content: "new turn" }); release();
    await service.close();
    expect(service.settings().migration?.phase).toBe("cancelled");
    expect(service.settings().rootPath).toBe(source);
    expect(fs.readFileSync(path.join(source, h.directoryKey, "shared/file"), "utf8")).toBe("new turn");
  });
});

it("drains background descendants before publishing a natural command exit", async () => {
  const { service } = fixture(), h = await service.acquire(input);
  const program = "const cp=require('child_process');cp.spawn(process.execPath,['-e',\"setInterval(()=>require('fs').appendFileSync('heartbeat','x'),5)\"],{stdio:'inherit'}).unref();const ready=setInterval(()=>{if(require('fs').existsSync('heartbeat')){clearInterval(ready);process.exit(0)}},10);setTimeout(()=>process.exit(9),10000).unref();";
  const started = await service.execute(h, { operationId: "background", command: "node", args: ["-e", program] });
  const result = await waitFor(() => service.query(h, { executionId: started.executionId }), s => s.execution.status === "exited");
  expect(result.execution.exitCode).toBe(0);
  const heartbeat = `runs/${h.runKey}/heartbeat`;
  const before = await service.read(h, heartbeat);
  expect(before.content.length).toBeGreaterThan(0);
  await new Promise(resolve => setTimeout(resolve, 60));
  expect((await service.read(h, heartbeat)).content).toBe(before.content);
});

it("fails closed on corrupt persisted handles and preserves the ledger and workspace", async () => {
  const { service, options } = fixture(), h = await service.acquire(input);
  await service.write(h, { path: "shared/keep", content: "preserved" }); await service.close();
  const ledger = path.join(options.stateDir, "canvas-workspaces.json"), state = JSON.parse(fs.readFileSync(ledger, "utf8"));
  Object.values(state.leases).forEach((lease: any) => { lease.handle.directoryKey = "../../elsewhere"; });
  fs.writeFileSync(ledger, JSON.stringify(state));
  expect(() => new CanvasWorkspaces(options)).toThrow("持久状态损坏");
  expect(JSON.parse(fs.readFileSync(ledger, "utf8"))).toEqual(state);
  expect(fs.readFileSync(path.join(options.defaultRoot, h.directoryKey, "shared/keep"), "utf8")).toBe("preserved");
});

it("persists prototype-named operation IDs without corrupting the journal", async () => {
  const { service, options } = fixture();
  await service.migrate({ operationId: "__proto__", targetPath: service.settings().rootPath, expectedRootRevision: 1 });
  await service.close();
  const restored = new CanvasWorkspaces(options);
  try { expect(restored.settings().migration).toMatchObject({ operationId: "__proto__", phase: "completed" }); }
  finally { await restored.close(); }
});


it("uses the original byte hash when replacing non-UTF8 text", async () => {
  const { service } = fixture(), h = await service.acquire(input);
  fs.writeFileSync(path.join(service.location(input), "shared/raw"), Buffer.from([0xff, 0x00, 0x61]));
  const before = await service.read(h, "shared/raw");
  await expect(service.write(h, { path: "shared/raw", content: "updated", expectedHash: before.hash })).resolves.toHaveProperty("hash");
  expect((await service.read(h, "shared/raw")).content).toBe("updated");
});

it.each([false, true])("recovers an uncommitted published target; externally modified=%s", async modified => {
  const { root, service, options } = fixture(), h = await service.acquire(input);
  await service.write(h, { path: "shared/file", content: "original" }); await service.release(h, "terminal");
  const source = service.settings().rootPath, target = path.join(root, "target");
  const ledger = path.join(options.stateDir, "canvas-workspaces.json"), rename = fs.renameSync;
  let crashImage = "";
  const capture = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) === ledger && JSON.parse(fs.readFileSync(from, "utf8")).rootPath === target && !crashImage) crashImage = fs.readFileSync(ledger, "utf8");
    return rename(from, to);
  });
  await service.migrate({ operationId: "crash", targetPath: target, expectedRootRevision: 1 });
  await waitFor(() => service.settings(), s => s.migration?.phase === "completed" && !s.migration.cleanupPending);
  await service.close(); capture.mockRestore();
  expect(JSON.parse(crashImage).migrations.crash.phase).toBe("switching");
  // Restore the durable pre-commit disk image: both complete copies, old root
  // authority, and the journal's real inode identity for the published target.
  fs.cpSync(path.join(target, h.directoryKey), path.join(source, h.directoryKey), { recursive: true });
  fs.writeFileSync(ledger, crashImage); fs.writeFileSync(path.join(target, "unmanaged"), "keep");
  if (modified) fs.writeFileSync(path.join(target, h.directoryKey, "shared/file"), "external");
  const restored = new CanvasWorkspaces(options);
  try {
    await waitFor(() => restored.settings(), s => ["completed", "failed"].includes(s.migration?.phase ?? ""));
    expect(restored.settings().rootPath).toBe(modified ? source : target);
    expect(restored.settings().rootRevision).toBe(modified ? 1 : 2);
    expect(fs.readFileSync(path.join(target, "unmanaged"), "utf8")).toBe("keep");
    expect(fs.readFileSync(path.join(target, h.directoryKey, "shared/file"), "utf8")).toBe(modified ? "external" : "original");
    if (modified) expect(fs.readFileSync(path.join(source, h.directoryKey, "shared/file"), "utf8")).toBe("original");
  } finally { await restored.close(); }
});

it("drains execution instead of crashing the daemon when its output disk is full", async () => {
  const { service } = fixture(), h = await service.acquire(input), open = fs.openSync;
  let injected = false;
  const failure = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
    if (!injected && String(args[0]).endsWith(".jsonl")) {
      injected = true; throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    }
    return open(...args);
  });
  const started = await service.execute(h, { operationId: "output-failure", command: "node", args: ["-e", "setInterval(()=>console.log('output'),5)"] });
  const result = await waitFor(() => service.query(h, { executionId: started.executionId }), s => s.execution.status === "failed");
  failure.mockRestore();
  expect(injected).toBe(true); expect(result.execution.error).toContain("保存执行输出失败");
  await service.write(h, { path: "shared/after", content: "daemon alive" });
});


it.skipIf(process.platform !== "linux" || !fs.existsSync("/dev/shm") || fs.statSync("/dev/shm").dev === fs.statSync(os.tmpdir()).dev)("migrates across actual filesystems without renaming the source", async () => {
  const { service } = fixture(), h = await service.acquire(input);
  const target = fs.mkdtempSync("/dev/shm/woohaa-workspace-");
  try {
    await service.write(h, { path: "shared/cross-volume", content: "copied and verified" });
    const source = service.settings().rootPath;
    expect(fs.statSync(source).dev).not.toBe(fs.statSync(target).dev);
    await service.release(h, "terminal");
    await service.migrate({ operationId: "cross-volume", targetPath: target, expectedRootRevision: 1 });
    await waitFor(() => service.settings(), s => s.migration?.phase === "completed" && !s.migration.cleanupPending);
    const next = await service.acquire({ ...input, requestId: "new-generation" });
    expect((await service.read(next, "shared/cross-volume")).content).toBe("copied and verified");
    expect(fs.existsSync(path.join(source, h.directoryKey))).toBe(false);
    await expect(service.list(h)).rejects.toHaveProperty("code", "workspace-stale");
  } finally { await service.close(); fs.rmSync(target, { recursive: true, force: true }); }
});

it("keeps the old root when the verification journal flush fails before publication", async () => {
  const { root, service } = fixture(), h = await service.acquire(input);
  await service.write(h, { path: "shared/file", content: "original" }); await service.release(h, "terminal");
  const source = service.settings().rootPath, target = path.join(root, "target"), flush = fs.fsyncSync;
  let injected = false;
  const failure = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
    if (!injected && service.settings().migration?.phase === "verifying") {
      injected = true; throw Object.assign(new Error("flush failed"), { code: "ENOSPC" });
    }
    return flush(fd);
  });
  await service.migrate({ operationId: "flush-failure", targetPath: target, expectedRootRevision: 1 });
  await waitFor(() => service.settings(), s => s.migration?.phase === "failed"); failure.mockRestore();
  expect(injected).toBe(true); expect(service.settings().rootPath).toBe(source);
  expect(fs.readFileSync(path.join(source, h.directoryKey, "shared/file"), "utf8")).toBe("original");
  expect(fs.existsSync(path.join(target, h.directoryKey))).toBe(false);
});
