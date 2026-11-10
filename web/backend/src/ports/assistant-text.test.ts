import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createEmptyWoohaa3ServerCanvas,
  decodeAssistantExecutionRef,
  type AgentConversationAdapter,
  type AgentConnectionView,
} from "@woohaa3/contracts";
import { createCanvasAssistantTextPort } from "../../../services/canvas-service/src/task/assistant-text.js";
import {
  CanvasRoom,
  InMemoryYjsDocumentRepository,
} from "../../../services/canvas-service/src/sync/index.js";
import { AssistantTextService } from "../../../services/application-service/src/extensions/assistant-text-service.js";
import { AssistantTextStore } from "../../../services/application-service/src/repository/assistant-text-store.js";
import { createAgentConversationService } from "../../../services/application-service/src/extensions/agent-conversation-service.js";
import { createSqliteAgentConversationStore } from "../../../services/application-service/src/repository/agent-conversation-repository.js";
import { createAgentRoleRegistry } from "../../../services/application-service/src/agent-roles/registry.js";
import { assistantTextCandidateSchema } from "@woohaa3/contracts";

/** 测试用文本角色：只消费宿主准备好的规范回合，schema 与领域解码一致。 */
function textRoles() {
  const registry = createAgentRoleRegistry({ availableTools: () => [] });
  registry.register({
    extensionId: "test",
    artifactId: "test@1",
    implementation: {
      definition: {
        id: "text-author",
        revision: "1",
        title: "文本作者",
        specialty: "写正文",
        instructions: "你是文本作者。",
        inputSchema: { type: "object", additionalProperties: false, required: ["prompt", "action"], properties: { prompt: { type: "string", minLength: 1 }, action: { type: "string" }, mode: { type: "string" } } },
        contextSchema: { type: "object" },
        tools: { required: [], optional: [] },
        nativeCapabilities: { required: [], optional: [] },
        requirements: { imageInput: false, toolCalling: false, structuredOutput: "validated-json" },
        output: { kind: "candidate", schema: assistantTextCandidateSchema }
      },
      prepare: ({ context }) => ({ messages: [{ role: "user", content: (context as { prompt?: string }).prompt ?? "write" }] })
    }
  });
  return registry;
}
const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose()),
);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(run?: AgentConversationAdapter["run"]) {
  const directory = mkdtempSync(path.join(tmpdir(), "assistant-text-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const ledgerPath = path.join(directory, "ledger.sqlite");
  let ledger = createSqliteAgentConversationStore({ path: ledgerPath });
  cleanup.push(() => ledger.close());
  let records = new AssistantTextStore(ledgerPath);
  cleanup.push(() => records.close());
  const binding = {
    connectionId: "connection",
    adapterId: "adapter",
    configRevision: 1,
    credentialEpoch: 1,
  };
  const connection: AgentConnectionView = {
    ...binding,
    extensionId: "test",
    name: "Text only",
    runCategory: "http-sdk",
    authMode: "api-key",
    ready: true,
    credentialConfigured: true,
    status: {
      transport: { state: "ready" },
      credential: { state: "ready" },
      modelAccess: { state: "ready" },
      tools: { state: "unavailable" },
    },
    capabilities: {
      textDelivery: { imageInput: true, maxImages: 12 },
      discussion: true,
      tools: false,
      imageInput: true,
      structuredResult: true,
      resume: false,
      cancel: true,
    },
    models: [
      {
        id: "model",
        label: "Model",
        source: "remote-catalog",
        accountAuthorized: true,
        reasoningEfforts: ["high"],
      },
    ],
  };
  const generate = vi.fn<AgentConversationAdapter["run"]>(
    run ??
      (async () => ({
        status: "succeeded",
        assistantText: JSON.stringify({ text: "\n# Actual text\n" }),
      })),
  );
  const adapter: AgentConversationAdapter = {
    id: "adapter",
    capabilities: () => ({
      textDelivery: { imageInput: true, maxImages: 12 },
      discussion: true,
      tools: false,
      targets: [],
      models: "remote",
    }),
    authorization: async () => "ready",
    models: async () => ({
      models: connection.models.map((model) => ({ ...model })),
    }),
    run: generate,
  };
  const registry = {
    resolve: () => ({
      ok: true as const,
      handle: {
        adapter,
        capabilities: adapter.capabilities(),
        owner: {
          adapterId: "adapter",
          extensionId: "test",
          configVersion: 1,
          mode: "public" as const,
        },
      },
    }),
    list: () => [],
    resolveByCapabilityId: () => {
      throw Error("unused");
    },
  };
  const connections = {
    list: () => [],
    resolve: () => ({
      ok: false as const,
      code: "adapter-unavailable" as const,
      message: "unused",
    }),
    getConnection: vi.fn(async () => connection),
    listConnections: async () => [connection],
  };
  const agentRoles = textRoles();
  let conversations = createAgentConversationService({
    store: ledger,
    registry,
    connections,
    agentRoles,
  });
  const room = new CanvasRoom({
    canvasId: "cv",
    repository: new InMemoryYjsDocumentRepository(),
  });
  const canvas = createEmptyWoohaa3ServerCanvas("cv", new Date().toISOString());
  canvas.document.nodes.push({
    id: "text",
    type: "text",
    position: { x: 0, y: 0 },
  });
  canvas.nodeData.text = { prompt: "write" };
  await room.initialize({
    canvas,
    roomEpoch: "epoch",
    createdAt: new Date().toISOString(),
  });
  const history = {
    registerTaskResult: vi.fn(async () => ({
      status: "inserted",
      entryId: "history",
    })),
    registerTaskFailure: vi.fn(),
  };
  const authority = createCanvasAssistantTextPort({
    resolveRoom: async () => room,
    authorize: async () => true,
    history: history as never,
    media: { verify: async () => ({ exists: true, matches: true }) },
  });
  let service = new AssistantTextService({
    store: records,
    conversations,
    connections,
    registry,
    canvas: authority,
    agentRoles,
    roleId: "test/text-author",
  });
  const created = conversations.createConversation({
    owner: "owner",
    canvasId: "cv",
    nodeId: "text",
    adapterId: "adapter",
    connectionId: "connection",
  });
  if (!created.ok) throw Error(created.error.message);
  const input = (requestId = "a") => ({
    owner: "owner",
    requestId,
    conversationId: created.conversation.conversationId,
    connection: binding,
    entry: {
      roleId: "test/text-author",
      action: "generate" as const,
      mode: "text" as const,
      canvasId: "cv",
      nodeId: "text",
      connectionId: "connection",
      connection: binding,
      model: "model",
      reasoningEffort: "high" as const,
      prompt: "write",
    },
  });
  const settle = async (requestId: string) => {
    const result = conversations.queryTurn({ owner: "owner", requestId });
    if (!result.ok) throw Error(result.error.message);
    await conversations.whenSettled(result.turn.turnId);
    return conversations.queryTurn({ owner: "owner", requestId });
  };
  return {
    input,
    service: () => service,
    conversations: () => conversations,
    generate,
    records: () => records,
    authority,
    room,
    history,
    connection,
    connections,
    settle,
    restart() {
      ledger.close();
      records.close();
      ledger = createSqliteAgentConversationStore({ path: ledgerPath });
      records = new AssistantTextStore(ledgerPath);
      conversations = createAgentConversationService({
        store: ledger,
        registry,
        connections,
      });
      service = new AssistantTextService({
        store: records,
        conversations,
        connections,
        registry,
        canvas: authority,
        agentRoles,
        roleId: "test/text-author",
      });
    },
  };
}
describe("text delivery uses actual ledger and Canvas", () => {
  it("uses the exact connection/model/Variant without tools, saves before succeeding, and replays without inference", async () => {
    const f = await fixture();
    const accepted = await f.service().accept(f.input());
    expect(accepted.ok).toBe(true);
    const execution = f.service().peek("owner", "a")!.execution;
    expect(decodeAssistantExecutionRef(execution, execution.canvasId).ok).toBe(true);
    expect(execution).not.toHaveProperty("commandId");
    expect(execution).not.toHaveProperty("jobId");
    expect(await f.settle("a")).toMatchObject({
      ok: true,
      turn: { status: "succeeded", receipt: { kind: "text-generation" } },
    });
    expect(f.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: f.input().connection,
        intent: expect.objectContaining({
          action: "discuss",
          model: "model",
          reasoningEffort: "high",
        }),
        candidate: expect.objectContaining({ images: [] }),
        history: [],
      }),
    );
    expect(f.generate.mock.calls[0]![0].conversationId).not.toBe(
      f.input().conversationId,
    );
    expect(await f.service().accept(f.input())).toMatchObject({
      ok: true,
      reused: true,
    });
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(
      await f
        .service()
        .accept({
          ...f.input(),
          entry: { ...f.input().entry, prompt: "different" },
        }),
    ).toMatchObject({ ok: false, error: { code: "request-id-reused" } });
    f.restart();
    await f.conversations().reconcileUnknown();
    await f.service().reconcile("owner", "a");
    expect(await f.service().accept(f.input())).toMatchObject({
      ok: true,
      reused: true,
    });
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it("does not confuse intermediate messages or malformed results with artwork", async () => {
    const f = await fixture(async (input) => {
      input.emit({
        type: "message",
        role: "assistant",
        content: "I am preparing the answer",
      });
      return {
        status: "succeeded",
        assistantText: JSON.stringify({ text: "  " }),
      };
    });
    await f.service().accept(f.input());
    expect(await f.settle("a")).toMatchObject({
      ok: true,
      turn: { status: "failed" },
    });
    expect(f.history.registerTaskResult).not.toHaveBeenCalled();
    expect(f.room.exportCanvas()).toMatchObject({
      ok: true,
      canvas: { nodeData: { text: { prompt: "write", taskStatus: "failed" } } },
    });
  });
  it("persists a candidate and retries saving after restart without re-inference", async () => {
    const f = await fixture();
    const commit = f.authority.commit;
    f.authority.commit = vi.fn(async () => {
      throw Error("temporary save outage");
    });
    await f.service().accept(f.input());
    expect(await f.settle("a")).toMatchObject({
      ok: true,
      turn: { status: "failed", error: { code: "write-unconfirmed" } },
    });
    expect(f.records().get("owner", "a")?.candidate?.text).toBe(
      "\n# Actual text\n",
    );
    f.restart();
    await f.conversations().reconcileUnknown();
    f.authority.commit = commit;
    expect(await f.service().retry("owner", "a")).toMatchObject({
      ok: true,
      turn: { status: "succeeded" },
    });
    expect(f.generate).toHaveBeenCalledTimes(1);
    // 重试复用候选与稳定提交命令：只产生一份正文、只登记一次历史。
    const exported = f.room.exportCanvas();
    expect(
      exported.ok &&
        exported.canvas.assets.filter((asset) => asset.mediaKind === "text"),
    ).toHaveLength(1);
    expect(f.history.registerTaskResult).toHaveBeenCalledTimes(1);
  });
  it("accepts independent rounds and only stops the selected one", async () => {
    const gates = [deferred<void>(), deferred<void>()];
    let calls = 0;
    const f = await fixture(async (input) => {
      const index = calls++;
      await gates[index]!.promise;
      return {
        status: input.signal.aborted ? "cancelled" : "succeeded",
        assistantText: JSON.stringify({ text: `result-${index}` }),
      };
    });
    await f.service().accept(f.input("a"));
    await f.service().accept(f.input("b"));
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(2));
    await f.service().cancel("owner", "a");
    gates[0]!.resolve();
    gates[1]!.resolve();
    expect(await f.settle("a")).toMatchObject({
      ok: true,
      turn: { status: "cancelled" },
    });
    expect(await f.settle("b")).toMatchObject({
      ok: true,
      turn: { status: "succeeded" },
    });
  });
});

it("never replays inference when begin persisted but its acknowledgement was lost", async () => {
  const f = await fixture();
  const begin = f.authority.begin;
  f.authority.begin = async (input) => {
    await begin(input);
    throw Error("lost begin acknowledgement");
  };
  expect(await f.service().accept(f.input())).toMatchObject({
    ok: true,
    turn: { status: "failed", error: { code: "result-unconfirmed" } },
  });
  f.restart();
  await f.service().reconcile("owner", "a");
  expect(await f.service().accept(f.input())).toMatchObject({
    ok: true,
    reused: true,
    turn: { status: "failed", error: { code: "result-unconfirmed" } },
  });
  expect(f.generate).not.toHaveBeenCalled();
  expect(f.room.exportCanvas()).toMatchObject({
    ok: true,
    canvas: {
      jobs: [{ id: expect.stringContaining("text-job:") }],
      nodeData: { text: { taskStatus: "failed" } },
    },
  });
  await f.service().cancel("owner", "a");
  // failed 是终态：用户停止不能再把它改写成 cancelled。
  expect(
    f.conversations().queryTurn({ owner: "owner", requestId: "a" }),
  ).toMatchObject({
    ok: true,
    turn: { status: "failed", error: { code: "result-unconfirmed" } },
  });
});

it("recovers accepted ledger acknowledgement loss without inferring an unconfirmed round", async () => {
  const f = await fixture();
  const accept = f.conversations().acceptDeliveryTurn;
  f.conversations().acceptDeliveryTurn = (input) => {
    accept(input);
    throw Error("lost accept acknowledgement");
  };
  expect(await f.service().accept(f.input())).toMatchObject({ ok: false });
  f.restart();
  expect(await f.service().accept(f.input())).toMatchObject({
    ok: true,
    reused: true,
    turn: { status: "failed", error: { code: "result-unconfirmed" } },
  });
  expect(f.generate).not.toHaveBeenCalled();
});

it("lets a durable receipt win over lost commit acknowledgement and a racing stop", async () => {
  const f = await fixture();
  const commit = f.authority.commit;
  let lost = true;
  f.authority.commit = async (input) => {
    const receipt = await commit(input);
    if (lost) {
      lost = false;
      throw Error("lost commit acknowledgement");
    }
    return receipt;
  };
  await f.service().accept(f.input());
  expect(await f.settle("a")).toMatchObject({
    ok: true,
    turn: { status: "succeeded" },
  });
  await f.service().cancel("owner", "a");
  expect(
    f.conversations().queryTurn({ owner: "owner", requestId: "a" }),
  ).toMatchObject({ ok: true, turn: { status: "succeeded" } });
  expect(f.generate).toHaveBeenCalledTimes(1);
  const exported = f.room.exportCanvas();
  expect(
    exported.ok &&
      exported.canvas.assets.filter((asset) => asset.mediaKind === "text"),
  ).toHaveLength(1);
});

it("rejects missing text capability and revoked connection versions before further delivery", async () => {
  const f = await fixture();
  delete f.connection.capabilities.textDelivery;
  expect(await f.service().accept(f.input())).toMatchObject({ ok: false });
  expect(f.generate).not.toHaveBeenCalled();
  f.connection.capabilities.textDelivery = { imageInput: true, maxImages: 12 };
  const commit = f.authority.commit;
  f.authority.commit = async () => {
    throw Error("save unavailable");
  };
  await f.service().accept(f.input());
  await f.settle("a");
  f.connection.credentialEpoch++;
  f.authority.commit = commit;
  expect(await f.service().retry("owner", "a")).toMatchObject({
    ok: true,
    turn: { status: "failed", error: { code: "connection-unavailable" } },
  });
  expect(f.generate).toHaveBeenCalledTimes(1);
});
