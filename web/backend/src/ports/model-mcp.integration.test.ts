import http from "node:http";
import { expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, migrateLegacyFilmSetToGroup, modelSourceHash } from "@woohaa3/contracts";
import { CanvasRoom, InMemoryYjsDocumentRepository, ModelMcpService } from "@woohaa3/canvas-service";
import { createModelMcpHttpHandler } from "@woohaa3/mcp-service";
import { modelMcpServiceToClient } from "./mcp-adapters.js";
import { createFilmSetSnapshot, filmSetNodeDataFields } from "@woohaa3/contracts";
import { filmSetMcpRuntime } from "../../../extensions/film-set/src/integration/backend/mcp-runtime.js";
import { createToolGrantRegistry } from "./authoring-adapters.js";

it("真实 MCP 在只有地面的片场生成独立模型；原子拒绝非法脚本、旧快照和局部授权", async () => {
  const canvasId = "film-set-direct-generation";
  const canvas = createEmptyWoohaa3ServerCanvas(canvasId, "now");
  canvas.document.nodes = [{ id: "scene", type: "composite-asset", position: { x: 0, y: 0 } }];
  const initial = createFilmSetSnapshot({ title: "测试场景", timeline: { duration: 0, loop: false }, initialCamera: { azimuth: 0.3, elevation: 0.5, distance: 7, aspect: "4:3", focusOffset: { x: 1, y: 0, z: 0 } }, filmSetContent: explicitGroundContent() });
  canvas.nodeData.scene = filmSetNodeDataFields(initial) as never;
  // 旧片场已只读（change: 2026-10-27-...）：写入前必须按正式路径迁移成群组，
  // 否则 submit_film_set 一律回 migration-required。
  const migrated = migrateLegacyFilmSetToGroup(canvas, "scene", { commandId: "test-migration", groupId: "scene" });
  if (!migrated.ok) throw new Error(migrated.reason);
  const room = new CanvasRoom({ canvasId, repository: new InMemoryYjsDocumentRepository(), verifyAssets: false });
  await room.initialize({ canvas: migrated.canvas, roomEpoch: "epoch" });
  const model = new ModelMcpService({ resolveRoom: async () => room });
  const filmSet = filmSetMcpRuntime.createNodeService({ resolveRoom: async () => room });
  const grants = createToolGrantRegistry();
  const baseGrant = { canvasIds: [canvasId], nodeIds: ["scene"], tools: ["get_model_node", "submit_film_set"] };
  for (const [token, scope] of [["whole", {}], ["item", { itemId: "table" }], ["clip", { clipId: "shot" }], ["camera", { cameraId: "camera" }]] as const) grants.issue({ ...baseGrant, token, workId: `w-${token}`, ...scope });
  const handler = createModelMcpHttpHandler({ service: modelMcpServiceToClient(model, { commitAnimation: input => filmSet.commitAnimation(input) }), toolGrant: { authorize: input => grants.authorize(input) } });
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
    for (const token of ["item", "clip", "camera"]) expect((await call("submit_film_set", input, token)).isError).toBe(true);
    expect((await call("submit_film_set", input)).isError).not.toBe(true);
    const saved = room.exportCanvas();
    expect(saved.ok && (saved.canvas.nodeData.scene?.filmSetContent as any).items.map((i: any) => i.id)).toEqual(["ground", "table", "chair"]);
    expect(saved.ok && saved.canvas.nodeData.scene?.modelScript).toBeUndefined();
    expect(saved.ok && saved.canvas.nodeData.scene?.sceneCamera).toEqual(initial.sceneCamera);
    expect(saved.ok && saved.canvas.nodeData.scene?.title).toBe("测试场景");
    expect((await call("submit_film_set", input)).structuredContent.duplicate).toBe(true);
    const stale = await call("submit_film_set", { ...input, requestId: "stale" });
    expect(stale.isError).toBe(true); expect(stale.content[0].text).toContain("并发");
    const latest = (await call("get_model_node", {})).structuredContent;
    animation.filmSetContent.items[1].model.modelScript = "scene.box(";
    expect((await call("submit_film_set", { ...input, requestId: "bad-script", expectedSnapshotHash: latest.snapshotHash })).isError).toBe(true);
    expect((await call("submit_film_set", { ...input, requestId: "bad-content", expectedSnapshotHash: latest.snapshotHash, animation: { ...animation, filmSetAnimations: { schemaVersion: 999 } } })).isError).toBe(true);
    expect(room.exportCanvas()).toEqual(saved);
  } finally { await handler.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("real model MCP commits valid scripts and returns valid text for rejected scripts", async () => {
  const canvasId = "model-mcp-regression";
  const source = "scene.box({ id: 'body', size: [1,2,1], color: '#ff0000' });";
  const canvas = createEmptyWoohaa3ServerCanvas("model-mcp-regression", "now");
  canvas.document.nodes = [{ id: "model", type: "model3d", position: { x: 0, y: 0 } }];
  canvas.nodeData.model = { title: "model", modelScript: source, modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2", modelContentVersion: { revision: 1, sourceHash: modelSourceHash(source), contentHash: "initial" }, modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } };
  const room = new CanvasRoom({ canvasId: canvasId, repository: new InMemoryYjsDocumentRepository(), verifyAssets: false });
  await room.initialize({ canvas, roomEpoch: "epoch" });
  const model = new ModelMcpService({ resolveRoom: async () => room });
  const handler = createModelMcpHttpHandler({ service: modelMcpServiceToClient(model, {}) });
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
