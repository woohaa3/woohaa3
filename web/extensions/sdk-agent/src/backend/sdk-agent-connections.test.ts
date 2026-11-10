import { describe, expect, it, vi } from "vitest";
import type { AgentAdapterRunInput } from "@woohaa3/contracts";
import type { ConnectionMetadataRecord, ConnectionService } from "@woohaa3/agent-connections";
import { findSdkAgentAdapter } from "../shared.js";
import { capabilitiesFor, createSdkAgentConversationAdapter, sdkReasoningEfforts, unwrittenError } from "./sdk-agent-connections.js";
import type { AgentSdkTransport } from "./adapters/agent-sdk-adapter.js";
import { buildTestPreparedTurn, toolsForTestIntent } from "@woohaa3/test-fixtures-agent-role-turns";

function fixture(runtimeVersion: string | undefined = "codex-agent-sdk@0.161.0:1") {
  const record: ConnectionMetadataRecord = { owner: "owner", connectionId: "connection", adapterId: "openai-responses", name: "API", runCategory: "agent-sdk", authMode: "api-key", configRevision: 1, credentialEpoch: 1, createdAt: "now", updatedAt: "now", runtimeVersion, models: ["fixture"] };
  const service = { get: vi.fn(async (owner: string) => owner === "owner" ? record : null), readCredential: vi.fn(async () => ({ secret: "real-key-never-given-to-sdk" })), setRuntimeProbe: vi.fn(), setStatus: vi.fn(), resolveNativeBinding: vi.fn(async () => null), setNativeBinding: vi.fn() } as unknown as ConnectionService;
  const run = vi.fn<AgentSdkTransport["run"]>(async () => ({ ok: true, assistantText: "reply", toolCalls: [], finishReason: "stop" }));
  const create = (available = true, inFlight?: Set<Promise<unknown>>, allowedHosts = ["api.openai.com"]) => createSdkAgentConversationAdapter(findSdkAgentAdapter("openai-responses")!, { service, inFlight, allowedHosts, allowHttp: false, ...(available ? { transports: { "codex-agent-sdk": { run } } } : {}) });
  const input = (overrides: Partial<AgentAdapterRunInput> = {}): AgentAdapterRunInput => {
    const intent = overrides.intent ?? { action: "discuss" as const, canvasId: "canvas", prompt: "reply", model: "fixture" };
    return {
      owner: "owner",
      conversationId: "conversation",
      canvasId: "canvas",
      requestId: "request",
      turnId: "turn",
      connection: { connectionId: "connection", adapterId: "openai-responses", configRevision: 1, credentialEpoch: 1 },
      history: [],
      intent,
      prepared: buildTestPreparedTurn({
        requestId: overrides.requestId ?? "request",
        target: { canvasId: intent.canvasId, ...(intent.nodeId ? { nodeId: intent.nodeId } : {}), ...(intent.mode ? { mode: intent.mode } : {}) },
        prompt: intent.prompt,
        tools: toolsForTestIntent(intent),
        output: overrides.candidate ? { kind: "candidate", schema: overrides.candidate.outputSchema } : { kind: "tool-receipts" }
      }),
      signal: new AbortController().signal,
      emit: vi.fn(),
      ...overrides
    };
  };
  return { record, service, run, create, input };
}

