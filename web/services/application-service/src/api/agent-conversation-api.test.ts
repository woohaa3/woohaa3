/**
 * 宿主 Agent 会话 HTTP API 测试：MCP 真实发现与外部指引
 * （change: 2026-10-12-add-agent-conversation-panel，任务 3.1/3.6 / design D4）。
 *
 * 覆盖 `GET /api/agent-conversations/mcp`：
 * - ready 只来自注入的真实发现，不伪造；
 * - 未配置发现时返回 not-configured；
 * - 外部连接指引是当前 origin 的 Streamable HTTP 绝对 URL；
 * - 复制地址不表示外部客户端已连接（响应无任何在线标记）。
 */
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConnectionView, AgentMcpStatusResponse, McpBuiltinDiscoveryView } from "@woohaa3/contracts";
import { createAgentConversationApiHandler } from "./agent-conversation-api.js";
import type { ApplicationRequestAuthenticator } from "../auth/adapter.js";
import type { AgentConversationService } from "../extensions/agent-conversation-service.js";
import type { AgentConnectionRegistry } from "../extensions/agent-connection-registry.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** 最小 service 桩：本测试只触达 `/mcp` 分支，其余方法不会被调用。 */
function serviceStub(): AgentConversationService {
  const notImplemented = () => {
    throw new Error("not-implemented");
  };
  return {
    createConversation: notImplemented,
    listConversations: notImplemented,
    readConversation: notImplemented,
    acceptTurn: notImplemented,
    dispatchTurn: notImplemented,
    whenSettled: notImplemented,
    queryTurn: notImplemented,
    cancelTurn: notImplemented,
    linkRun: notImplemented,
    locateTurnByRun: notImplemented,
    catalog: notImplemented,
    reconcileUnknown: notImplemented,
    deleteAll: notImplemented
  } as unknown as AgentConversationService;
}

async function boot(options: {
  serviceConnections?: import("../service-connections/registry.js").ServiceConnectionRegistry;
  serviceConnectionProviders?: () => import("@woohaa3/contracts").GenerationProvider[];
  discovery?: () => Promise<McpBuiltinDiscoveryView>;
  service?: AgentConversationService;
  canvasAccess?: boolean;
  basePath?: string;
  authenticator?: ApplicationRequestAuthenticator;
  connections?: AgentConnectionRegistry;
  canvasCreations?: import("../extensions/canvas-creation-service.js").CanvasCreationService;
  access?: import("@woohaa3/contracts").ApplicationExtensionCanvasAccessFacade;
} = {}) {
  const handler = createAgentConversationApiHandler({
    service: options.service ?? serviceStub(),
    serviceConnections: options.serviceConnections,
    serviceConnectionProviders: options.serviceConnectionProviders,
    canvasCreations: options.canvasCreations,
    ...(options.basePath ? { basePath: options.basePath } : {}),
    ...(options.discovery ? { mcpDiscovery: options.discovery } : {}),
    ...(options.connections ? { connections: options.connections } : {}),
    ...(options.canvasAccess === false
      ? {}
      : { canvasAccess: options.access ?? { authorize: async () => ({ ok: true as const }) } }),
    // 本地开发会话：注入固定可信 principal（生产由认证适配器提供）。
    authenticator: options.authenticator ?? (async () => ({ subject: "user-a", sessionId: "s1", identityProvider: "test" }))
  });
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { base: `http://127.0.0.1:${port}` };
}

const READY: McpBuiltinDiscoveryView = {
  ready: true,
  status: "ready",
  serverName: "woohaa3-model-canvas",
  tools: [
    { name: "get_model_node", access: "read" },
    { name: "submit_model_script", access: "write" }
  ],
  checkedAt: "2026-10-13T00:00:00.000Z"
};

