import { describe, expect, it, vi } from "vitest";
import type { AgentAdapterRunInput } from "@woohaa3/contracts";
import type { ConnectionMetadataRecord, ConnectionService } from "@woohaa3/agent-connections";
import { findSdkAgentAdapter } from "../shared.js";
import { createSdkAgentConversationAdapter, sdkReasoningEfforts } from "./sdk-agent-connections.js";
import type { AgentSdkTransport } from "./adapters/agent-sdk-adapter.js";

function fixture(runtimeVersion: string | undefined = "codex-agent-sdk@0.161.0:1") {
  const record: ConnectionMetadataRecord = { owner: "owner", connectionId: "connection", adapterId: "openai-responses", name: "API", runCategory: "agent-sdk", authMode: "api-key", configRevision: 1, credentialEpoch: 1, createdAt: "now", updatedAt: "now", runtimeVersion, models: ["fixture"] };
  const service = { get: vi.fn(async (owner: string) => owner === "owner" ? record : null), readCredential: vi.fn(async () => ({ secret: "real-key-never-given-to-sdk" })), setRuntimeProbe: vi.fn(), setStatus: vi.fn(), resolveNativeBinding: vi.fn(async () => null), setNativeBinding: vi.fn() } as unknown as ConnectionService;
  const run = vi.fn<AgentSdkTransport["run"]>(async () => ({ ok: true, assistantText: "reply", toolCalls: [], finishReason: "stop" }));
  const create = (available = true, inFlight?: Set<Promise<unknown>>, allowedHosts = ["api.openai.com"]) => createSdkAgentConversationAdapter(findSdkAgentAdapter("openai-responses")!, { service, inFlight, allowedHosts, allowHttp: false, ...(available ? { transports: { "codex-agent-sdk": { run } } } : {}) });
  const input = (overrides: Partial<AgentAdapterRunInput> = {}): AgentAdapterRunInput => ({ owner: "owner", conversationId: "conversation", canvasId: "canvas", requestId: "request", turnId: "turn", connection: { connectionId: "connection", adapterId: "openai-responses", configRevision: 1, credentialEpoch: 1 }, history: [], intent: { action: "discuss", canvasId: "canvas", prompt: "reply", model: "fixture" }, signal: new AbortController().signal, emit: vi.fn(), ...overrides });
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
  it("目录明确不支持工具的模型只可讨论，目标请求不发送", async () => {
    const f = fixture();
    f.record.modelCapabilities = { fixture: { tools: false } };
    const input = f.input(); input.intent.action = "modify"; input.intent.nodeId = "node";
    expect(await f.create().run(input)).toMatchObject({ error: { code: "capability-unsupported" } });
    expect(f.run).not.toHaveBeenCalled();
    expect(await f.create().run(f.input())).toMatchObject({ status: "succeeded" });
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
  expect(await f.create().run(f.input({ candidate }))).toMatchObject({ status: "succeeded" });
  expect(f.run.mock.calls[0]![0]).toMatchObject({ images: candidate.images, outputSchema: candidate.outputSchema, mcp: null, restrictions: { allowedTools: [] } });
  expect(f.service.resolveNativeBinding).not.toHaveBeenCalled(); expect(f.service.setNativeBinding).not.toHaveBeenCalled();
  f.run.mockImplementation(async () => { f.record.configRevision++; return { ok: true, assistantText: "late", toolCalls: [], finishReason: "stop" }; });
  expect(await f.create().run(f.input({ candidate }))).toMatchObject({ status: "failed", error: { code: "version-conflict" } });
});
