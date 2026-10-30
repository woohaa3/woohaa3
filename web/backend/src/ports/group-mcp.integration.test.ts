import http from "node:http";
import { describe, expect, it } from "vitest";
import { ContentContributionRegistry, createEmptyWoohaa3ServerCanvas, createFilmSetSnapshot, filmSetContentContribution, filmSetNodeDataFields, type CanvasGroupAction } from "@woohaa3/contracts";
import { filmSetMcpRuntime } from "../../../extensions/film-set/src/integration/backend/mcp-runtime.js";
import { AgentCanvasAuthoringService, AgentCanvasInternalService, AgentDeltaJournal, CanvasRoom, InMemoryYjsDocumentRepository, ModelMcpService, canvasGroupEpoch, withCanvasGroupScope, type CanvasService } from "@woohaa3/canvas-service";
import { createModelMcpHttpHandler } from "@woohaa3/mcp-service";
import { agentCanvasServiceToClient, modelMcpServiceToClient } from "./mcp-adapters.js";
import { groupScopedClient } from "./group-scoped-client.js";
import { createInProcessAuthoringServices, createToolGrantRegistry } from "./authoring-adapters.js";
import { migrateFilmSetCanvasFixture } from "../../../test-support/film-set-groups.js";

describe("real HTTP group MCP boundary", () => {
  it("carries trusted owner through HTTP, projects reads, confines simple plans and revokes calls", async () => {
    const canvas = createEmptyWoohaa3ServerCanvas("c", "now");
    canvas.document.nodes = [
      { id: "manager", type: "group", position: { x: 0, y: 0 }, width: 1200, height: 900 },
      { id: "root", type: "group", parentId: "manager", position: { x: 300, y: 200 }, width: 600, height: 400 },
      { id: "a", type: "text", parentId: "root", position: { x: 40, y: 50 } },
      { id: "outside", type: "text", position: { x: 2000, y: 0 } }
    ];
    canvas.nodeData = { manager: { retainWhenEmpty: true }, root: { retainWhenEmpty: true }, a: { prompt: "inside" }, outside: { prompt: "private-outside" } };
    const content = new ContentContributionRegistry();
    content.register(filmSetContentContribution);
    const room = new CanvasRoom({ canvasId: "c", repository: new InMemoryYjsDocumentRepository(), verifyAssets: false, content });
    await room.initialize({ canvas: migrateFilmSetCanvasFixture(canvas), roomEpoch: "epoch" });
    const principals: string[] = [];
    const internal = new AgentCanvasInternalService({
      resolveRoom: async id => id === "c" ? room : null,
      directory: { list: async () => ({ canvases: [] }) } as never,
      authorizer: { authorize: async input => { principals.push(input.principalId); return { allowed: input.principalId === "owner", reason: "owner only" }; } },
      journal: new AgentDeltaJournal(), authoring: new AgentCanvasAuthoringService({ resolveRoom: async () => room })
    });
    const model = new ModelMcpService({ resolveRoom: async () => room });
    const host = { sync: { registry: { resolve: async () => room } }, mcpServices: () => ({ agent: internal, modelMcp: model }) } as unknown as CanvasService;
    const grants = createToolGrantRegistry();
    const actions: CanvasGroupAction[] = [];
    const facade = createInProcessAuthoringServices({ canvas: host, toolGrantRegistry: grants });
    const tools = ["get_canvas_graph", "get_canvas_changes", "create_canvas_node", "set_node_prompt", "delete_canvas_entities", "run_canvas_node"];
    const grant = await facade.tools.issue({ delegation: { subject: "owner", authLevel: "authenticated" }, workId: "turn", canvasId: "c", nodeId: "root", mode: "canvas-group", expectedScopeEpoch: canvasGroupEpoch("c", "root"), tools });
    const handler = createModelMcpHttpHandler({
      service: groupScopedClient(modelMcpServiceToClient(model), host),
      agentAuthoring: { client: groupScopedClient(agentCanvasServiceToClient(internal, { principalId: "" }), host), runAvailability: { available: true } },
      toolGrant: { authorize: grants.authorize, allowedTools: token => grants.verify(token)?.tools ?? [] }
    });
    const server = http.createServer((req, res) => {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
      const authorized = grants.verify(token);
      const run = () => handler.handle(req, res);
      void (authorized?.groupScope ? withCanvasGroupScope({ ...authorized.groupScope, owner: grants.subject(token)!, valid: () => Boolean(grants.verify(token)), onAction: action => actions.push(action) }, run) : run());
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    const rpc = async (method: string, params: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}/mcp/model-canvas`, { method: "POST", headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const text = await response.text();
      const payload = response.headers.get("content-type")?.includes("text/event-stream") ? text.split("\n").filter(line => line.startsWith("data:")).at(-1)!.slice(5) : text;
      return JSON.parse(payload).result;
    };
    const call = (name: string, args: object) => rpc("tools/call", { name, arguments: args });
    try {
      const listed = await rpc("tools/list", {});
      expect(listed.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([...tools].sort());
      const graph = await call("get_canvas_graph", { canvasId: "c", includePrompt: true });
      expect(JSON.stringify(graph)).not.toContain("private-outside");
      expect(JSON.stringify(graph)).not.toContain('"nodeId":"outside"');
      expect(await call("set_node_prompt", { canvasId: "c", requestId: "bad", nodeId: "outside", prompt: "forged" })).toMatchObject({ isError: true });
      const good = await call("set_node_prompt", { canvasId: "c", requestId: "good", nodeId: "a", prompt: "updated" });
      expect(good.structuredContent?.ok, JSON.stringify(good)).toBe(true);
      expect(actions.some(action => action.commandId)).toBe(true);
      const created = await call("create_canvas_node", { canvasId: "c", requestId: "new", kind: "image", prompt: "scene" });
      expect(created.structuredContent?.ok, JSON.stringify(created)).toBe(true);
      const model = await call("create_canvas_node", { canvasId: "c", requestId: "model", kind: "model", title: "模型" });
      expect(model.structuredContent?.ok, JSON.stringify(model)).toBe(true);
      const snapshot = room.exportCanvas();
      expect(snapshot.ok && snapshot.canvas.document.nodes.filter(n => !["manager", "root", "outside", "a"].includes(n.id)).every(n => n.parentId === "root")).toBe(true);
      expect(principals.every(owner => owner === "owner")).toBe(true);
      grants.revoke("turn", "owner");
      const denied = await call("get_canvas_graph", { canvasId: "c" });
      expect(denied?.isError ?? true).toBe(true);
    } finally {
      await handler.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("rejects legacy film-set object writes after migration", async () => {
    const canvasId = "c-film-items";
    const snapshot = createFilmSetSnapshot({
      title: "片场",
      timeline: { duration: 0, loop: false },
      initialCamera: { azimuth: 0, elevation: 0.5, distance: 3, aspect: "16:9", focusOffset: { x: 0, y: 0, z: 0 } },
      filmSetContent: { schemaVersion: 4, items: [{ id: "ground", kind: "ground", name: "地面", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, size: { width: 8, depth: 8 } }] }
    });
    const canvas = createEmptyWoohaa3ServerCanvas(canvasId, "now");
    canvas.document.nodes = [
      { id: "root", type: "group", position: { x: 300, y: 200 }, width: 600, height: 400 },
      { id: "film", type: "composite-asset", parentId: "root", position: { x: 40, y: 40 } }
    ];
    canvas.nodeData = { root: { retainWhenEmpty: true }, film: filmSetNodeDataFields(snapshot) as never };
    const content = new ContentContributionRegistry();
  content.register(filmSetContentContribution);
    const room = new CanvasRoom({ canvasId, repository: new InMemoryYjsDocumentRepository(), verifyAssets: false, content });
    await room.initialize({ canvas: migrateFilmSetCanvasFixture(canvas), roomEpoch: "epoch" });
    const filmSet = filmSetMcpRuntime.createNodeService({ resolveRoom: async () => room });
    const withGroup = <T>(run: () => Promise<T>) => withCanvasGroupScope({
      owner: "owner", canvasId, rootGroupId: "root", scopeEpoch: canvasGroupEpoch(canvasId, "root"), valid: () => true
    }, run);
    const outcome = await withGroup(() => filmSet.commitAnimation({
      canvasId,
      nodeId: "film",
      requestId: "film-items",
      animation: {
        ...snapshot,
        filmSetContent: {
          schemaVersion: 4,
          items: [...snapshot.filmSetContent.items, {
            id: "cube", kind: "model", name: "方块",
            localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
            model: { modelScript: "scene.box({id:'cube',size:[1,1,1]});", modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2" }
          }]
        }
      }
    }));
    // 迁移后的 group 只接受来自资源卡片的新对象；旧 composite 的直接写入被稳定拒绝。
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("source-required");
    const exported = room.exportCanvas();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.canvas.document.nodes.some(node => node.id.startsWith("film-object:"))).toBe(false);
    expect(exported.canvas.document.nodes.find(node => node.id === "root")?.position.y).toBe(200);
  });
});