describe("canvas creation API authority", () => {
  const input = { requestId: "request", canvasId: "canvas", position: { x: 1, y: 2 }, prompt: "create", connection: { connectionId: "connection", adapterId: "adapter", configRevision: 1, credentialEpoch: 1 } };
  function creations() {
    const view = { ...input, rootGroupId: "root", stage: "accepted", turnRequestId: "first" };
    return { accept: vi.fn(async () => view), peek: vi.fn((owner: string) => owner === "user-a" ? view : null), query: vi.fn(async () => view), retry: vi.fn(async () => view), list: vi.fn(async () => [view]) };
  }
  it("uses the trusted principal and original request for reads and explicit retries", async () => {
    const s = creations();
    const access = { authorize: vi.fn(async () => ({ ok: true as const })) };
    const { base } = await boot({ basePath: "/studio/", canvasCreations: s as never, access });
    const post = await fetch(`${base}/api/agent-conversations/canvas-creations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    expect(post.status).toBe(200); expect(s.accept).toHaveBeenCalledWith("user-a", input);
    expect((await fetch(`${base}/api/agent-conversations/canvas-creations/request`)).status).toBe(200);
    expect(s.query).toHaveBeenCalledWith("user-a", "request");
    expect((await fetch(`${base}/api/agent-conversations/canvas-creations/request/retry`, { method: "POST" })).status).toBe(200);
    expect(s.retry).toHaveBeenCalledWith("user-a", "request");
    expect(access.authorize).toHaveBeenCalledWith({ subject: "user-a", canvasId: "canvas", permission: "write" });
    expect(s.accept).toHaveBeenCalledTimes(1);
  });
  it("rejects unauthenticated, read-only, cross-owner and forged scope input before effects", async () => {
    const s = creations();
    const anonymous = await boot({ canvasCreations: s as never, authenticator: async () => null });
    expect((await fetch(`${anonymous.base}/api/agent-conversations/canvas-creations/request`)).status).toBe(401);
    const denied = await boot({ canvasCreations: s as never, access: { authorize: async () => ({ ok: false, code: "forbidden", message: "read only" }) } as never });
    expect((await fetch(`${denied.base}/api/agent-conversations/canvas-creations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })).status).toBe(401);
    const other = await boot({ canvasCreations: s as never, authenticator: async () => ({ subject: "other", sessionId: "s", identityProvider: "test" }) });
    expect((await fetch(`${other.base}/api/agent-conversations/canvas-creations/request`)).status).toBe(404);
    const own = await boot({ canvasCreations: s as never });
    expect((await fetch(`${own.base}/api/agent-conversations/canvas-creations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, owner: "other", scope: { rootGroupId: "anything" } }) })).status).toBe(400);
    expect(s.accept).not.toHaveBeenCalled(); expect(s.query).not.toHaveBeenCalled();
  });
});

describe("Agent 会话 API · MCP 真实发现", () => {
  it("返回注入的真实发现与当前 origin 的外部指引", async () => {
    const { base } = await boot({ discovery: async () => READY });
    const response = await fetch(`${base}/api/agent-conversations/mcp`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as AgentMcpStatusResponse;
    expect(body.builtin).toEqual(READY);
    expect(body.external.transport).toBe("streamable-http");
    const url = new URL(body.external.serverUrl);
    expect(url.pathname).toBe("/mcp/model-canvas");
    expect(body.external.serverUrl.startsWith(base)).toBe(true);
  });

  it("外部指引跟随可信 forwarded Host/Proto（不伪造 https）", async () => {
    const { base } = await boot({ discovery: async () => READY });
    const response = await fetch(`${base}/api/agent-conversations/mcp`, {
      headers: { "x-forwarded-host": "canvas.example.com", "x-forwarded-proto": "https" }
    });
    const body = (await response.json()) as AgentMcpStatusResponse;
    expect(body.external.serverUrl).toBe("https://canvas.example.com/mcp/model-canvas");
  });

  it("子挂载下外部指引 URL 带公开前缀（内部直连不变）", async () => {
    const { base } = await boot({ discovery: async () => READY, basePath: "/canvas/" });
    const response = await fetch(`${base}/api/agent-conversations/mcp`);
    const body = (await response.json()) as AgentMcpStatusResponse;
    expect(body.external.serverUrl).toBe(`${base}/canvas/mcp/model-canvas`);
  });

  it("未配置发现时返回 not-configured，不伪造 ready", async () => {
    const { base } = await boot();
    const response = await fetch(`${base}/api/agent-conversations/mcp`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as AgentMcpStatusResponse;
    expect(body.builtin.ready).toBe(false);
    expect(body.builtin.status).toBe("not-configured");
    expect(body.builtin.tools).toEqual([]);
  });

  it("不可达/缺工具的真实发现原样透出原因，无外部在线标记", async () => {
    const { base } = await boot({
      discovery: async () => ({ ready: false, status: "unreachable", tools: [], reason: "连接被拒绝", checkedAt: "2026-10-13T00:00:00.000Z" })
    });
    const response = await fetch(`${base}/api/agent-conversations/mcp`);
    const body = (await response.json()) as AgentMcpStatusResponse;
    expect(body.builtin).toMatchObject({ ready: false, status: "unreachable", reason: "连接被拒绝" });
    // 外部对象只有地址与传输，不含“在线/已连接”字段。
    expect(Object.keys(body.external).sort()).toEqual(["serverUrl", "transport"]);
  });

  it("未认证时拒绝读取（不泄漏发现结果）", async () => {
    const handler = createAgentConversationApiHandler({
      service: serviceStub(),
        mcpDiscovery: async () => READY
    });
    const server = http.createServer((req, res) => {
      void handler(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/agent-conversations/mcp`);
    expect(response.status).toBe(401);
  });
});

