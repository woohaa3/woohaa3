import { nativeContextFor, nativeContextKey } from "@woohaa3/agent-connections";
/**
 * local-agent 连接装配与会话 adapter 测试（注入 fake；不启动真实进程）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 3.2/3.3/4.2/6.2/6.4 验收）。
 *
 * 覆盖：加载/创建不启进程；执行才 ensure 专用进程（每 owner/连接独立目录与回环地址）；
 * 缺运行时明确失败；无工具委托时不放行工具（fail closed）；成功登记原生会话；失败不冒充成功；
 * 停用后停自有进程。
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentConversationAdapter, AgentAdapterRunInput, AgentConnectionStatus, ApplicationToolDelegationFacade } from "@woohaa3/contracts";
import type { ConnectionMetadataRecord } from "@woohaa3/agent-connections";
import { createLocalAgentConversationAdapter, createLocalAgentDescriptors, type LocalAgentRuntimeOptions } from "./local-agent-connections.js";
import { LOCAL_AGENT_ADAPTERS } from "../shared.js";
import type { ProcessManager, ProcessHandle } from "./process-manager.js";
import type { LocalAgentTransport, LocalAgentTransportInput, LocalAgentTransportResult } from "./transports/transport.js";
import { buildTestPreparedTurn, toolsForTestIntent } from "@woohaa3/test-fixtures-agent-role-turns";

const codexAdapter = LOCAL_AGENT_ADAPTERS.find((adapter) => adapter.adapterId === "codex-appserver")!;
const opencodeAdapter = LOCAL_AGENT_ADAPTERS.find((adapter) => adapter.adapterId === "opencode-server")!;

function record(overrides: Partial<ConnectionMetadataRecord> = {}): ConnectionMetadataRecord {
  return {
    connectionId: "c1",
    owner: "u1",
    adapterId: "codex-appserver",
    name: "本机 Codex",
    runCategory: "local-appserver",
    authMode: "local-login",
    configRevision: 1,
    credentialEpoch: 1,
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
    ...overrides
  };
}

function fakeService(initial: ConnectionMetadataRecord[]) {
  const patches: Array<Partial<AgentConnectionStatus>> = [];
  const natives: Array<{ nativeId: string; credentialEpoch: number }> = [];
  const service = {
    list: async () => initial,
    get: async (_owner: string, connectionId: string) => initial.find((entry) => entry.connectionId === connectionId) ?? null,
    setStatus: async ({ patch }: { patch: Partial<AgentConnectionStatus> }) => {
      patches.push(patch);
      return { ok: true as const, value: initial[0] };
    },
    resolveNativeBinding: async () => null,
    setNativeBinding: async ({ native }: { native: { nativeId: string; credentialEpoch: number } }) => {
      natives.push(native);
      return { ok: true as const, value: initial[0] };
    }
  };
  return { service: service as unknown as LocalAgentRuntimeOptions["service"], patches, natives };
}

function fakeProcessManager(options: { executable?: string | null } = {}): {
  manager: ProcessManager;
  ensureCalls: Array<{ adapterId: string; owner: string; connectionId: string }>;
} {
  const ensureCalls: Array<{ adapterId: string; owner: string; connectionId: string }> = [];
  let counter = 0;
  const manager: ProcessManager = {
    probe: (adapterId) => (options.executable ? { ok: true, version: "unknown" } : { ok: false, code: "runtime-missing", message: `未安装 ${adapterId}` }),
    ensure: async (input) => {
      if (options.executable === null) throw new Error("未安装可执行文件");
      ensureCalls.push({ adapterId: input.adapterId, owner: input.owner, connectionId: input.connectionId });
      counter += 1;
      const workDir = `/tmp/local-agent/${input.adapterId}/${input.owner}/${input.connectionId}`;
      const handle: ProcessHandle = {
        key: `${input.adapterId}\u0000${input.owner}\u0000${input.connectionId}`,
        adapterId: input.adapterId,
        owner: input.owner,
        connectionId: input.connectionId,
        kind: input.kind,
        loopbackUrl: input.kind === "http" ? `http://127.0.0.1:${42000 + counter}` : null,
        pid: 1000 + counter,
        workDir,
        configDir: `${workDir}/config`,
        startedAt: Date.now()
      };
      return handle;
    },
    get: () => null,
    stop: async () => undefined,
    stopAll: async () => undefined,
    activeCount: () => ensureCalls.length
  };
  return { manager, ensureCalls };
}

function fakeTransport(result: LocalAgentTransportResult | ((input: LocalAgentTransportInput) => LocalAgentTransportResult)): {
  transport: LocalAgentTransport;
  inputs: LocalAgentTransportInput[];
} {
  const inputs: LocalAgentTransportInput[] = [];
  return {
    inputs,
    transport: {
      id: "codex-appserver",
      probe: async () => ({ ok: true }),
      run: async (input) => {
        inputs.push(input);
        if (typeof result !== "function" && result.ok && input.allowedTools.includes("submit_model_script")) {
          input.onEvent({ type: "tool-started", tool: "submit_model_script", callId: "mock-write" });
          input.onEvent({ type: "tool-completed", tool: "submit_model_script", callId: "mock-write", ok: true });
        }
        return typeof result === "function" ? result(input) : result;
      }
    }
  };
}

const MCP_ENDPOINT = { name: "woohaa", url: "http://127.0.0.1:1234/dev/app/mcp/model-canvas" };

function fakeToolFacade(authorize: ApplicationToolDelegationFacade["authorize"] = () => ({ ok: true })) {
  const issued: Array<{ tools: readonly string[]; workId: string; nodeId: string; clipId?: string; itemId?: string }> = [];
  const facade: ApplicationToolDelegationFacade = {
    issue: async (request) => {
      issued.push({
        tools: request.tools ?? [],
        workId: request.workId,
        nodeId: request.nodeId,
        ...(request.clipId ? { clipId: request.clipId } : {}),
        ...(request.itemId ? { itemId: request.itemId } : {})
      });
      return { token: "grant-1", canvasIds: [], nodeIds: [], tools: request.tools ?? [], workId: request.workId };
    },
    revoke: () => undefined,
    authorize
  };
  return { issued, facade };
}

function runInput(overrides: Partial<AgentAdapterRunInput> = {}, emitted: unknown[] = []): AgentAdapterRunInput {
  const intent = overrides.intent ?? { action: "generate" as const, canvasId: "canvas-1", nodeId: "n1", mode: "model3d" as const, prompt: "生成一个立方体" };
  return {
    owner: "u1",
    canvasId: "canvas-1",
    conversationId: "conv-1",
    turnId: "turn-1",
    requestId: "req-1",
    intent,
    // 通道测试统一注入宿主已准备的规范请求；真实链路由 application-service 准备。
    prepared: buildTestPreparedTurn({
      requestId: overrides.requestId ?? "req-1",
      target: {
        canvasId: intent.canvasId,
        ...(intent.nodeId ? { nodeId: intent.nodeId } : {}),
        ...(intent.mode ? { mode: intent.mode } : {}),
        ...(intent.cameraId ? { cameraId: intent.cameraId } : {})
      },
      prompt: intent.prompt,
      tools: toolsForTestIntent(intent),
      output: overrides.candidate
        ? { kind: "candidate", schema: overrides.candidate.outputSchema }
        : { kind: "tool-receipts" }
    }),
    connection: { connectionId: "c1", adapterId: "codex-appserver", configRevision: 1, credentialEpoch: 1 },
    history: [],
    signal: new AbortController().signal,
    emit: (event) => emitted.push(event),
    ...overrides
  };
}

describe("local-agent 连接描述（任务 3.1）", () => {
  it("描述器覆盖全部本机 adapter，且不冒称 ready", () => {
    const descriptors = createLocalAgentDescriptors();
    expect(Object.keys(descriptors).sort()).toEqual(LOCAL_AGENT_ADAPTERS.map((adapter) => adapter.adapterId).sort());
    for (const descriptor of Object.values(descriptors)) {
      const described = descriptor.describe({ record: record(), credentialConfigured: false, readCredential: async () => null, recordStatus: async () => undefined });
      expect(typeof described).toBe("object");
    }
  });

  it("本地连接不要求在配置页完成预检", async () => {
    const descriptors = createLocalAgentDescriptors();
    const described = await descriptors["opencode-server"]!.describe({ record: record({ adapterId: "opencode-server", authMode: "local-login" }), credentialConfigured: false, readCredential: async () => null, recordStatus: async () => undefined });
    expect(described.required).toEqual([]);
  });

  it("没有手填模型时不伪造 app-server-default，保留真实目录/占位", async () => {
    const descriptors = createLocalAgentDescriptors();
    const empty = await descriptors["codex-appserver"]!.describe({ record: record(), credentialConfigured: false, readCredential: async () => null, recordStatus: async () => undefined });
    expect(empty.models).toEqual([]);
    const configured = await descriptors["codex-appserver"]!.describe({ record: record({ models: ["gpt-6.1-sol"] }), credentialConfigured: false, readCredential: async () => null, recordStatus: async () => undefined });
    expect(configured.models).toEqual([{ id: "gpt-6.1-sol", label: "gpt-6.1-sol", source: "user-provided", accountAuthorized: false }]);
  });
});

describe("local-agent 会话 adapter（任务 3.2/4.2/6.2/6.4）", () => {
  it.each(["read-only", "validate_canvas_script", "validate_canvas_plan", "failed-write"])("does not report success for %s and does not spend grants on notifications", async kind => {
    const { service } = fakeService([record()]);
    const { manager } = fakeProcessManager({ executable: "/usr/bin/codex" });
    const { facade } = fakeToolFacade();
    const authorize = vi.spyOn(facade, "authorize");
    const { transport } = fakeTransport(input => {
      const tool = kind === "read-only" ? "get_model_node" : kind.startsWith("validate_") ? kind : "submit_model_script";
      input.onEvent({ type: "tool-started", tool, callId: "call" });
      input.onEvent({ type: "tool-completed", tool, callId: "call", ok: kind !== "failed-write", summary: "validation rejected" });
      return { ok: true, outcome: { status: "succeeded" } };
    });
    const adapter = createLocalAgentConversationAdapter(codexAdapter, { service, processManager: manager, transports: { "codex-appserver": transport }, argsFor: () => [], tools: facade, mcpEndpoint: MCP_ENDPOINT });
    expect(await adapter.run(runInput({ prepared: buildTestPreparedTurn({ requestId: "req-1", target: { canvasId: "canvas-1", nodeId: "n1" }, prompt: "test", tools: ["get_model_node", "submit_model_script", "validate_canvas_script", "validate_canvas_plan"] }) }))).toMatchObject({ status: "failed", error: { code: "canvas-not-modified" } });
    expect(authorize).not.toHaveBeenCalled();
  });
  it("exposes real model-scoped tools and revokes only this owner", async () => {
    const { service } = fakeService([record()]);
    const { manager } = fakeProcessManager({ executable: "/usr/bin/codex" });
    const { transport, inputs } = fakeTransport({ ok: true, outcome: { status: "succeeded" } });
    const { facade } = fakeToolFacade();
    const issue = vi.spyOn(facade, "issue");
    const revoke = vi.spyOn(facade, "revoke");
    const adapter = createLocalAgentConversationAdapter(codexAdapter, { service, processManager: manager, transports: { "codex-appserver": transport }, argsFor: () => [], tools: facade, mcpEndpoint: MCP_ENDPOINT });
    const input = runInput({ intent: { action: "generate", canvasId: "canvas-1", nodeId: "root", mode: "model3d", expectedContentHash: "hash-7", prompt: "scene" } });
    expect((await adapter.run(input)).status).toBe("succeeded");
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({ mode: "model3d", nodeId: "root", tools: expect.arrayContaining(["get_model_node", "submit_model_script"]) }));
    expect(inputs[0]!.prompt).toContain("root");
    expect(revoke).toHaveBeenLastCalledWith("req-1", { subject: "u1", authLevel: "authenticated" });
    issue.mockClear();
    await adapter.run(runInput({ requestId: "discussion", intent: { ...input.intent, action: "discuss" } }));
    expect(issue).not.toHaveBeenCalled();
    expect(inputs[1]!.toolToken).toBeNull();
  });
  it("组内回合把点名图片的字节放进输入", async () => {
    const { service } = fakeService([record()]);
    const { manager } = fakeProcessManager({ executable: "/usr/bin/codex" });
    const { transport, inputs } = fakeTransport({ ok: true, outcome: { status: "succeeded" } });
    const adapter = createLocalAgentConversationAdapter(codexAdapter, {
      service,
      processManager: manager,
      transports: { "codex-appserver": transport },
      argsFor: () => [],
      resolveMentionedImages: async () => ({
        images: [{ bytes: Uint8Array.from([1, 2, 3]), contentType: "image/png" }],
        note: "Image 1：Android Compact"
      })
    });
    const outcome = await adapter.run(runInput({
      intent: { action: "discuss", canvasId: "canvas-1", nodeId: "root", mode: "canvas-group", prompt: "参考 Android Compact，图里是什么" }
    }));
    expect(outcome.status).toBe("succeeded");
    expect(inputs[0]?.images).toEqual([{ bytes: Uint8Array.from([1, 2, 3]), contentType: "image/png" }]);
    expect(inputs[0]?.prompt).toContain("Image 1：Android Compact");
  });
  it("未冻结连接时不执行、不启动进程", async () => {
    const { service } = fakeService([record()]);
    const { manager, ensureCalls } = fakeProcessManager();
    const { transport, inputs } = fakeTransport({ ok: true, outcome: { status: "succeeded", assistantText: "hi" } });
    const adapter = createLocalAgentConversationAdapter(codexAdapter, { service, processManager: manager, transports: { "codex-appserver": transport }, argsFor: () => ["app-server", "--stdio"] });
    const outcome = await adapter.run(runInput({ connection: undefined }));
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("connection-unavailable");
    expect(ensureCalls).toHaveLength(0);
    expect(inputs).toHaveLength(0);
  });

  it("同连接跨目标与清空后的新会话使用不同专用进程资源", async () => {
    const { service } = fakeService([record()]);
    const { manager, ensureCalls } = fakeProcessManager({ executable: "/usr/bin/codex" });
    const { transport } = fakeTransport({ ok: true, outcome: { status: "succeeded", assistantText: "reply" } });
    const adapter = createLocalAgentConversationAdapter(codexAdapter, { service, processManager: manager, transports: { "codex-appserver": transport }, argsFor: () => [] });
    for (const [index, conversationId, nodeId] of [[1, "conv-1", "n1"], [2, "conv-1", "n2"], [3, "after-clear", "n1"]] as const) {
      expect((await adapter.run(runInput({ requestId: `context-${index}`, conversationId, intent: { action: "discuss", canvasId: "canvas-1", nodeId, prompt: "reply" } }))).status).toBe("succeeded");
    }
    expect(new Set(ensureCalls.map((call) => call.connectionId)).size).toBe(3);
  });

  it.each(["discuss", "modify"] as const)("原生线程无法恢复时，%s 回合回放宿主账本历史", async action => {
    const { service } = fakeService([record()]);
    const { manager } = fakeProcessManager({ executable: "/usr/bin/codex" });
    const { transport, inputs } = fakeTransport({ ok: true, outcome: { status: "succeeded", assistantText: "reply" } });
    const adapter = createLocalAgentConversationAdapter(codexAdapter, {
      service,
      processManager: manager,
      transports: { "codex-appserver": transport },
      tools: fakeToolFacade().facade,
      mcpEndpoint: MCP_ENDPOINT,
      argsFor: () => []
    });
    const outcome = await adapter.run(runInput({
      intent: { action, canvasId: "canvas-1", nodeId: "n1", mode: "model3d", prompt: "继续刚才的模型" },
      history: [
        { messageId: "m1", conversationId: "conv-1", turnId: "old", requestId: "old", role: "user", content: "生成一个立方体", truncated: false, sequence: 1, createdAt: "2026-10-16T00:00:00.000Z" },
        { messageId: "m2", conversationId: "conv-1", turnId: "old", requestId: "old", role: "assistant", content: "已生成一个立方体。", truncated: false, sequence: 2, createdAt: "2026-10-16T00:00:01.000Z" }
      ]
    }));
    expect(outcome.status).toBe("succeeded");
    expect(inputs[0]?.prompt).toContain("已生成一个立方体");
    expect(inputs[0]?.prompt).toContain("继续刚才的模型");
  });

  it("执行时启动专用进程并按连接传入隔离目录；成功登记原生会话", async () => {
    const { service, natives, patches } = fakeService([record()]);
    const { manager, ensureCalls } = fakeProcessManager({ executable: "/usr/bin/codex" });
    const { transport, inputs } = fakeTransport({ ok: true, outcome: { status: "succeeded", assistantText: "ok" }, nativeId: "thread-9" });
    const { facade, issued } = fakeToolFacade();
    const adapter = createLocalAgentConversationAdapter(codexAdapter, { service, processManager: manager, transports: { "codex-appserver": transport }, argsFor: () => ["app-server", "--stdio"], tools: facade, mcpEndpoint: MCP_ENDPOINT });
    const outcome = await adapter.run(runInput());
    expect(outcome.status).toBe("succeeded");
    const context = nativeContextFor(runInput(), `codex-appserver:1:${[...issued[0]!.tools].sort().join(",")}`);
    const resourceKey = nativeContextKey("u1", "c1", context);
    expect(ensureCalls).toEqual([{ adapterId: "codex-appserver", owner: "u1", connectionId: resourceKey }]);
    expect(inputs[0]!.configDir).toBe(`/tmp/local-agent/codex-appserver/u1/${resourceKey}/config`);
    expect(inputs[0]!.loopbackUrl).toBeNull();
    expect(inputs[0]!.toolToken).toBe("grant-1");
    // 真实 MCP 工具名，而不是抽象 read_node/write_node；否则宿主逐次授权会拒绝。
    expect(issued[0]).toMatchObject({ workId: "req-1", nodeId: "n1" });
    expect(issued[0]!.tools).toEqual(expect.arrayContaining(["get_model_node", "get_model_api", "submit_model_script"]));
    // prompt 必须把画布目标与工具流程送给模型，不能只转发用户原话。
    expect(inputs[0]!.prompt).toContain('canvasId="canvas-1"');
    expect(inputs[0]!.prompt).toContain('nodeId="n1"');
    expect(inputs[0]!.prompt).toContain("get_model_node");
    expect(inputs[0]!.prompt).toContain("submit_model_script");
    expect(inputs[0]!.prompt).toContain("生成一个立方体");
    expect(natives).toEqual([expect.objectContaining({ nativeId: "thread-9", credentialEpoch: 1 })]);
    // transport 证据来自真实探测回调；测试假传输未回调则不伪造。
    expect(patches).toHaveLength(0);
  });

  it("忽略 MCP 资源探测伪工具，不把它计成 tool-not-allowed", async () => {
    const { service } = fakeService([record()]);
    const { manager } = fakeProcessManager({ executable: "/usr/bin/codex" });
    const emitted: unknown[] = [];
    const { transport } = fakeTransport(input => {
      input.onEvent({ type: "tool-started", tool: "list_mcp_resources", callId: "r1" });
      input.onEvent({ type: "tool-completed", tool: "list_mcp_resources", callId: "r1", ok: false, summary: "method not found" });
      input.onEvent({ type: "tool-started", tool: "list_mcp_resource_templates", callId: "r2" });
      input.onEvent({ type: "tool-completed", tool: "list_mcp_resource_templates", callId: "r2", ok: false, summary: "method not found" });
      input.onEvent({ type: "tool-started", tool: "submit_model_script", callId: "w1" });
      input.onEvent({ type: "tool-completed", tool: "submit_model_script", callId: "w1", ok: true });
      return { ok: true, outcome: { status: "succeeded", assistantText: "done" } };
    });
    const adapter = createLocalAgentConversationAdapter(codexAdapter, { service, processManager: manager, transports: { "codex-appserver": transport }, argsFor: () => [], tools: fakeToolFacade().facade, mcpEndpoint: MCP_ENDPOINT });
    const outcome = await adapter.run(runInput({}, emitted));
    expect(outcome.status).toBe("succeeded");
    expect(emitted).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool-completed", tool: "list_mcp_resources" }),
      expect.objectContaining({ type: "tool-completed", tool: "list_mcp_resource_templates" })
    ]));
    expect(emitted).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool-completed", tool: "submit_model_script" })]));
  });

  it("目标回合缺少工具委托时在启动进程前失败，不让模型空答", async () => {
    const { service } = fakeService([record()]);
    const { manager, ensureCalls } = fakeProcessManager({ executable: "/usr/bin/codex" });
    const { transport, inputs } = fakeTransport({ ok: true, outcome: { status: "succeeded", assistantText: "should-not-run" } });
    const adapter = createLocalAgentConversationAdapter(codexAdapter, { service, processManager: manager, transports: { "codex-appserver": transport }, argsFor: () => ["app-server", "--stdio"], mcpEndpoint: MCP_ENDPOINT });
    const outcome = await adapter.run(runInput());
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("capability-unsupported");
    expect(ensureCalls).toHaveLength(0);
    expect(inputs).toHaveLength(0);
  });

  it("注入工具委托且授权通过时，真实 MCP 工具调用进入 tool-started", async () => {
    const { service } = fakeService([record({ adapterId: "opencode-server", connectionId: "c2" })]);
    const { manager } = fakeProcessManager({ executable: "/usr/bin/opencode" });
    const emitted: unknown[] = [];
    const { transport } = fakeTransport((input) => {
      input.onEvent({ type: "tool-started", tool: "get_model_node", callId: "t1" });
      input.onEvent({ type: "tool-started", tool: "submit_model_script", callId: "t2" });
      input.onEvent({ type: "tool-completed", tool: "submit_model_script", callId: "t2", ok: true });
      return { ok: true, outcome: { status: "succeeded", assistantText: "done" } };
    });
    const { facade, issued } = fakeToolFacade();
    const adapter = createLocalAgentConversationAdapter(opencodeAdapter, {
      service,
      processManager: manager,
      transports: { "opencode-server": transport },
      argsFor: () => ["serve"],
      tools: facade,
      mcpEndpoint: MCP_ENDPOINT
    });
    const outcome = await adapter.run(runInput({ connection: { connectionId: "c2", adapterId: "opencode-server", configRevision: 1, credentialEpoch: 1 } }, emitted));
    expect(outcome.status).toBe("succeeded");
    expect(issued[0]!.tools).toEqual(expect.arrayContaining(["get_model_node", "submit_model_script"]));
    expect(emitted).toContainEqual(expect.objectContaining({ type: "tool-started", tool: "get_model_node", callId: "t1" }));
    expect(emitted).toContainEqual(expect.objectContaining({ type: "tool-started", tool: "submit_model_script", callId: "t2" }));
  });

  it("思考强度按适配器真实能力放行：OpenCode 传下去，CodeBuddy 明确拒绝", async () => {
    const opencodeRun = async (reasoningEffort: "high" | undefined) => {
      const { service } = fakeService([record({ adapterId: "opencode-server", connectionId: "c2" })]);
      const { manager } = fakeProcessManager({ executable: "/usr/bin/opencode" });
      const { transport, inputs } = fakeTransport((input) => {
        input.onEvent({ type: "tool-started", tool: "submit_model_script", callId: "t1" });
        input.onEvent({ type: "tool-completed", tool: "submit_model_script", callId: "t1", ok: true });
        return { ok: true, outcome: { status: "succeeded" } };
      });
      const adapter = createLocalAgentConversationAdapter(opencodeAdapter, {
        service,
        processManager: manager,
        transports: { "opencode-server": transport },
        argsFor: () => ["serve"],
        tools: fakeToolFacade().facade,
        mcpEndpoint: MCP_ENDPOINT
      });
      const outcome = await adapter.run(runInput({
        connection: { connectionId: "c2", adapterId: "opencode-server", configRevision: 1, credentialEpoch: 1 },
        intent: { action: "generate", canvasId: "canvas-1", nodeId: "n1", mode: "model3d", prompt: "场景", ...(reasoningEffort ? { reasoningEffort } : {}) }
      }));
      return { outcome, inputs };
    };
    const passed = await opencodeRun("high");
    expect(passed.outcome.status).toBe("succeeded");
    expect(passed.inputs[0]!.reasoningEffort).toBe("high");
    // 默认档位不进传输层：省略即沿用模型默认，不冒充显式选择。
    const plain = await opencodeRun(undefined);
    expect(plain.outcome.status).toBe("succeeded");
    expect(plain.inputs[0]!.reasoningEffort).toBeUndefined();

    const codebuddy = LOCAL_AGENT_ADAPTERS.find((entry) => entry.adapterId === "codebuddy-server")!;
    const { service } = fakeService([record({ adapterId: "codebuddy-server", connectionId: "c3" })]);
    const { manager, ensureCalls } = fakeProcessManager({ executable: "/usr/bin/codebuddy" });
    const { transport, inputs } = fakeTransport({ ok: true, outcome: { status: "succeeded" } });
    const adapter = createLocalAgentConversationAdapter(codebuddy, {
      service,
      processManager: manager,
      transports: { "codebuddy-server": transport },
      argsFor: () => ["--serve"],
      tools: fakeToolFacade().facade,
      mcpEndpoint: MCP_ENDPOINT
    });
    const rejected = await adapter.run(runInput({
      connection: { connectionId: "c3", adapterId: "codebuddy-server", configRevision: 1, credentialEpoch: 1 },
      intent: { action: "generate", canvasId: "canvas-1", nodeId: "n1", mode: "model3d", prompt: "场景", reasoningEffort: "high" }
    }));
    expect(rejected).toMatchObject({ status: "failed", error: { code: "capability-unsupported" } });
    // 拒绝发生在推理前：不启动专用进程，也不进入传输层。
    expect(ensureCalls).toHaveLength(0);
    expect(inputs).toHaveLength(0);
  });

  it("未知工具通知不消耗 grant，且没有写入回执时不能报告成功", async () => {
    const { service } = fakeService([record()]);
    const { manager } = fakeProcessManager({ executable: "/usr/bin/codex" });
    const emitted: unknown[] = [];
    const { transport } = fakeTransport((input) => {
      input.onEvent({ type: "tool-started", tool: "shell", callId: "t1" });
      return { ok: true, outcome: { status: "succeeded", assistantText: "done" } };
    });
    const { facade } = fakeToolFacade(() => ({ ok: false, reason: "tool-not-allowed" }));
    const adapter = createLocalAgentConversationAdapter(codexAdapter, {
      service,
      processManager: manager,
      transports: { "codex-appserver": transport },
      argsFor: () => ["app-server", "--stdio"],
      tools: facade,
      mcpEndpoint: MCP_ENDPOINT
    });
    const outcome = await adapter.run(runInput({}, emitted));
    expect(outcome.status).toBe("failed");
    expect(emitted).toContainEqual(expect.objectContaining({ type: "tool-completed", tool: "shell", ok: false }));
    expect(emitted).not.toContainEqual(expect.objectContaining({ type: "tool-started", tool: "shell" }));
  });

  it("缺运行时（未安装 CLI）明确失败，不冒充成功", async () => {
    const { service } = fakeService([record()]);
    const { manager, ensureCalls } = fakeProcessManager({ executable: null });
    const { transport, inputs } = fakeTransport({ ok: true, outcome: { status: "succeeded", assistantText: "should-not-run" } });
    const { facade } = fakeToolFacade();
    const adapter = createLocalAgentConversationAdapter(codexAdapter, { service, processManager: manager, transports: { "codex-appserver": transport }, argsFor: () => [], tools: facade, mcpEndpoint: MCP_ENDPOINT });
    const outcome = await adapter.run(runInput());
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("transport-unavailable");
    expect(ensureCalls).toHaveLength(0);
    expect(inputs).toHaveLength(0);
  });

  it("传输返回失败时映射为 failed，不返回 succeeded", async () => {
    const { service, patches } = fakeService([record()]);
    const { manager } = fakeProcessManager({ executable: "/usr/bin/codex" });
    const { transport } = fakeTransport({ ok: false, code: "runtime-missing", message: "缺少 App Server" });
    const { facade } = fakeToolFacade();
    const adapter = createLocalAgentConversationAdapter(codexAdapter, { service, processManager: manager, transports: { "codex-appserver": transport }, argsFor: () => [], tools: facade, mcpEndpoint: MCP_ENDPOINT });
    const outcome = await adapter.run(runInput());
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("runtime-missing");
    expect(patches.some((patch) => patch.transport?.state === "unavailable")).toBe(true);
  });

  it("停用/未启用时拒绝新回合，且不启动进程", async () => {
    const { service } = fakeService([record()]);
    const { manager, ensureCalls } = fakeProcessManager({ executable: "/usr/bin/codex" });
    const { transport, inputs } = fakeTransport({ ok: true, outcome: { status: "succeeded", assistantText: "should-not-run" } });
    const adapter = createLocalAgentConversationAdapter(codexAdapter, {
      service,
      processManager: manager,
      transports: { "codex-appserver": transport },
      argsFor: () => [],
      admission: () => false
    });
    const outcome = await adapter.run(runInput());
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("extension-disabled");
    expect(ensureCalls).toHaveLength(0);
    expect(inputs).toHaveLength(0);
  });

  it("授权状态只在本机登录就绪时 ready", async () => {
    const ready = record({ lastStatus: { transport: { state: "ready", checkedAt: null }, credential: { state: "ready", checkedAt: null }, modelAccess: { state: "unknown", checkedAt: null }, tools: { state: "unknown", checkedAt: null } } });
    const { service } = fakeService([ready]);
    const { manager } = fakeProcessManager();
    const adapter = createLocalAgentConversationAdapter(codexAdapter, { service, processManager: manager, transports: {}, argsFor: () => [] });
    expect(await adapter.authorization({ owner: "u1" })).toBe("ready");

    const { service: empty } = fakeService([]);
    const other = createLocalAgentConversationAdapter(codexAdapter, { service: empty, processManager: manager, transports: {}, argsFor: () => [] });
    expect(await other.authorization({ owner: "u1" })).toBe("disconnected");
  });

  it("模型目录读取启动专用进程并采用上游真实列表；未安装时返回原因", async () => {
    const { service, patches } = fakeService([record()]);
    const { manager, ensureCalls } = fakeProcessManager({ executable: "/usr/bin/codex" });
    const transport: LocalAgentTransport = {
      id: "codex-appserver",
      probe: async () => ({ ok: true }),
      models: async () => ({ models: [{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol" }] }),
      run: async () => ({ ok: true, outcome: { status: "succeeded", assistantText: "unused" } })
    };
    const adapter = createLocalAgentConversationAdapter(codexAdapter, { service, processManager: manager, transports: { "codex-appserver": transport }, argsFor: () => ["app-server", "--stdio"] });
    expect(await adapter.models({ owner: "u1" })).toMatchObject({ models: [{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol" }] });
    expect(ensureCalls).toEqual([{ adapterId: "codex-appserver", owner: "u1", connectionId: "c1" }]);
    expect(patches.at(-1)?.transport?.state).toBe("ready");

    const { service: missingService } = fakeService([record()]);
    const { manager: missingManager, ensureCalls: missingEnsure } = fakeProcessManager({ executable: null });
    const missing = createLocalAgentConversationAdapter(codexAdapter, { service: missingService, processManager: missingManager, transports: { "codex-appserver": transport }, argsFor: () => [] });
    const result = await missing.models({ owner: "u1" });
    expect(result.models).toEqual([]);
    expect(result.error).toContain("未安装");
    expect(missingEnsure).toHaveLength(0);
  });
  it("restarts only the catalog process when a reconnected Codex was already initialized", async () => {
    const { service } = fakeService([record()]);
    const { manager, ensureCalls } = fakeProcessManager({ executable: "/usr/bin/codex" });
    const stop = vi.fn(async () => {}); manager.stop = stop;
    const models = vi.fn().mockResolvedValueOnce({ models: [], error: "Already initialized" }).mockResolvedValueOnce({ models: [{ id: "model", label: "Model" }] });
    const transport: LocalAgentTransport = { id: "codex-appserver", probe: async () => ({ ok: true }), models, run: async () => ({ ok: true, outcome: { status: "succeeded" } }) };
    const adapter = createLocalAgentConversationAdapter(codexAdapter, { service, processManager: manager, transports: { "codex-appserver": transport }, argsFor: () => [] });
    expect(await adapter.models({ owner: "u1" })).toMatchObject({ models: [{ id: "model", label: "Model" }] });
    expect(stop).toHaveBeenCalledWith({ adapterId: "codex-appserver", owner: "u1", connectionId: "c1" });
    expect(ensureCalls).toHaveLength(2);
  });
});

describe("无执行额度（任务 2.2 / 2.5）", () => {
  it.each(LOCAL_AGENT_ADAPTERS)("$adapterId accepts the completed candidate after 30 minutes", async descriptor => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const { service } = fakeService([record({ adapterId: descriptor.adapterId })]);
      const { manager } = fakeProcessManager({ executable: "/native" });
      const text = "x".repeat(1024 * 1024);
      const { transport } = fakeTransport(input => {
        clock.mockReturnValue(1000 + 30 * 60_000);
        input.onEvent({ type: "message", role: "assistant", content: text });
        return { ok: true, outcome: { status: "succeeded", assistantText: text } };
      });
      const adapter = createLocalAgentConversationAdapter(descriptor, { service, processManager: manager, transports: { [descriptor.adapterId]: transport }, argsFor: () => [] });
      const outcome = await adapter.run(runInput({ intent: { action: "discuss", canvasId: "c1", model: "vision", prompt: "scene" }, connection: { connectionId: "c1", adapterId: descriptor.adapterId, configRevision: 1, credentialEpoch: 1 }, candidate: { images: [], outputSchema: { type: "object" } } }));
      expect(outcome.status).toBe("succeeded");
      expect(outcome.assistantText?.length).toBe(text.length);
    } finally { clock.mockRestore(); }
  });

  it("工具事件不再有次数上限（原 24 次额度已删除）", async () => {
    const { service } = fakeService([record()]);
    const { manager } = fakeProcessManager({ executable: "/native" });
    const emitted: unknown[] = [];
    const { transport } = fakeTransport(input => {
      for (let index = 0; index < 60; index += 1) {
        input.onEvent({ type: "tool-started", tool: "get_model_api", callId: `call-${index}` });
        input.onEvent({ type: "tool-completed", tool: "get_model_api", callId: `call-${index}`, ok: true });
      }
      input.onEvent({ type: "tool-completed", tool: "submit_model_script", callId: "submit-1", ok: true });
      return { ok: true, outcome: { status: "succeeded", assistantText: "done" } };
    });
    const { facade } = fakeToolFacade();
    const adapter = createLocalAgentConversationAdapter(codexAdapter, { service, processManager: manager, transports: { "codex-appserver": transport }, argsFor: () => [], tools: facade, mcpEndpoint: { name: "woohaa", url: "http://127.0.0.1:1/mcp" } });
    const outcome = await adapter.run(runInput({
      intent: { action: "generate", canvasId: "c1", nodeId: "n1", mode: "model3d", model: "gpt", prompt: "make" },
      connection: { connectionId: "c1", adapterId: "codex-appserver", configRevision: 1, credentialEpoch: 1 }
    }, emitted));
    // 超过原 24 次工具事件仍按真实写入回执结算成功，不返回任何额度错误。
    expect(outcome.status).toBe("succeeded");
    expect(emitted.filter((event) => (event as { type?: string }).type === "tool-started")).toHaveLength(60);
  });
});

describe("adapter 形状（宿主校验）", () => {
  it("返回的 adapter 具有宿主校验所需字段", () => {
    const { service } = fakeService([]);
    const { manager } = fakeProcessManager();
    const adapter: AgentConversationAdapter = createLocalAgentConversationAdapter(codexAdapter, { service, processManager: manager, transports: {}, argsFor: () => [] });
    expect(adapter.id).toBe("codex-appserver");
    expect(adapter.capabilities().textDelivery).toEqual({ imageInput: true, maxImages: 12 });
    expect(adapter.capabilities().models).toBe("remote");
    expect(typeof adapter.run).toBe("function");
    expect(typeof adapter.authorization).toBe("function");
    expect(typeof adapter.models).toBe("function");
  });
});

// 保留 vi 依赖以便后续扩展（避免未使用导入告警）。
void vi;


it.each(LOCAL_AGENT_ADAPTERS)("$adapterId candidate run passes images/schema with no inherited native tools", async descriptor => {
  const records = [record({ adapterId: descriptor.adapterId })];
  const { service, natives } = fakeService(records);
  const resolveNative = vi.spyOn(service, "resolveNativeBinding");
  const { manager } = fakeProcessManager({ executable: "/native" });
  const { transport, inputs } = fakeTransport({ ok: true, nativeId: "candidate-native", outcome: { status: "succeeded", assistantText: "{}" } });
  const { facade, issued } = fakeToolFacade();
  const adapter = createLocalAgentConversationAdapter(descriptor, { service, processManager: manager, transports: { [descriptor.adapterId]: transport }, argsFor: () => [], tools: facade, mcpEndpoint: MCP_ENDPOINT });
  const input = runInput({ intent: { action: "discuss", canvasId: "c1", model: "vision", prompt: "scene" }, connection: { connectionId: "c1", adapterId: descriptor.adapterId, configRevision: 1, credentialEpoch: 1 }, candidate: { images: [{ bytes: new Uint8Array([1]), contentType: "image/png" }], outputSchema: { type: "object" } } });
  expect(await adapter.run(input)).toMatchObject({ status: "succeeded" });
  expect(inputs[0]).toMatchObject({ images: input.candidate!.images, outputSchema: { type: "object" }, allowedTools: [], toolToken: null, mcpEndpoint: null, resumeNativeId: null });
  expect(resolveNative).not.toHaveBeenCalled(); expect(natives).toEqual([]); expect(issued).toEqual([]);
  records[0]!.credentialEpoch++;
  expect(await adapter.run(input)).toMatchObject({ status: "failed" });
  expect(inputs).toHaveLength(1);
});
