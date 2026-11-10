/**
 * Agent 连接契约测试（change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 1.1）。
 *
 * 覆盖：合法视图、未知字段、旧 ChatGPT 请求兼容、codec 拒绝非法 authMode/baseUrl、
 * 连接引用加入 entry intent、旧 entry intent 仍合法。
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_API_ENGINES,
  AGENT_CONNECTION_AUTH_MODES,
  AGENT_CONNECTION_RUN_CATEGORIES,
  agentConnectionProviderCapabilityId,
  agentConnectionProviderIdFromCapabilityId,
  connectionReady,
  isAgentConnectionCapabilities,
  isAgentConnectionProviderCapabilityId,
  isAgentConnectionProviderShape,
  isAgentConnectionStatus,
  isAgentConnectionView,
  isAgentConnectionModel,
  type AgentConnectionStatus,
  type AgentConnectionView
} from "./agent-connection.js";
import {
  decodeAgentConnectionConfigRequest,
  decodeAgentConnectionQuery,
  decodeCheckAgentConnectionRequest,
  decodeClearAgentCredentialRequest,
  decodeSaveAgentCredentialRequest,
  normalizeEndpointUrl
} from "./agent-connection-codec.js";
import { decodeAcceptTurnRequest, decodeCreateConversationRequest, isAgentCatalogSnapshot, isAgentEntryIntent } from "./conversation-codec.js";

const readyStatus: AgentConnectionStatus = {
  transport: { state: "ready", checkedAt: "2026-10-16T00:00:00.000Z" },
  credential: { state: "ready", checkedAt: "2026-10-16T00:00:00.000Z" },
  modelAccess: { state: "ready", checkedAt: "2026-10-16T00:00:00.000Z" },
  tools: { state: "ready", checkedAt: "2026-10-16T00:00:00.000Z" }
};

const view: AgentConnectionView = {
  connectionId: "conn-1",
  adapterId: "openai-responses",
  extensionId: "sdk-agent",
  name: "OpenAI",
  runCategory: "http-sdk",
  authMode: "api-key",
  configRevision: 1,
  credentialEpoch: 0,
  status: readyStatus,
  ready: true,
  capabilities: { discussion: true, imageInput: true, tools: true, structuredResult: true, cancel: true, resume: false },
  models: [{ id: "gpt-4.1", label: "gpt-4.1", source: "remote-catalog", accountAuthorized: true }],
  credentialConfigured: true
};

describe("Agent 连接视图契约", () => {
  it("接受合法连接视图", () => {
    expect(isAgentConnectionView(view)).toBe(true);
    expect(isAgentConnectionStatus(view.status)).toBe(true);
    expect(isAgentConnectionCapabilities(view.capabilities)).toBe(true);
  });

  it("拒绝缺少必填字段和非法枚举的连接视图", () => {
    expect(isAgentConnectionView({ ...view, connectionId: "" })).toBe(false);
    expect(isAgentConnectionView({ ...view, runCategory: "cloud" })).toBe(false);
    expect(isAgentConnectionView({ ...view, authMode: "password" })).toBe(false);
    expect(isAgentConnectionView({ ...view, models: [{ id: "x", label: "x", source: "guess", accountAuthorized: true }] })).toBe(false);
    expect(isAgentConnectionView({ ...view, status: { transport: { state: "ready" } } })).toBe(false);
  });

  it("枚举常量稳定", () => {
    expect([...AGENT_CONNECTION_RUN_CATEGORIES]).toEqual(["local-appserver", "http-sdk", "agent-sdk"]);
    expect([...AGENT_CONNECTION_AUTH_MODES]).toEqual(["oauth", "api-key", "local-login", "none"]);
  });

  it("connectionReady 只在所需证据全部 ready 时成立", () => {
    expect(connectionReady(readyStatus)).toBe(true);
    expect(connectionReady({ ...readyStatus, tools: { state: "unavailable" } })).toBe(false);
    expect(connectionReady({ ...readyStatus, tools: { state: "unknown" } }, ["transport", "credential"])).toBe(true);
  });
});

describe("连接发现 capability id", () => {
  it("往返一致且拒绝非本前缀", () => {
    const id = agentConnectionProviderCapabilityId("local-agent");
    expect(id).toBe("agent-connection-provider:local-agent");
    expect(isAgentConnectionProviderCapabilityId(id)).toBe(true);
    expect(agentConnectionProviderIdFromCapabilityId(id)).toBe("local-agent");
    expect(isAgentConnectionProviderCapabilityId("agent-conversation-adapter:chatgpt")).toBe(false);
  });

  it("拒绝半成品 provider 注册", () => {
    expect(isAgentConnectionProviderShape({ id: "x", listConnections: async () => [] })).toBe(true);
    expect(isAgentConnectionProviderShape({ id: "x" })).toBe(false);
    expect(isAgentConnectionProviderShape({ id: "x", listConnections: async () => [], getConnection: 3 })).toBe(false);
  });
});

describe("连接配置解码", () => {
  it("接受合法配置并规范化 baseUrl", () => {
    const result = decodeAgentConnectionConfigRequest({
      adapterId: "openai-compatible",
      name: "  我的兼容服务 ",
      runCategory: "http-sdk",
      authMode: "api-key",
      baseUrl: "https://gateway.example.com/v1",
      models: ["a", "a", "b"]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("我的兼容服务");
    expect(result.value.baseUrl).toBe("https://gateway.example.com/v1");
    expect(result.value.models).toEqual(["a", "b"]);
  });

  it("拒绝非法 authMode / runCategory / 带凭据或片段的 baseUrl", () => {
    const base = { adapterId: "x", name: "n", runCategory: "http-sdk", authMode: "api-key" };
    expect(decodeAgentConnectionConfigRequest({ ...base, authMode: "token" }).ok).toBe(false);
    expect(decodeAgentConnectionConfigRequest({ ...base, runCategory: "cloud" }).ok).toBe(false);
    expect(decodeAgentConnectionConfigRequest({ ...base, baseUrl: "https://user:pass@host/v1" }).ok).toBe(false);
    expect(decodeAgentConnectionConfigRequest({ ...base, baseUrl: "https://host/v1#frag" }).ok).toBe(false);
    expect(decodeAgentConnectionConfigRequest({ ...base, baseUrl: "ftp://host/v1" }).ok).toBe(false);
  });

  it("normalizeEndpointUrl 只接受无凭据 http(s)", () => {
    expect(normalizeEndpointUrl("https://a.example.com")).toBe("https://a.example.com/");
    expect(normalizeEndpointUrl("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/v1");
    expect(normalizeEndpointUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeEndpointUrl("https://u:p@h/")).toBeNull();
  });
});

describe("凭据与检查请求解码", () => {
  it("保存凭据要求非空 secret 与合法 purpose", () => {
    expect(decodeSaveAgentCredentialRequest({ connectionId: "c", purpose: "model-api-key", secret: "sk-x" }).ok).toBe(true);
    expect(decodeSaveAgentCredentialRequest({ connectionId: "c", purpose: "mcp-grant", secret: "tok" }).ok).toBe(true);
    expect(decodeSaveAgentCredentialRequest({ connectionId: "c", purpose: "oauth-token", secret: "x" }).ok).toBe(false);
    expect(decodeSaveAgentCredentialRequest({ connectionId: "c", purpose: "model-api-key", secret: "   " }).ok).toBe(false);
    expect(decodeSaveAgentCredentialRequest({ connectionId: "c", purpose: "model-api-key", secret: "x", expectedEpoch: -1 }).ok).toBe(false);
  });

  it("清除凭据要求连接与 purpose", () => {
    expect(decodeClearAgentCredentialRequest({ connectionId: "c", purpose: "model-api-key" }).ok).toBe(true);
    expect(decodeClearAgentCredentialRequest({ connectionId: "c" }).ok).toBe(false);
  });

  it("检查默认 probe；generation 必须显式模型", () => {
    const probe = decodeCheckAgentConnectionRequest({ connectionId: "c" });
    expect(probe.ok && probe.value.kind).toBe("probe");
    expect(decodeCheckAgentConnectionRequest({ connectionId: "c", kind: "generation" }).ok).toBe(false);
    const generation = decodeCheckAgentConnectionRequest({ connectionId: "c", kind: "generation", model: "gpt-4.1" });
    expect(generation.ok && generation.value.model).toBe("gpt-4.1");
  });

  it("查询缺省为空，非法值不传播", () => {
    expect(decodeAgentConnectionQuery(null)).toEqual({});
    expect(decodeAgentConnectionQuery("openai-responses")).toEqual({ adapterId: "openai-responses" });
    expect(decodeAgentConnectionQuery("a".repeat(300))).toEqual({});
  });
});

describe("回合连接引用与旧请求兼容", () => {
  it("entry intent 接受 connectionId 且旧 intent 仍合法", () => {
    const legacy = { action: "discuss", canvasId: "canvas-1", prompt: "你好" };
    expect(isAgentEntryIntent(legacy)).toBe(true);
    expect(isAgentEntryIntent({ ...legacy, connectionId: "conn-1" })).toBe(true);
    expect(isAgentEntryIntent({ ...legacy, connectionId: "" })).toBe(false);
  });

  it("接受回合解码保留 connectionId", () => {
    const decoded = decodeAcceptTurnRequest({
      requestId: "req-1",
      entry: { roleId: "test/role", action: "discuss", canvasId: "canvas-1", prompt: "hi", connectionId: "conn-1" }
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.entry.connectionId).toBe("conn-1");
  });

  it("创建会话请求兼容缺省 connectionId 并支持显式选择", () => {
    const legacy = decodeCreateConversationRequest({ canvasId: "canvas-1" });
    expect(legacy.ok).toBe(true);
    if (legacy.ok) expect(legacy.value.connectionId).toBeUndefined();
    const explicit = decodeCreateConversationRequest({ canvasId: "canvas-1", connectionId: "conn-2", adapterId: "openai-responses" });
    expect(explicit.ok && explicit.value.connectionId).toBe("conn-2");
    expect(decodeCreateConversationRequest({ canvasId: "canvas-1", connectionId: "" }).ok).toBe(false);
  });
});


describe("固定 API 引擎版本契约", () => {
  const evidence = { state: "unknown", checkedAt: null };
  const runtime = {
    schemaVersion: 1,
    apiType: "openai",
    engine: "codex-agent-sdk",
    engineVersion: "0.161.0",
    dependency: evidence,
    tasks: { discussion: evidence, imageInput: evidence, targetExecution: evidence }
  };

  it("旧连接仍可解码，新证据不改变旧连接身份", () => {
    expect(isAgentConnectionView(view)).toBe(true);
    expect(isAgentConnectionView({ ...view, runtime })).toBe(true);
  });

  it.each(Object.entries(AGENT_API_ENGINES))("%s 只接受固定引擎", (apiType, engine) => {
    expect(isAgentConnectionView({ ...view, runtime: { ...runtime, apiType, engine } })).toBe(true);
    expect(isAgentConnectionView({ ...view, runtime: { ...runtime, apiType, engine: "http" } })).toBe(false);
  });

  it("拒绝未来版本、空引擎版本及不完整任务证据", () => {
    for (const invalid of [
      { schemaVersion: 2 }, { engineVersion: " " }, { apiType: "toString" },
      { dependency: { state: "installed" } }, { tasks: { discussion: evidence } }
    ]) {
      expect(isAgentConnectionView({ ...view, runtime: { ...runtime, ...invalid } })).toBe(false);
    }
  });
});


it("回合解码保留思考强度并拒绝非法值，旧请求省略时仍兼容", () => {
  const entry = { roleId: "test/role", action: "generate", canvasId: "canvas", nodeId: "node", model: "model", prompt: "modify" };
  expect(decodeAcceptTurnRequest({ requestId: "r", entry: { ...entry, reasoningEffort: "high" } })).toMatchObject({ ok: true, value: { entry: { roleId: "test/role", reasoningEffort: "high" } } });
  expect(decodeAcceptTurnRequest({ requestId: "r", entry: { ...entry, reasoningEffort: "garbage" } })).toMatchObject({ ok: false });
  expect(isAgentEntryIntent({ ...entry, reasoningEffort: "garbage" })).toBe(false);
  const legacy = decodeAcceptTurnRequest({ requestId: "r", entry });
  expect(legacy.ok).toBe(true);
  if (legacy.ok) expect(legacy.value.entry).not.toHaveProperty("reasoningEffort");
});

it("模型目录拒绝非法思考强度，缺省字段仍兼容旧目录", () => {
  const model = { id: "m", label: "Model", source: "user-provided", accountAuthorized: false };
  for (const validate of [isAgentConnectionModel, (value: unknown) => isAgentCatalogSnapshot({ models: [value] })]) {
    expect(validate(model)).toBe(true);
    expect(validate({ ...model, reasoningEfforts: ["low", "high"] })).toBe(true);
    expect(validate({ ...model, reasoningEfforts: ["invalid"] })).toBe(false);
    expect(validate({ ...model, reasoningEfforts: "high" })).toBe(false);
  }
});
