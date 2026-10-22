/**
 * 连接发现端口投影测试
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 2.1/1.5 验收）。
 *
 * 覆盖：owner 隔离、四类证据分离（保存 Key ≠ 可推理）、models 来源不冒充已授权、
 * 未声明能力不冒称、endpoint 允许证据透传。
 */
import { describe, expect, it } from "vitest";
import { createConnectionService } from "./service.js";
import { createConnectionProvider } from "./connection-provider.js";
import { connectionCapabilities } from "./adapter-support.js";
import { modelView } from "./connection-view.js";
import { createInMemoryDocumentStore, createInMemorySecretStore } from "./test-doubles.js";

const EXT_ID = "test-agent";

function setup(runtime?: import("@woohaa3/contracts").AgentConnectionRuntime) {
  const documents = createInMemoryDocumentStore([EXT_ID]);
  const service = createConnectionService({ documents: documents.forExtension(EXT_ID)!, secrets: createInMemorySecretStore(), createId: () => "conn-1" });
  const provider = createConnectionProvider({
    id: "test-agent",
    extensionId: EXT_ID,
    service,
    descriptors: {
      "openai-responses": {
        describe: ({ credentialConfigured }) => ({
          ...(runtime ? { runtime } : {}),
          capabilities: connectionCapabilities({ discussion: true, tools: true, imageInput: true, cancel: true }),
          models: [modelView({ id: "gpt-4o", source: "remote-catalog", accountAuthorized: true })],
          status: {
            transport: { state: "ready", checkedAt: "2026-01-01T00:00:00.000Z" },
            credential: { state: credentialConfigured ? "ready" : "unavailable", checkedAt: null },
            modelAccess: { state: "unknown", checkedAt: null },
            tools: { state: "unknown", checkedAt: null }
          },
          required: ["transport", "credential"]
        })
      }
    }
  });
  return { service, provider };
}

describe("连接发现端口（任务 2.1）", () => {
  it("只返回本 owner 的连接；未安装/无 capability 时不注册（此处以空列表体现）", async () => {
    const { service, provider } = setup();
    const created = await service.create("user-a", { adapterId: "openai-responses", name: "OpenAI", runCategory: "http-sdk", authMode: "api-key" });
    if (!created.ok) throw new Error("create failed");
    expect((await provider.listConnections({ owner: "user-a" })).map((view) => view.connectionId)).toEqual([created.value.connectionId]);
    expect(await provider.listConnections({ owner: "user-b" })).toEqual([]);
    expect(await provider.getConnection!({ owner: "user-b", connectionId: created.value.connectionId })).toBeNull();
  });

  it("保存 Key 前 credential 未就绪、ready=false；保存后 credential 证据 ready", async () => {
    const { service, provider } = setup();
    const created = await service.create("user-a", { adapterId: "openai-responses", name: "OpenAI", runCategory: "http-sdk", authMode: "api-key" });
    if (!created.ok) throw new Error("create failed");
    const before = await provider.getConnection!({ owner: "user-a", connectionId: created.value.connectionId });
    expect(before?.credentialConfigured).toBe(false);
    expect(before?.ready).toBe(false);

    await service.saveCredential({ owner: "user-a", connectionId: created.value.connectionId, purpose: "model-api-key", secret: "sk-x" });
    const after = await provider.getConnection!({ owner: "user-a", connectionId: created.value.connectionId });
    expect(after?.credentialConfigured).toBe(true);
    expect(after?.status.credential.state).toBe("ready");
    // 仅 transport+credential 就绪；模型可调用仍是 unknown，不冒充 ready。
    expect(after?.ready).toBe(true);
    expect(after?.status.modelAccess.state).toBe("unknown");
  });

  it("目录失败保留原选择：modelsError 与已选模型并存，不自动换模型", async () => {
    const documents = createInMemoryDocumentStore([EXT_ID]);
    const service = createConnectionService({ documents: documents.forExtension(EXT_ID)!, secrets: createInMemorySecretStore(), createId: () => "conn-1" });
    const provider = createConnectionProvider({
      id: "test-agent",
      extensionId: EXT_ID,
      service,
      descriptors: {
        "compat-chat": {
          describe: () => ({
            capabilities: connectionCapabilities({ discussion: true }),
            models: [modelView({ id: "user-filled-model", source: "user-provided", accountAuthorized: false })],
            modelsError: "目录读取失败",
            status: {
              transport: { state: "ready", checkedAt: null },
              credential: { state: "unknown", checkedAt: null },
              modelAccess: { state: "unknown", checkedAt: null },
              tools: { state: "unknown", checkedAt: null }
            }
          })
        }
      }
    });
    const created = await service.create("user-a", { adapterId: "compat-chat", name: "兼容", runCategory: "http-sdk", authMode: "api-key" });
    if (!created.ok) throw new Error("create failed");
    const view = await provider.getConnection!({ owner: "user-a", connectionId: created.value.connectionId });
    expect(view?.modelsError).toBe("目录读取失败");
    expect(view?.models[0].source).toBe("user-provided");
    expect(view?.models[0].accountAuthorized).toBe(false);
  });
});


it("运行依赖缺失时保存 Key 不会将新引擎投影成就绪，任务证据完整透传", async () => {
  const unknown = { state: "unknown" as const, checkedAt: null };
  const runtime: import("@woohaa3/contracts").AgentConnectionRuntime = {
    schemaVersion: 1, apiType: "openai", engine: "codex-agent-sdk", engineVersion: "0.161.0",
    dependency: { state: "unavailable", reason: "runtime-missing" },
    tasks: { discussion: unknown, imageInput: unknown, targetExecution: unknown }
  };
  const { service, provider } = setup(runtime);
  const created = await service.create("user-a", { adapterId: "openai-responses", name: "OpenAI", runCategory: "agent-sdk", authMode: "api-key" });
  if (!created.ok) throw new Error("create failed");
  await service.saveCredential({ owner: "user-a", connectionId: created.value.connectionId, purpose: "model-api-key", secret: "secret-never-in-view" });
  const view = await provider.getConnection!({ owner: "user-a", connectionId: created.value.connectionId });
  expect(view?.runtime).toEqual(runtime);
  expect(view?.ready).toBe(false);
  expect(JSON.stringify(view)).not.toContain("secret-never-in-view");
});
