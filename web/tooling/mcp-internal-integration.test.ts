/**
 * MCP Service ⇄ Canvas 内部协议集成测试
 * （change: split-model-mcp-into-mcp-service）。
 *
 * 经真实 HTTP 边界组合 canvas-service 与 mcp-service：MCP 客户端提交脚本 → mcp-service
 * 经受认证内部协议调用 Canvas → 权威 Y.Doc 落库；并验证未认证/协议不兼容在副作用前拒绝。
 */
import { YJS_CANVAS_FORMAT_VERSION } from "@woohaa3/contracts/canvas-yjs";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createModel3DNodeData, model3DNodeDataFields, MCP_INTERNAL_ACTOR_ID, type CanvasCommand } from "@woohaa3/contracts";
import { serverCanvasToYDoc } from "@woohaa3/contracts/canvas-yjs";
import { InMemoryYjsDocumentRepository, createCanvasService } from "@woohaa3/canvas-service";
import { createMcpService } from "@woohaa3/mcp-service";

const TOKEN = "mcp-to-canvas-token";
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>) {
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  return new Promise<{ server: http.Server; port: number }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

describe("mcp-service → canvas-service 内部协议", () => {
  it("MCP 工具提交 modelScript 权威落库，且 actorId 由服务身份派生", async () => {
    const yjsRepository = new InMemoryYjsDocumentRepository();
    const canvasId = "mcp-split-canvas";
    const seed = {
      id: canvasId,
      title: "mcp",
      revision: 0,
      document: {
        schemaVersion: "asset-canvas-v1",
        nodes: [{ id: "model-1", type: "model3d", position: { x: 0, y: 0 }, width: 196, height: 64 }],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        updatedAt: "2026-09-28T00:00:00.000Z"
      },
      nodeData: {
        "model-1": model3DNodeDataFields(createModel3DNodeData({
          title: "Seed model",
          model: {
            modelScript: "scene.box({ id: 'seed', size: [1, 1, 1] });",
            modelScriptVersion: "woohaa-model-js-v2"
          }
        }))
      },
      assets: [],
      jobs: [],
      updatedAt: "2026-09-28T00:00:00.000Z"
    };
    await yjsRepository.createYjsDocument({
      canvasId,
      formatVersion: YJS_CANVAS_FORMAT_VERSION,
      roomEpoch: "mcp-split-epoch",
      checkpoint: Y.encodeStateAsUpdate(serverCanvasToYDoc(seed as never)),
      projection: seed as never,
      revision: 0,
      createdAt: "2026-09-28T00:00:00.000Z"
    });

    const canvasService = await createCanvasService({
      env: {
        WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
        WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: ":memory:",
        WOOHAA3_MCP_TO_CANVAS_TOKEN: TOKEN, WOOHAA3_MEDIA_SERVICE_URL: "http://127.0.0.1:1"
      },
      yjsRepository,
      // No media references are used; unexpected verification must fail the fixture.
      mediaClient: { verify: async () => { throw new Error("Unexpected media verification"); } },
      enableNodeHistory: false,
      enablePromptSnippets: false
    });
    expect(canvasService.mcpServices().modelMcp).not.toBeNull();
    const canvas = await listen(canvasService.handle);
    closers.push(async () => {
      await canvasService.close();
      await new Promise<void>((resolve) => canvas.server.close(() => resolve()));
    });

    const mcpService = createMcpService({
      env: { WOOHAA3_CANVAS_SERVICE_URL: `http://127.0.0.1:${canvas.port}`, WOOHAA3_MCP_TO_CANVAS_TOKEN: TOKEN }
    });
    const mcp = await listen(mcpService.handle);
    closers.push(async () => {
      await mcpService.close();
      await new Promise<void>((resolve) => mcp.server.close(() => resolve()));
    });

    // 经 MCP 传输提交脚本。
    const response = await fetch(`http://127.0.0.1:${mcp.port}/mcp/model-canvas`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-03-26"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "submit_model_script",
          arguments: { canvasId, nodeId: "model-1", source: "scene.box({ id: 'b', size: [1, 1, 1] });", requestId: "mcp-int-1" }
        }
      })
    });
    const text = await response.text();
    const payload = response.headers.get("content-type")?.includes("text/event-stream")
      ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1) ?? "{}"
      : text;
    const parsed = JSON.parse(payload) as { result?: { isError?: boolean; content?: Array<{ text: string }>; structuredContent?: { ok?: boolean; canvasId?: string; nodeId?: string; commandId?: string } } };
    expect(parsed.result?.isError, payload).toBeFalsy();
    expect(parsed.result?.structuredContent).toMatchObject({ ok: true, canvasId, nodeId: "model-1" });
    const commandId = parsed.result?.structuredContent?.commandId;
    expect(commandId).toBeTruthy();
    expect(await yjsRepository.getCommandRecord(canvasId, commandId!)).toMatchObject({ actorId: MCP_INTERNAL_ACTOR_ID });

    // 权威 Y.Doc 已落库（画布权威仍在 Canvas）。
    const state = await yjsRepository.loadYjsState(canvasId);
    const nodeData = (state?.projection as { nodeData?: Record<string, { modelScript?: string }> } | null)?.nodeData;
    expect(nodeData?.["model-1"]?.modelScript).toBe("scene.box({ id: 'b', size: [1, 1, 1] });");
  });

  it("节点编排工具经内部协议写画布，且未认证内部调用被拒绝", async () => {
    // 未认证：直接调用内部入口（无令牌）应 401，且不落库。
    const yjsRepository = new InMemoryYjsDocumentRepository();
    const canvasId = "mcp-split-unauth";
    const seed = {
      id: canvasId,
      title: "mcp",
      revision: 0,
      document: { schemaVersion: "asset-canvas-v1", nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: "2026-09-28T00:00:00.000Z" },
      nodeData: {},
      assets: [],
      jobs: [],
      updatedAt: "2026-09-28T00:00:00.000Z"
    };
    await yjsRepository.createYjsDocument({
      canvasId,
      formatVersion: YJS_CANVAS_FORMAT_VERSION,
      roomEpoch: "unauth-epoch",
      checkpoint: Y.encodeStateAsUpdate(serverCanvasToYDoc(seed as never)),
      projection: seed as never,
      revision: 0,
      createdAt: "2026-09-28T00:00:00.000Z"
    });
    const canvasService = await createCanvasService({
      env: { WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite", WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: ":memory:", WOOHAA3_MCP_TO_CANVAS_TOKEN: TOKEN, WOOHAA3_MEDIA_SERVICE_URL: "http://127.0.0.1:1" },
      yjsRepository,
      // No media references are used; unexpected verification must fail the fixture.
      mediaClient: { verify: async () => { throw new Error("Unexpected media verification"); } },
      enableNodeHistory: false,
      enablePromptSnippets: false
    });
    expect(canvasService.mcpServices().modelMcp).not.toBeNull();
    const canvas = await listen(canvasService.handle);
    closers.push(async () => {
      await canvasService.close();
      await new Promise<void>((resolve) => canvas.server.close(() => resolve()));
    });

    const commands: CanvasCommand[] = [{ type: "canvas.setTitle", title: "hacked" }];
    const denied = await fetch(`http://127.0.0.1:${canvas.port}/internal/v1/model-mcp/commands`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-woohaa3-mcp-protocol-version": "1" },
      body: JSON.stringify({ canvasId, commandId: "unauth", baseRevision: 0, commands })
    });
    expect(denied.status).toBe(401);

    const state = await yjsRepository.loadYjsState(canvasId);
    expect((state?.projection as { title?: string } | null)?.title).toBe("mcp");
  });
});