describe("固定 SDK 连接执行前门禁", () => {
  it("宿主图片在 SDK 执行期间可读取，执行后删除，讨论不取得工具", async () => {
    const f = fixture();
    const bytes = new Uint8Array([1, 2, 3]);
    f.run.mockImplementation(async input => {
      expect(input.images).toHaveLength(1);
      expect(Buffer.from(input.images![0]!.bytes)).toEqual(Buffer.from(bytes));
      expect(input.mcp).toBeNull();
      expect(input.restrictions.allowedTools).toEqual([]);
      return { ok: true, assistantText: "candidate", toolCalls: [], finishReason: "stop" };
    });
    const outcome = await f.create().run(f.input({ intent: { action: "discuss", canvasId: "canvas", prompt: "reply", model: "fixture" }, candidate: { images: [{ bytes, contentType: "image/png" }], outputSchema: {} } }));
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "succeeded" });
  });
  it("讨论只给 SDK 短期本地 Key，无目标工具；查询不重新运行", async () => {
    const f = fixture();
    const adapter = f.create();
    expect(await adapter.run(f.input())).toMatchObject({ status: "succeeded", assistantText: "reply" });
    expect(f.run).toHaveBeenCalledOnce();
    const request = f.run.mock.calls[0]![0];
    expect(request.apiKey).not.toBe("real-key-never-given-to-sdk");
    expect(request.modelBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(request.mcp).toBeNull();
    expect(request.restrictions.allowedTools).toEqual([]);
    expect(await adapter.query?.({ owner: "owner", requestId: "request" })).toMatchObject({ status: "succeeded" });
    expect(f.run).toHaveBeenCalledOnce();
  });
  it("停用排空包含转发入口清理，不在 SDK 返回前释放运行记录", async () => {
    const f = fixture();
    const inFlight = new Set<Promise<unknown>>();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    f.run.mockImplementation(async (input) => {
      started();
      return await new Promise((resolve) => input.signal.addEventListener("abort", () => resolve({ ok: false, code: "cancelled", message: "stopped" }), { once: true }));
    });
    const controller = new AbortController();
    const pending = f.create(true, inFlight).run(f.input({ signal: controller.signal }));
    await ready;
    expect(inFlight.size).toBe(1);
    const baseUrl = f.run.mock.calls[0]![0].modelBaseUrl!;
    controller.abort();
    await Promise.allSettled([...inFlight]);
    expect(await pending).toMatchObject({ status: "cancelled" });
    expect(inFlight.size).toBe(0);
    await expect(fetch(baseUrl + "/models")).rejects.toThrow();
  });
  it("缺运行依赖不调用模型，不回退 HTTP", async () => {
    const f = fixture();
    expect(await f.create(false).run(f.input())).toMatchObject({ status: "failed", error: { code: "runtime-missing" } });
    expect(f.run).not.toHaveBeenCalled();
  });
  it("旧执行版本不能通过维护生成绕过迁移屏障", async () => {
    const f = fixture("old-http");
    expect(await f.create().run(f.input())).toMatchObject({ status: "failed", error: { code: "migration-required" } });
    expect(f.run).not.toHaveBeenCalled();
  });
  it("不符合部署策略的自定义地址在启动 SDK 前拒绝，原值保持", async () => {
    const f = fixture(); f.record.baseUrl = "https://legacy.example/v1";
    const before = structuredClone(f.record);
    expect(await f.create().run(f.input())).toMatchObject({ error: { code: "endpoint-not-allowed" } });
    expect(f.record).toEqual(before);
    expect(f.run).not.toHaveBeenCalled();
  });
  it("Responses 协议接受策略允许的自定义地址，SDK 仍通过连接专属转发器", async () => {
    const f = fixture(); f.record.baseUrl = "https://gateway.example/proxy/v1";
    expect(await f.create(true, undefined, ["gateway.example"]).run(f.input())).toMatchObject({ status: "succeeded" });
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.run.mock.calls[0]![0].modelBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(f.record.baseUrl).toBe("https://gateway.example/proxy/v1");
  });
  it("跨 owner、旧代次与不支持图片在发送模型前拒绝", async () => {
    const f = fixture();
    const adapter = f.create();
    expect((await adapter.run(f.input({ owner: "other" }))).status).toBe("failed");
    f.record.credentialEpoch = 2;
    expect(await adapter.run(f.input())).toMatchObject({ error: { code: "version-conflict" } });
    f.record.credentialEpoch = 1;
    const input = f.input();
    input.intent.references = [{ kind: "asset", storageKey: "asset" }];
    expect((await adapter.run(input)).status).toBe("failed");
    expect(f.run).not.toHaveBeenCalled();
  });
});


it("选择的思考强度传入 SDK，未开放的模型在启动前拒绝", async () => {
  const f = fixture();
  const input = f.input();
  input.intent = { ...input.intent, model: "gpt-6.1-sol", reasoningEffort: "high" };
  expect(await f.create().run(input)).toMatchObject({ status: "succeeded" });
  expect(f.run.mock.calls[0]![0].reasoningEffort).toBe("high");
  f.run.mockClear();
  expect(await f.create().run({ ...input, requestId: "other", intent: { ...input.intent, model: "fixture" } })).toMatchObject({ status: "failed", error: { code: "capability-unsupported" } });
  expect(f.run).not.toHaveBeenCalled();
  expect(sdkReasoningEfforts("compat-chat", "unknown")).toEqual([]);
  expect(sdkReasoningEfforts("gemini-agent-adk", "gemini-3-pro-preview")).toEqual(["low", "high"]);
});