describe("Agent 会话 API · 共用可信身份", () => {
  it("每个请求仅解析一次身份，不另建插件本地会话", async () => {
    let calls = 0;
    const { base } = await boot({
      authenticator: async () => {
        calls += 1;
        return { subject: "user:abc", sessionId: "session:abc", identityProvider: "test-identity" };
      }
    });
    const response = await fetch(`${base}/api/agent-conversations/mcp`);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    // 每个请求只解析一次身份：两次解析会在首次无 cookie 时签发两个不同会话。
    expect(calls).toBe(1);
  });

  it("身份提供者故障返回 503，不回退本地用户", async () => {
    const { base } = await boot({ authenticator: async () => { throw new Error("provider failed"); } });
    const response = await fetch(`${base}/api/agent-conversations/mcp`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "access-provider-unavailable" });
  });

  it("身份端口不返回身份时仍拒绝（不伪造 owner）", async () => {
    const { base } = await boot({ authenticator: async () => null });
    const response = await fetch(`${base}/api/agent-conversations/mcp`);
    expect(response.status).toBe(401);
  });
});

describe("Agent 会话 API · 按领域运行定位", () => {
  /** 只实现链接/定位的桩：记录调用并按 runId 返回既定回合。 */
  function locateService(): { service: AgentConversationService; calls: Array<{ requestId?: string; runId?: string }> } {
    const calls: Array<{ requestId?: string; runId?: string }> = [];
    const turn = { turnId: "turn-1", conversationId: "conv-1", requestId: "req-old", status: "succeeded", runId: "run-old" } as never;
    const service = {
      ...serviceStub(),
      linkRun: (input: { requestId: string; runId?: string; taskId?: string }) => {
        calls.push({ requestId: input.requestId, runId: input.runId });
        return { ok: true as const, turn: { ...(turn as object), runId: input.runId } as never };
      },
      locateTurnByRun: (input: { owner: string; runId: string }) => {
        calls.push({ runId: input.runId });
        if (input.runId !== "run-old") return { ok: false as const, error: { code: "not-found" as const, message: "未找到" } };
        return { ok: true as const, conversation: { conversationId: "conv-1", canvasId: "canvas-1" } as never, turn, snapshot: { conversation: { canvasId: "canvas-1" } } as never };
      }
    } as unknown as AgentConversationService;
    return { service, calls };
  }

  it("GET /locate?runId= 按确切运行定位回合", async () => {
    const { service, calls } = locateService();
    const { base } = await boot({ service });
    const response = await fetch(`${base}/api/agent-conversations/locate?runId=run-old`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { turn: { requestId: string } };
    expect(body.turn.requestId).toBe("req-old");
    expect(calls).toEqual([{ runId: "run-old" }]);
  });

  it("GET /locate 未关联返回 404（调用方保留原任务详情）", async () => {
    const { service } = locateService();
    const { base } = await boot({ service });
    const response = await fetch(`${base}/api/agent-conversations/locate?runId=run-plain`);
    expect(response.status).toBe(404);
  });

  it("GET /locate 缺 runId 返回 400，不跳到最近会话", async () => {
    const { service } = locateService();
    const { base } = await boot({ service });
    const response = await fetch(`${base}/api/agent-conversations/locate`);
    expect(response.status).toBe(400);
  });

  it("POST /turns/:requestId/link 显式记录领域 run/task", async () => {
    const { service, calls } = locateService();
    const { base } = await boot({ service });
    const response = await fetch(`${base}/api/agent-conversations/turns/req-old/link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run-old", taskId: "task-old" })
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ requestId: "req-old", runId: "run-old" }]);
  });

  it("POST /turns/:requestId/link 缺 runId/taskId 返回 400", async () => {
    const { service } = locateService();
    const { base } = await boot({ service });
    const response = await fetch(`${base}/api/agent-conversations/turns/req-old/link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(response.status).toBe(400);
  });
});

describe("Agent 会话 API · 节点会话复用与清空上下文（design D8）", () => {
  function targetService(): {
    service: AgentConversationService;
    found: Array<{ owner: string; canvasId: string; nodeId: string }>;
    cleared: Array<{ owner: string; canvasId: string; nodeId: string }>;
  } {
    const found: Array<{ owner: string; canvasId: string; nodeId: string }> = [];
    const cleared: Array<{ owner: string; canvasId: string; nodeId: string }> = [];
    const service = {
      ...serviceStub(),
      findConversationForTarget: (input: { owner: string; canvasId: string; nodeId: string }) => {
        found.push(input);
        return { ok: true as const, conversation: input.nodeId === "node-1" ? { conversationId: "conv-1", canvasId: "cv" } : null } as never;
      },
      clearContext: (input: { owner: string; canvasId: string; nodeId: string }) => {
        cleared.push(input);
        return { ok: true as const, cleared: 1 };
      }
    } as unknown as AgentConversationService;
    return { service, found, cleared };
  }

  it("GET /target 按节点返回当前会话；未绑定时返回 null", async () => {
    const { service, found } = targetService();
    const { base } = await boot({ service });
    const hit = await fetch(`${base}/api/agent-conversations/target?canvasId=cv&nodeId=node-1`);
    expect(hit.status).toBe(200);
    expect((await hit.json()).conversation.conversationId).toBe("conv-1");
    const miss = await fetch(`${base}/api/agent-conversations/target?canvasId=cv&nodeId=node-2`);
    expect(miss.status).toBe(200);
    expect((await miss.json()).conversation).toBeNull();
    expect(found[0]).toEqual({ owner: "user-a", canvasId: "cv", nodeId: "node-1" });
  });

  it("GET /target 缺 canvasId/nodeId 返回 400", async () => {
    const { service } = targetService();
    const { base } = await boot({ service });
    const response = await fetch(`${base}/api/agent-conversations/target?canvasId=cv`);
    expect(response.status).toBe(400);
  });

  it("POST /context/clear 解除关联并返回数量；缺字段返回 400", async () => {
    const { service, cleared } = targetService();
    const { base } = await boot({ service });
    const response = await fetch(`${base}/api/agent-conversations/context/clear`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canvasId: "cv", nodeId: "node-1" })
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, cleared: 1 });
    expect(cleared[0]).toEqual({ owner: "user-a", canvasId: "cv", nodeId: "node-1" });

    const bad = await fetch(`${base}/api/agent-conversations/context/clear`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canvasId: "cv" })
    });
    expect(bad.status).toBe(400);
  });

  it("POST /conversations 透传 nodeId 以绑定目标节点", async () => {
    const created: Array<{ nodeId?: string }> = [];
    const service = {
      ...serviceStub(),
      createConversation: (input: { owner: string; canvasId: string; nodeId?: string }) => {
        created.push({ nodeId: input.nodeId });
        return { ok: true as const, conversation: { conversationId: "conv-1", canvasId: "cv" } } as never;
      }
    } as unknown as AgentConversationService;
    const { base } = await boot({ service });
    const response = await fetch(`${base}/api/agent-conversations/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canvasId: "cv", nodeId: "node-1" })
    });
    expect(response.status).toBe(200);
    expect(created).toEqual([{ nodeId: "node-1" }]);
  });
});

describe("Agent 会话 API · 来源连接发现与切换（change 2026-10-16，任务 2.1/2.3）", () => {
  function connectionStub(connections: AgentConnectionView[]): AgentConnectionRegistry {
    return {
      list: () => [],
      resolve: () => ({ ok: false as const, code: "adapter-unavailable" as const, message: "stub" }),
      listConnections: async () => connections,
      getConnection: async ({ connectionId }) => connections.find((entry) => entry.connectionId === connectionId) ?? null
    };
  }

  it("GET /connections 返回该 owner 的公开连接（不含秘密）", async () => {
    const view = {
      connectionId: "c1",
      adapterId: "openai-responses",
      extensionId: "sdk-agent",
      name: "OpenAI",
      runCategory: "http-sdk" as const,
      authMode: "api-key" as const,
      configRevision: 1,
      credentialEpoch: 0,
      status: {
        transport: { state: "ready" as const },
        credential: { state: "ready" as const },
        modelAccess: { state: "ready" as const },
        tools: { state: "ready" as const }
      },
      ready: true,
      capabilities: { discussion: true, imageInput: true, tools: true, structuredResult: true, cancel: true, resume: false },
      models: [],
      credentialConfigured: true
    };
    const { base } = await boot({ connections: connectionStub([view]) });
    const response = await fetch(`${base}/api/agent-conversations/connections?adapterId=openai-responses`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { connections: AgentConnectionView[] };
    expect(body.connections).toHaveLength(1);
    // 只暴露非秘密视图：无任何 secret/key/token 字段。
    expect(JSON.stringify(body)).not.toMatch(/secret|token|apiKey/i);
  });

  it("未配置连接注册表时 GET /connections 返回空数组", async () => {
    const { base } = await boot();
    const response = await fetch(`${base}/api/agent-conversations/connections`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connections: [] });
  });

  it("POST /context/switch 透传连接并返回清除数量", async () => {
    const switched: Array<{ canvasId: string; nodeId: string; connectionId: string }> = [];
    const service = {
      ...serviceStub(),
      switchConnection: async (input: { canvasId: string; nodeId: string; connectionId: string }) => {
        switched.push(input);
        return { ok: true as const, cleared: 1 };
      }
    } as unknown as AgentConversationService;
    const { base } = await boot({ service });
    const response = await fetch(`${base}/api/agent-conversations/context/switch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canvasId: "cv", nodeId: "node-1", connectionId: "c2" })
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, cleared: 1 });
    expect(switched[0]).toEqual({ owner: "user-a", canvasId: "cv", nodeId: "node-1", connectionId: "c2" });
  });

  it("POST /context/switch 缺 connectionId 返回 400", async () => {
    const { base } = await boot({ service: serviceStub() });
    const response = await fetch(`${base}/api/agent-conversations/context/switch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canvasId: "cv", nodeId: "node-1" })
    });
    expect(response.status).toBe(400);
  });

  it("本次连接升级归档目标时建立新会话，已归档历史不自动绑定", async () => {
    let archived = false;
    const accepted: string[] = [];
    const created: unknown[] = [];
    const service = {
      ...serviceStub(),
      readConversation: () => ({ ok: true, snapshot: { conversation: { conversationId: "old", canvasId: "cv", adapterId: "fake", nodeId: archived ? null : "node" } } }),
      resolveConnectionBinding: async () => { archived = true; return { ok: true, binding: { connectionId: "c1", adapterId: "fake", configRevision: 2, credentialEpoch: 1 } }; },
      createConversation: (input: unknown) => { created.push(input); return { ok: true, conversation: { conversationId: "fresh" } }; },
      acceptTurn: (input: { conversationId: string }) => { accepted.push(input.conversationId); return { ok: true, conversation: { conversationId: input.conversationId }, turn: { turnId: "t1" }, reused: true }; }
    } as unknown as AgentConversationService;
    const { base } = await boot({ service });
    const submit = () => fetch(`${base}/api/agent-conversations/conversations/old/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "req", entry: { action: "modify", canvasId: "cv", nodeId: "node", prompt: "修改", connectionId: "c1" } }) });
    expect((await submit()).status).toBe(200);
    expect(created).toEqual([{ owner: "user-a", canvasId: "cv", adapterId: "fake", nodeId: "node", connectionId: "c1" }]);
    expect(accepted).toEqual(["fresh"]);
    await submit();
    expect(created).toHaveLength(1);
    expect(accepted).toEqual(["fresh", "old"]);
  });

  it("接受回合时解析连接并把绑定传给服务；连接不可用返回 409", async () => {
    const calls: Array<{ connection?: unknown }> = [];
    let connectionResult: unknown = { ok: true as const, binding: { connectionId: "c1", adapterId: "fake", configRevision: 1, credentialEpoch: 0 } };
    const service = {
      ...serviceStub(),
      readConversation: () => ({ ok: true as const, snapshot: { conversation: { conversationId: "conv-1", canvasId: "cv", adapterId: "fake" } } }),
      resolveConnectionBinding: async () => connectionResult,
      acceptTurn: (input: { connection?: unknown }) => {
        calls.push({ connection: input.connection });
        return { ok: true as const, conversation: { conversationId: "conv-1", canvasId: "cv" }, turn: { turnId: "t1" }, reused: true };
      }
    } as unknown as AgentConversationService;
    const { base } = await boot({ service });
    const okResponse = await fetch(`${base}/api/agent-conversations/conversations/conv-1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "req-1", entry: { action: "discuss", canvasId: "cv", prompt: "hi" } })
    });
    expect(okResponse.status).toBe(200);
    expect(calls[0]?.connection).toEqual({ connectionId: "c1", adapterId: "fake", configRevision: 1, credentialEpoch: 0 });
    const stale = await fetch(`${base}/api/agent-conversations/conversations/conv-1/turns`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "frozen", entry: { action: "discuss", canvasId: "cv", prompt: "hi", connectionId: "c1",
        connection: { connectionId: "c1", adapterId: "fake", configRevision: 0, credentialEpoch: 0 } } })
    });
    expect(stale.status).toBe(409);
    expect(calls).toHaveLength(1);

    connectionResult = { ok: false as const, error: { code: "connection-unavailable", message: "无权访问" } };
    const failResponse = await fetch(`${base}/api/agent-conversations/conversations/conv-1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "req-2", entry: { action: "discuss", canvasId: "cv", prompt: "hi", connectionId: "c9" } })
    });
    expect(failResponse.status).toBe(409);
  });
});

