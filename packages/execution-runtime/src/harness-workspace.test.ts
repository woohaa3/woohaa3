import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { preparedTurnHash, type CanvasWorkspaceHandle, type PreparedAgentRoleTurn } from "@woohaa3/contracts";
import { startExecutorDaemon } from "./daemon.js";
import { createExecutorClient } from "./client.js";
import { CanvasWorkspaces } from "./canvas-workspaces.js";

function prepared(workspace?: CanvasWorkspaceHandle): PreparedAgentRoleTurn {
  const body: Omit<PreparedAgentRoleTurn, "preparedHash"> = {
    schemaVersion: 1, roleRef: { namespacedId: "test/reply", extensionId: "test", roleId: "reply", revision: "1", descriptorDigest: "a".repeat(64), artifactId: "test" },
    messages: [{ role: "user", content: "calculate" }], tools: [], nativeCapabilities: [], output: { kind: "reply" },
    inputDigest: "input", contextDigest: "context", attachmentDigests: [], target: { canvasId: workspace?.canvasId ?? "canvas" }, ...(workspace ? { workspace } : {})
  };
  return { ...body, preparedHash: preparedTurnHash(body) };
}
it("passes one canvas cwd to distinct harness turns and keeps other canvases separate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-cwd-"));
  const options = { socketPath: path.join(root, "rpc.sock"), token: "token", workspaceKey: "profile", stateDir: path.join(root, "state"), canvasWorkspaceRoot: path.join(root, "files") };
  const daemon = await startExecutorDaemon({ ...options, defaultExecutor: "native-test", executors: [{ id: "native-test", kind: "agent", async run(_input, context) {
    if (!context.workspace) return { status: "succeeded", result: { cwd: null } };
    // The harness performs its own native file/command work. No workspace MCP calls.
    execFileSync(process.execPath, ["-e", "const fs=require('fs');fs.writeFileSync('shared/result',String(21*2));"], { cwd: context.workspace.cwd });
    return { status: "succeeded", result: { cwd: context.workspace.cwd } };
  } }] });
  const client = createExecutorClient(options);
  const run = async (requestId: string, handle?: CanvasWorkspaceHandle) => {
    const turnId = createHash("sha256").update(JSON.stringify(["alice", requestId])).digest("hex");
    await client.runTurn({ turnId, requestId, kind: "agent", prepared: prepared(handle) });
    await client.call("turn.drain", { turnId });
    return (await client.queryTurn(turnId))!;
  };
  try {
    expect(await run("web")).toMatchObject({ status: "succeeded", result: { cwd: null } });
    const a = await client.call<CanvasWorkspaceHandle>("workspace.acquire", { owner: "alice", canvasId: "canvas", requestId: "a" });
    const b = await client.call<CanvasWorkspaceHandle>("workspace.acquire", { owner: "alice", canvasId: "canvas", requestId: "b" });
    const c = await client.call<CanvasWorkspaceHandle>("workspace.acquire", { owner: "alice", canvasId: "other", requestId: "c" });
    const first = await run("a", a), second = await run("b", b), other = await run("c", c);
    expect(first.status).toBe("succeeded"); expect(second.result).toEqual(first.result); expect(other.result).not.toEqual(first.result);
    expect(fs.readFileSync(path.join(options.canvasWorkspaceRoot, a.directoryKey, "shared/result"), "utf8")).toBe("42");
    expect(await run("forged-request", a)).toMatchObject({ status: "failed" });
    expect(await run("forged-owner", { ...a, requestId: "forged-owner", owner: "bob" })).toMatchObject({ status: "failed" });
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
it("pins a cancelled turn until its harness drains, then migrates its files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-pin-"));
  const service = new CanvasWorkspaces({ stateDir: path.join(root, "state"), defaultRoot: path.join(root, "files"), profileKey: "profile" });
  try {
    const handle = await service.acquire({ owner: "alice", canvasId: "canvas", requestId: "request" });
    const native = service.attachHarness(handle);
    fs.writeFileSync(path.join(native.cwd, "shared/native.txt"), "keep");
    await service.settle({ ...handle, outcome: "cancelled" });
    expect((await service.clean(handle)).retained).toContain(handle.runKey);
    const targetPath = path.join(root, "moved");
    expect((await service.migrate({ operationId: "move", targetPath, expectedRootRevision: 1 })).phase).toBe("waiting-for-idle");
    expect(fs.existsSync(native.cwd)).toBe(true);
    native.release(); native.release();
    await expect.poll(() => service.settings().migration?.phase).toBe("completed");
    expect(fs.readFileSync(path.join(targetPath, handle.directoryKey, "shared/native.txt"), "utf8")).toBe("keep");
  } finally { await service.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
it("accepts both host turnId derivations for the same canvas workspace handle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-turn-id-"));
  const options = { socketPath: path.join(root, "rpc.sock"), token: "token", workspaceKey: "profile", stateDir: path.join(root, "state"), canvasWorkspaceRoot: path.join(root, "files") };
  const seen: Array<string | null> = [];
  const daemon = await startExecutorDaemon({ ...options, defaultExecutor: "native-test", executors: [{ id: "native-test", kind: "agent", async run(_input, context) {
    seen.push(context.workspace?.cwd ?? null);
    return { status: "succeeded" };
  } }] });
  const client = createExecutorClient(options);
  // 宿主侧两种 turnId：本机适配器只哈希 (owner, requestId)，扩展执行器还带 extensionId/executor。
  const run = async (requestId: string, owner: string | undefined, handle: CanvasWorkspaceHandle, extensionScoped: boolean) => {
    const turnId = extensionScoped
      ? createHash("sha256").update(JSON.stringify(["sdk-agent", "sdk-agent", handle.owner, requestId])).digest("hex")
      : createHash("sha256").update(JSON.stringify([handle.owner, requestId])).digest("hex");
    await client.runTurn({ turnId, requestId, ...(owner !== undefined ? { owner } : {}), kind: "agent", prepared: prepared(handle) });
    await client.call("turn.drain", { turnId });
    return (await client.queryTurn(turnId))!;
  };
  try {
    const local = await client.call<CanvasWorkspaceHandle>("workspace.acquire", { owner: "alice", canvasId: "canvas", requestId: "local" });
    const extension = await client.call<CanvasWorkspaceHandle>("workspace.acquire", { owner: "alice", canvasId: "canvas", requestId: "extension" });
    // 旧的隐式哈希约定仍可用（未声明的 owner 退回二元素比对）。
    expect(await run("local", undefined, local, false)).toMatchObject({ status: "succeeded" });
    // 扩展执行器的四元素 turnId 只要带上可信 owner 也应当通过。
    expect(await run("extension", "alice", extension, true)).toMatchObject({ status: "succeeded" });
    expect(seen).toHaveLength(2);
    // 声明的 owner 与工作目录 owner 不一致时仍然拒绝（换 requestId 避免命中幂等记录）。
    const forged = await client.call<CanvasWorkspaceHandle>("workspace.acquire", { owner: "alice", canvasId: "canvas", requestId: "forged" });
    expect(await run("forged", "bob", forged, true)).toMatchObject({ status: "failed" });
  } finally { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
it("retains unknown harness occupancy after restart even if the chat was already cancelled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-recovery-"));
  const options = { stateDir: path.join(root, "state"), defaultRoot: path.join(root, "files"), profileKey: "profile" };
  const first = new CanvasWorkspaces(options);
  const h = await first.acquire({ owner: "alice", canvasId: "canvas", requestId: "request" });
  first.attachHarness(h);
  await first.settle({ ...h, outcome: "cancelled" });
  const recovered = new CanvasWorkspaces(options);
  try {
    await recovered.settle({ ...h, outcome: "terminal" });
    expect(recovered.leases()[0]?.status).toBe("unknown");
    expect((await recovered.clean(h)).retained).toContain(h.runKey);
  } finally { await recovered.close(); await first.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
