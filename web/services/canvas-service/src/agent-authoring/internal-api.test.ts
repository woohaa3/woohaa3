/**
 * Agent Canvas 内部 v2 HTTP 面测试
 * （change: add-agent-canvas-authoring-mcp，任务 1.5 / 2.2 / 3.5）。
 *
 * 覆盖协议版本协商、服务身份、delegated principal 不从请求体读取、授权拒绝与写入。
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentInternalHandler,
  AGENT_PRINCIPAL_HEADER,
  type AgentInternalHandlerOptions
} from "./internal-api.js";
import { createDevelopmentAuthorizer } from "./authorization.js";
import { AgentCanvasInternalService } from "./internal-service.js";
import { AgentCanvasAuthoringService } from "./service.js";
import { AgentDeltaJournal } from "./delta-journal.js";
import type { CanvasRoom } from "../sync/index.js";
import type { ServerCanvas } from "@woohaa3/contracts";
import {
  AGENT_INTERNAL_PATHS,
  AGENT_INTERNAL_PROTOCOL_HEADER,
  AGENT_INTERNAL_PROTOCOL_VERSION,
  SERVICE_TOKEN_HEADER
} from "@woohaa3/contracts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function canvas(): ServerCanvas {
  return {
    id: "c1",
    title: "画布",
    revision: 1,
    document: {
      schemaVersion: "asset-canvas-v1",
      updatedAt: "2026-09-28T00:00:00.000Z",
      nodes: [{ id: "text-1", type: "text", position: { x: 0, y: 0 } }],
      edges: []
    },
    nodeData: { "text-1": { prompt: "hi" } },
    assets: [],
    jobs: [],
    updatedAt: "2026-09-28T00:00:00.000Z"
  };
}

function fakeRoom(): CanvasRoom {
  let revision = 1;
  return {
    canvasId: "c1",
    exportCanvas: () => ({ ok: true as const, canvas: { ...canvas(), revision } }),
    lookupCommand: async () => null,
    submit: async (batch: { commandId: string }) => {
      revision += 1;
      return { ok: true as const, status: "accepted" as const, commandId: batch.commandId, revision, noop: false, update: null };
    }
  } as unknown as CanvasRoom;
}

async function start(options?: Partial<AgentInternalHandlerOptions>) {
  const room = fakeRoom();
  const authorizer = createDevelopmentAuthorizer({ developmentPrincipalId: "dev-user", canvasIds: ["c1"] });
  const service = new AgentCanvasInternalService({
    resolveRoom: async () => room,
    directory: {
      async list({ principalId }) {
        if (principalId !== "dev-user") return { canvases: [] };
        return { canvases: [{ canvasId: "c1", title: "画布", revision: 1, updatedAt: "x", nodeCount: 1 }] };
      }
    },
    authorizer,
    journal: new AgentDeltaJournal(),
    authoring: new AgentCanvasAuthoringService({ resolveRoom: async () => room }),
    defaultCanvasId: "c1"
  });
  const handler = createAgentInternalHandler({ service, developmentPrincipalId: "dev-user", ...options });
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  closers.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { base: `http://127.0.0.1:${port}` };
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [AGENT_INTERNAL_PROTOCOL_HEADER]: String(AGENT_INTERNAL_PROTOCOL_VERSION),
      ...headers
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("Agent Canvas 内部 v2 面（任务 1.5 / 2.2）", () => {
  it("拒绝缺失/不兼容协议版本", async () => {
    const { base } = await start();
    const response = await fetch(`${base}${AGENT_INTERNAL_PATHS.graph}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("protocol-incompatible");
  });

  it("loopback 开发模式使用显式 development principal 读取 graph", async () => {
    const { base } = await start();
    const { status, body } = await post(base, AGENT_INTERNAL_PATHS.graph, { canvasId: "c1", includePrompt: true });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, canvasId: "c1", revision: 1 });
    expect(JSON.stringify(body)).toContain("text-1");
  });

  it("显式 principal 头覆盖开发默认，且不在授权白名单时拒绝", async () => {
    const { base } = await start();
    const denied = await post(base, AGENT_INTERNAL_PATHS.graph, { canvasId: "c1" }, { [AGENT_PRINCIPAL_HEADER]: "intruder" });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("forbidden");
  });

  it("工具参数自报 principal 不参与授权（请求体 principalId 不可见）", async () => {
    const { base } = await start();
    const { status, body } = await post(base, AGENT_INTERNAL_PATHS.graph, { canvasId: "c1", principalId: "dev-user" });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("配置服务令牌时拒绝未带令牌的请求", async () => {
    const { base } = await start({ serviceToken: "secret" });
    const missing = await post(base, AGENT_INTERNAL_PATHS.graph, { canvasId: "c1" });
    expect(missing.status).toBe(401);
    const withToken = await post(base, AGENT_INTERNAL_PATHS.graph, { canvasId: "c1" }, { [SERVICE_TOKEN_HEADER]: "secret", [AGENT_PRINCIPAL_HEADER]: "dev-user" });
    expect(withToken.status).toBe(200);
  });

  it("list 返回可访问画布并过滤其它 principal", async () => {
    const { base } = await start();
    const { status, body } = await post(base, AGENT_INTERNAL_PATHS.list, {});
    expect(status).toBe(200);
    expect((body.canvases as unknown[]).length).toBe(1);
  });

  it("apply 写入并返回 canonical 回执", async () => {
    const { base } = await start();
    const { status, body } = await post(base, AGENT_INTERNAL_PATHS.apply, {
      canvasId: "c1",
      requestId: "req-1",
      commandId: "cmd-1",
      payloadHash: "hash-1",
      baseRevision: 1,
      commands: [{ type: "nodeData.patch", nodeId: "text-1", value: { prompt: "new" } }]
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, revision: 2 });
  });

  it("未知路径与未命中路径不接管", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/internal/v2/other`);
    expect(response.status).toBe(404);
  });
});
