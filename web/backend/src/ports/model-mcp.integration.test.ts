import http from "node:http";
import { expect, it } from "vitest";
import { ContentContributionRegistry, createEmptyWoohaa3ServerCanvas, filmSetContentContribution, modelSourceHash } from "@woohaa3/contracts";
import { CanvasRoom, InMemoryYjsDocumentRepository, ModelMcpService } from "@woohaa3/canvas-service";
import { createModelMcpHttpHandler } from "@woohaa3/mcp-service";
import { modelMcpServiceToClient } from "./mcp-adapters.js";
import { createFilmSetSnapshot, filmSetNodeDataFields } from "@woohaa3/contracts";
import { filmSetMcpTools } from "../../../extensions/film-set/src/integration/backend/mcp-tools.js";
import type { ApplicationExtensionMcpTool, ContentMcpToolContext } from "@woohaa3/contracts";
import { createToolGrantRegistry } from "./authoring-adapters.js";
import { migrateFilmSetCanvasFixture } from "../../../test-support/film-set-groups.js";

it("旧 composite 片场在迁移后只读；局部授权仍被拒绝", async () => {
  const canvasId = "film-set-direct-generation";
  const canvas = createEmptyWoohaa3ServerCanvas(canvasId, "now");
  canvas.document.nodes = [{ id: "scene", type: "composite-asset", position: { x: 0, y: 0 } }];
  const initial = createFilmSetSnapshot({ title: "测试场景", timeline: { duration: 0, loop: false }, initialCamera: { azimuth: 0.3, elevation: 0.5, distance: 7, aspect: "4:3", focusOffset: { x: 1, y: 0, z: 0 } }, filmSetContent: explicitGroundContent() });
  canvas.nodeData.scene = filmSetNodeDataFields(initial) as never;
  const content = new ContentContributionRegistry();
  content.register(filmSetContentContribution);
  const room = new CanvasRoom({ canvasId, repository: new InMemoryYjsDocumentRepository(), verifyAssets: false, content });
  await room.initialize({ canvas: migrateFilmSetCanvasFixture(canvas), roomEpoch: "epoch" });
  const model = new ModelMcpService({ resolveRoom: async () => room });
  const grants = createToolGrantRegistry();
  const baseGrant = { canvasIds: [canvasId], nodeIds: ["scene"], tools: ["get_model_node", "submit_film_set"] };
  for (const [token, scope] of [["whole", {}], ["item", { itemId: "table" }], ["clip", { clipId: "shot" }], ["camera", { cameraId: "camera" }]] as const) grants.issue({ ...baseGrant, token, workId: `w-${token}`, ...scope });
  const toolContext: ContentMcpToolContext = {
    extensionId: "film-set",
    permission: "write",
    resolveRoom: async () => room,
    readNode: (input => model.getModelNode(input)) as ContentMcpToolContext["readNode"],
    applyCommands: input => model.applyCommands!(input)
  };
  const extensionTools = {
    list: (): readonly ApplicationExtensionMcpTool[] => filmSetMcpTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      route: `content/film-set/${tool.name}`,
      permission: tool.permission ?? "write",
      inputSchema: tool.inputSchema
    })),
    call: async ({ name, args }: { name: string; args: Record<string, unknown> }) => {
      const tool = filmSetMcpTools.find(entry => entry.name === name);
      if (!tool) return { ok: false, code: "unknown-tool", message: name };
      const result = await tool.handle(args, toolContext);
      return result.ok
        ? { ok: true, ...(result.structured as Record<string, unknown> | undefined), ...(result.text ? { text: result.text } : {}) }
        : { ok: false, code: (result.structured as { code?: string } | undefined)?.code ?? "extension-failed", message: result.text ?? "扩展操作失败" };
    }
  };
  const handler = createModelMcpHttpHandler({ service: modelMcpServiceToClient(model), extensionTools, toolGrant: { authorize: input => grants.authorize(input) } });
  const server = http.createServer((req, res) => { void handler.handle(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const call = async (name: string, args: Record<string, unknown>, token = "whole") => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/mcp/model-canvas`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { canvasId, nodeId: "scene", ...args } } }) });
    const raw = await response.text();
    const result = JSON.parse(response.headers.get("content-type")?.includes("text/event-stream") ? raw.split("\n").filter(line => line.startsWith("data:")).at(-1)!.slice(5) : raw).result;
    expect(result, raw).toBeDefined();
    return result;
  };
  try {
    const read = (await call("get_model_node", {})).structuredContent;
    const { camera: _camera, timeline: _timeline, kind: _kind, ...animation } = read.animation;
    animation.filmSetContent.items.push(...["table", "chair"].map(id => ({ id, name: id, kind: "model", localTransform: { offset: { x: id === "table" ? 0 : 2, y: 0, z: 0 }, scale: 1, yaw: 0 }, model: { modelScript: `scene.box({id:'${id}',size:[1,1,1]});`, modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2" } })));
    const input = { requestId: "generate", expectedSnapshotHash: read.snapshotHash, animation };
    for (const token of ["item", "clip", "camera"]) {
      expect((await call("submit_film_set", input, token)).isError).toBe(true);
    }
    const before = room.exportCanvas();
    const legacy = await call("submit_film_set", { requestId: "legacy", expectedSnapshotHash: read.snapshotHash, animation: read.animation });
    expect(legacy.isError).toBe(true);
    expect(legacy.content[0].text).toMatch(/只允许迁移读取|资源卡片/);
    // 拒绝发生在副作用前：迁移后的 group、来源卡片和其它数据都保持不变。
    expect(room.exportCanvas()).toEqual(before);
  } finally { await handler.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("real model MCP commits valid scripts and returns valid text for rejected scripts", async () => {
  const canvasId = "model-mcp-regression";
  const source = "scene.box({ id: 'body', size: [1,2,1], color: '#ff0000' });";
  const canvas = createEmptyWoohaa3ServerCanvas("model-mcp-regression", "now");
  canvas.document.nodes = [{ id: "model", type: "model3d", position: { x: 0, y: 0 } }];
  canvas.nodeData.model = { title: "model", modelScript: source, modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2", modelContentVersion: { revision: 1, sourceHash: modelSourceHash(source), contentHash: "initial" }, modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } };
  const room = new CanvasRoom({ canvasId: canvasId, repository: new InMemoryYjsDocumentRepository(), verifyAssets: false });
  await room.initialize({ canvas: migrateFilmSetCanvasFixture(canvas), roomEpoch: "epoch" });
  const model = new ModelMcpService({ resolveRoom: async () => room });
  const handler = createModelMcpHttpHandler({ service: modelMcpServiceToClient(model) });
  const server = http.createServer((req, res) => { void handler.handle(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const call = async (script: string, requestId: string) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/mcp/model-canvas`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "submit_model_script", arguments: { canvasId: canvasId, nodeId: "model", source: script, requestId } } }) });
    const raw = await response.text();
    const result = JSON.parse(response.headers.get("content-type")?.includes("text/event-stream") ? raw.split("\n").filter(line => line.startsWith("data:")).at(-1)!.slice(5) : raw).result;
    expect(result, raw).toBeDefined();
    for (const item of result.content) if (item.type === "text") expect(typeof item.text, JSON.stringify(result)).toBe("string");
    return result;
  };
  try {
    const updated = "scene.box({ id: 'changed', size: [2,2,2], color: '#00ff00' });";
    const result = await call(updated, "valid");
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const snapshot = room.exportCanvas();
    expect(snapshot.ok && snapshot.canvas.nodeData.model?.modelScript).toBe(updated);
    for (const [index, invalid] of ["scene.box({", "throw new Error('runtime failure');", "scene.box({ id: 'bad', color: 'invalid' });"].entries()) {
      const failure = await call(invalid, `invalid-${index}`);
      expect(failure.isError, JSON.stringify(failure)).toBe(true);
      expect(failure.content[0].text.length).toBeGreaterThan(0);
    }
    expect(room.exportCanvas()).toEqual(snapshot);
  } finally { await handler.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

function explicitGroundContent(): import("@woohaa3/contracts").FilmSetContent {
  return { schemaVersion: 4, items: [{ id: "ground", kind: "ground", name: "地面", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, size: { width: 8, depth: 8 } }] };
}