it("candidate run uses native images and no history binding/grant, rejects a stale completion", async () => {
  const f = fixture();
  const candidate = { images: [{ bytes: new Uint8Array([1]), contentType: "image/png" }], outputSchema: { type: "object" } };
  expect(f.create().capabilities().textDelivery).toEqual({ imageInput: true, maxImages: 12 });
  expect(await f.create().run(f.input({ candidate }))).toMatchObject({ status: "succeeded" });
  expect(f.run.mock.calls[0]![0]).toMatchObject({ images: candidate.images, outputSchema: candidate.outputSchema, mcp: null, restrictions: { allowedTools: [] } });
  expect(f.service.resolveNativeBinding).not.toHaveBeenCalled(); expect(f.service.setNativeBinding).not.toHaveBeenCalled();
  f.run.mockImplementation(async () => { f.record.configRevision++; return { ok: true, assistantText: "late", toolCalls: [], finishReason: "stop" }; });
  expect(await f.create().run(f.input({ candidate }))).toMatchObject({ status: "failed", error: { code: "version-conflict" } });
});

it("cancels the matching candidate and reports an unknown execution after restart", async () => {
  const f = fixture();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  f.run.mockImplementation(input => new Promise(resolve => { started(); input.signal.addEventListener("abort", () => resolve({ ok: false, code: "cancelled", message: "stopped" }), { once: true }); }));
  const adapter = f.create();
  const input = f.input({ candidate: { images: [{ bytes: new Uint8Array([1]), contentType: "image/png" }], outputSchema: {} } });
  const running = adapter.run(input);
  await ready;
  const cancel = { owner: input.owner, requestId: input.requestId, candidateContext: { canvasId: input.canvasId, conversationId: input.conversationId, connection: input.connection!, intent: input.intent } };
  await adapter.cancel!(cancel);
  expect((await running).status).not.toBe("succeeded");
  await expect(f.create().cancel!(cancel)).rejects.toThrow("无法确认");
});

it.each(["outside-scope", "spatial-rejected", "write-forbidden", "version-conflict", "lease-conflict", "not-ready"])("目标授权失败保留 %s，脱敏且不启动模型", async (code) => {
  const f = fixture();
  const adapter = createSdkAgentConversationAdapter(findSdkAgentAdapter("openai-responses")!, {
    service: f.service, allowHttp: false, allowedHosts: ["api.openai.com"],
    transports: { "codex-agent-sdk": { run: f.run } }, mcpServerUrl: "http://127.0.0.1:1/mcp",
    tools: { issue: async () => { throw Object.assign(new Error("对象 model-a 超出范围，请调整导演区 real-key-never-given-to-sdk https://private.invalid/path token=secret"), { code }); }, revoke: vi.fn() }
  });
  const outcome = await adapter.run(f.input({ intent: { action: "modify", mode: "world", canvasId: "canvas", nodeId: "area", worldScope: { kind: "scene-area", areaId: "area" }, prompt: "修改", model: "fixture" } }));
  expect(outcome).toMatchObject({ status: "failed", error: { code, message: expect.stringContaining("对象 model-a 超出范围") } });
  expect(JSON.stringify(outcome)).not.toMatch(/real-key-never-given-to-sdk|private.invalid|token=secret/);
  expect(f.run).not.toHaveBeenCalled();
});

describe("没有写入时按真实结束原因归因", () => {
  it("输出额度写满报 output-truncated，而不是未确认写入", () => {
    expect(unwrittenError("length")).toEqual({ code: "output-truncated", message: expect.stringContaining("长度上限") });
    expect(unwrittenError("content_filter")).toMatchObject({ code: "content-filtered" });
  });

  it("正常结束或未知原因仍交给未确认写入兜底", () => {
    expect(unwrittenError("stop")).toBeUndefined();
    expect(unwrittenError("tool_calls")).toBeUndefined();
    expect(unwrittenError("unknown")).toBeUndefined();
  });
});

it("compat-chat 不宣称可恢复 native session", () => {
  expect(capabilitiesFor(findSdkAgentAdapter("compat-chat")!)).toMatchObject({ resume: false });
  expect(capabilitiesFor(findSdkAgentAdapter("openai-responses")!)).toMatchObject({ resume: true });
});
