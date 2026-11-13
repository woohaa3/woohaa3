import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapterRunOutcome, PreparedAgentRoleTurn } from "@woohaa3/contracts";
import type { ConnectionMetadataRecord } from "@woohaa3/agent-connections";
import { createLocalAgentExecutor } from "./executor.js";
import type { LocalAgentTransport } from "./transports/transport.js";
import type { ExecutorRunContext } from "woohaa3-executor/protocol";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function prepared(): PreparedAgentRoleTurn {
  return {
    schemaVersion: 1,
    roleRef: { namespacedId: "test/local", roleId: "local", extensionId: "test", revision: "1", descriptorDigest: "d", artifactId: "a" },
    messages: [{ role: "user", content: "讨论一下这个场景" }],
    tools: [],
    nativeCapabilities: [],
    output: { kind: "reply" },
    inputDigest: "a",
    contextDigest: "b",
    attachmentDigests: [],
    target: { canvasId: "canvas" },
    preparedHash: "hash"
  };
}

function record(): ConnectionMetadataRecord {
  return {
    owner: "owner",
    connectionId: "connection",
    adapterId: "opencode-server",
    name: "本地 OpenCode",
    runCategory: "local-appserver",
    authMode: "local-login",
    configRevision: 1,
    credentialEpoch: 1,
    models: ["model"],
    createdAt: "now",
    updatedAt: "now"
  };
}

function context(stateDir: string, emitted: unknown[]): ExecutorRunContext {
  return {
    signal: new AbortController().signal,
    turnId: "turn",
    requestId: "request",
    stateDir,
    workspaceKey: "workspace",
    emit: (type, payload) => emitted.push({ type, payload }),
    processes: {
      ensure: async (input) => ({
        key: `${input.adapterId}\u0000${input.owner}\u0000${input.connectionId}`,
        adapterId: input.adapterId,
        owner: input.owner,
        connectionId: input.connectionId,
        kind: input.kind,
        loopbackUrl: "http://127.0.0.1:1",
        stdioPath: null,
        pid: 1,
        startedAt: Date.now()
      }),
      stop: async () => undefined
    },
    host: null
  };
}

describe("local-agent daemon executor", () => {
  it("复用本机 transport 消费 prepared turn，并把事件转回 daemon", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa3-local-executor-"));
    cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    const seen: string[] = [];
    const transport: LocalAgentTransport = {
      id: "opencode-server",
      probe: async () => ({ ok: true }),
      run: async (input) => {
        seen.push(input.prompt);
        input.onEvent({ type: "message", role: "assistant", content: "好的" });
        return { ok: true, outcome: { status: "succeeded", assistantText: "好的" } satisfies AgentAdapterRunOutcome };
      }
    };
    const executor = createLocalAgentExecutor({
      transports: { "opencode-server": transport },
      executableFor: () => "/bin/true"
    });
    const emitted: unknown[] = [];
    const outcome = await executor.run({
      turnId: "turn",
      requestId: "request",
      kind: "agent",
      prepared: prepared(),
      payload: {
        owner: "owner",
        canvasId: "canvas",
        conversationId: "conversation",
        intent: { action: "discuss", canvasId: "canvas", prompt: "讨论一下这个场景" },
        connection: { connectionId: "connection", adapterId: "opencode-server", configRevision: 1, credentialEpoch: 1 },
        record: record()
      }
    }, context(stateDir, emitted));
    expect(outcome).toMatchObject({ status: "succeeded" });
    expect(seen[0]).toContain("讨论一下这个场景");
    expect(emitted).toEqual(expect.arrayContaining([expect.objectContaining({ type: "message" })]));
  });

  it("does not share working directories between owners whose sanitized names collide", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa3-local-executor-"));
    cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    const directories: string[] = [];
    const transport: LocalAgentTransport = { id: "opencode-server", probe: async () => ({ ok: true }), run: async (input) => {
      directories.push(input.workDir);
      return { ok: true, outcome: { status: "succeeded" } };
    } };
    const executor = createLocalAgentExecutor({ transports: { "opencode-server": transport }, executableFor: () => "/bin/true" });
    for (const owner of ["a/b", "a_b"]) {
      expect(await executor.run({ turnId: owner, requestId: owner, kind: "agent", prepared: prepared(), payload: {
        owner, canvasId: "canvas", conversationId: "conversation", intent: { action: "discuss", canvasId: "canvas", prompt: "hello" },
        connection: { connectionId: "connection", adapterId: "opencode-server", configRevision: 1, credentialEpoch: 1 }, record: { ...record(), owner }
      } }, context(stateDir, []))).toMatchObject({ status: "succeeded" });
    }
    expect(directories).toHaveLength(2);
    expect(directories[0]).not.toBe(directories[1]);
  });

  it("缺少 prepared turn 时零推理拒绝", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa3-local-executor-"));
    cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    const executor = createLocalAgentExecutor({ executableFor: () => "/bin/true" });
    const outcome = await executor.run({
      turnId: "turn",
      requestId: "request",
      kind: "agent",
      payload: {
        owner: "owner",
        canvasId: "canvas",
        conversationId: "conversation",
        intent: { action: "discuss", canvasId: "canvas", prompt: "x" },
        connection: { connectionId: "connection", adapterId: "opencode-server", configRevision: 1, credentialEpoch: 1 },
        record: record()
      }
    }, context(stateDir, []));
    expect(outcome).toMatchObject({ status: "failed", error: { code: "role-not-found" } });
  });
});