it("service management uses trusted owner, enforces Origin/admin and atomically binds only supported personal text", async () => {
  const { createServiceConnectionRegistry } = await import("../service-connections/registry.js");
  const { createSqliteExtensionDocumentStore } = await import("../repository/extension-document-store.js");
  const store = createSqliteExtensionDocumentStore({ path: ":memory:", owners: ["sources"] });
  const registry = createServiceConnectionRegistry({ documents: store.forExtension("sources")!, checkEndpoint: () => true, validateBinding: () => false });
  const actor = { owner: "user-a", administrator: false, canUseSite: true };
  const port = registry.forExtension("demo");
  port.registerConsumer({ protocols: ["chat-completions"], purposes: ["text"] });
  const source = (await registry.save(actor, { operationId: "create", name: "Relay", endpoints: [{ protocol: "chat-completions", baseUrl: "https://relay.example/v1" }], expectedRevision: 0, expectedCredentialEpoch: 0 })).connection;
  const evidenced = await registry.publishCapabilities(actor, source.serviceConnectionId, source, [{ purpose: "discussion", protocol: "chat-completions", modelId: "model", imageInput: false, evidence: "adapter" }]);
  const providers = () => [{ providerId: "demo", extensionId: "demo", models: [{ providerModelId: "model", modelType: "language" }], serviceConnectionFactory: { protocols: ["chat-completions"] } }] as unknown as import("@woohaa3/contracts").GenerationProvider[];
  try {
    const { base } = await boot({ serviceConnections: registry, serviceConnectionProviders: providers });
    const body = { ...evidenced, owner: "victim", scope: "site", providerId: "demo", modelId: "model" };
    const post = (action: string, origin = base, payload = body) => fetch(`${base}/api/agent-conversations/service-connections/${action}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(payload) });
    expect((await post("provider", "https://evil.example")).status).toBe(403);
    expect((await post("provider", "invalid-url")).status).toBe(403);
    expect((await post("assistant")).status).toBe(403);
    const response = await post("provider");
    expect(response.status).toBe(200);
    const { connection } = await response.json();
    expect(connection.scope).toBe("personal");
    expect(connection.configRevision).toBe(evidenced.configRevision + 1);
    expect(connection.bindings[0]).toMatchObject({ extensionId: "demo", purposes: ["text"], modelKeys: ["demo:model"] });
    expect(await registry.list({ ...actor, owner: "victim" })).toEqual([]);
    expect((await post("provider")).status).toBe(409);
    const forwarded = await fetch(`${base}/api/agent-conversations/service-connections/enabled`, { method: "POST", headers: { origin: "https://canvas.example", "x-forwarded-host": "canvas.example", "x-forwarded-proto": "https", "content-type": "application/json" }, body: JSON.stringify({ ...connection, enabled: false }) });
    expect(forwarded.status).toBe(200);
  } finally { store.close(); }
});
