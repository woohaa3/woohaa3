import http from "node:http";
import * as Y from "yjs";
import { serverCanvasToYDoc, YJS_CANVAS_FORMAT_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cp, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { createBackendService } from "../src/composition.js";
import { YJS_SYNC_PROTOCOL_VERSION, type MediaStorage } from "@woohaa3/contracts";
import { CanvasArchiveService, SqliteCanvasRepository, SqliteYjsRepository, createPublishedReader, createYjsArchivePublication } from "@woohaa3/canvas-service";
import { gameFurnaceArchiveDefinition } from "../../../extensions/game-furnace/src/archive.js";
import { buildCanvasCopyPayload } from "../../frontend/src/cordis/plugins/canvas-shell/clipboard/payload.js";
import { planCanvasPaste } from "../../frontend/src/cordis/plugins/canvas-shell/clipboard/planner.js";

const html = '<!doctype html><html><body><canvas id="game"></canvas><script>let score=0;function tick(){score++;requestAnimationFrame(tick)}tick()</script></body></html>';

it("真实 MCP Agent 创建、读取/收集、直接提交、幂等、持久化试玩与授权边界", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa-furnace-mcp-"));
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const storageFor = (records: typeof objects): MediaStorage => ({
    async put(key, bytes, contentType) { records.set(key, { bytes: bytes.slice(), contentType }); },
    async get(key) { const value = records.get(key); if (!value) throw Error(`missing ${key}`); return value; },
    async exists(key) { return records.has(key); },
    async stat(key) { const value = records.get(key); if (!value) throw Error(`missing ${key}`); return { size: value.bytes.length, contentType: value.contentType }; }
  });
  const mediaStorage = storageFor(objects);
  const service = await createBackendService({ env: {
    WOOHAA3_AGENT_LOOPBACK_MODE: "1", WOOHAA3_MCP_DEVELOPMENT_PRINCIPAL: "local-dev",
    WOOHAA3_TASK_STORE_PATH: path.join(dir, "task.sqlite"),
    WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite", WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: path.join(dir, "canvas.sqlite"),
    WOOHAA3_APPLICATION_STORE_PATH: path.join(dir, "application.sqlite")
  }, logger: () => {}, enableYjsSync: true, modelsConfig: { version: 1, models: [] }, mediaStorage });
  const server = http.createServer((req, res) => void service.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let id = 0;
  let projectDirectory: string | undefined;
  const rpc = async (method: string, params: unknown, headers: Record<string, string> = {}, endpoint = base) => {
    const response = await fetch(`${endpoint}/mcp/model-canvas`, { method: "POST", headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26", ...headers
    }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const text = await response.text();
    const payload = response.headers.get("content-type")?.includes("text/event-stream")
      ? text.split("\n").filter(l => l.startsWith("data:")).at(-1)!.slice(5) : text;
    return JSON.parse(payload).result;
  };
  const call = async (name: string, args: Record<string, unknown>, headers?: Record<string, string>) => rpc("tools/call", { name, arguments: { canvasId: "c", ...args } }, headers);
  const data = (result: { structuredContent?: any; content: { text: string }[] }) => result.structuredContent ?? JSON.parse(result.content[0]!.text);
  try {
    const canvas = service.modules().canvas.composition!.service;
    await canvas.createCanvas({ canvasId: "c" });
    await canvas.commitCommands({ canvasId: "c", expectedRevision: 1, operationId: "source", actorId: "local-dev", commands: [
      { type: "node.add", node: { id: "reference", type: "text", position: { x: 0, y: 0 } }, nodeData: { prompt: "收集金币" } }
    ] });
    await service.modules().application.plugins().reconcile();
    const list = await rpc("tools/list", {});
    expect(list.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["create_game_furnace", "get_game_furnace", "update_game_furnace", "submit_game", "preview_game"]));
    const created = data(await call("create_game_furnace", { requestId: "create", title: "金币游戏" }));
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true, state: { resources: [] } });
    const nodeId = created.nodeId;
    const updated = data(await call("update_game_furnace", { nodeId, requestId: "requirements", expectedInputHash: created.inputHash,
      requirements: { name: "金币游戏", description: "收集金币得分" }, sourceNodeIds: ["reference"] }));
    expect(updated).toMatchObject({ ok: true, state: { resources: [{ kind: "text", payload: { snapshot: { text: "收集金币" } } }] } });
    const read = data(await call("get_game_furnace", { nodeId }));
    expect(read.inputHash).toBe(updated.inputHash);
    expect(read.authoring).toMatchObject({ format: "agent-built-site-v2", buildOwner: "agent", acceptsBuiltDirectory: true, standaloneSite: true });
    expect(read.authoring.rules).toContain("宿主只登记已有产物");
    expect((await call("submit_game", { nodeId, requestId: "stale", expectedInputHash: created.inputHash, html })).isError).toBe(true);
    const input = { nodeId, requestId: "source-v1", expectedInputHash: read.inputHash, html };
    const submitted = data(await call("submit_game", input));
    expect(submitted).toMatchObject({ ok: true, state: { activeBuildId: submitted.buildId }, autoActivate: true });
    const published = (await service.modules().canvas.sync!.registry.resolve("c"))!.exportCanvas();
    if (!published.ok) throw Error(published.message);
    const saved = published.canvas;
    const finalized = await fetch(`${base}/api/extensions/game-furnace/handlers/game-furnace/finalize`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canvasId: "c", nodeId, generationId: submitted.generationId }) });
    expect(await finalized.json()).toMatchObject({ ok: true, state: "succeeded", buildId: submitted.buildId, reused: true });
    expect(saved.nodeData[nodeId]).toMatchObject({ activeBuildId: submitted.buildId, projectStorageKey: submitted.projectStorageKey, modelScriptLanguage: "javascript" });
    expect(saved.document.nodes.some(n => n.id === "reference")).toBe(true);
    const retry = data(await call("submit_game", input));
    expect(retry).toMatchObject({ ok: true, buildId: submitted.buildId, reused: true });
    expect(retry.state.builds).toHaveLength(1);
    expect((await call("submit_game", { ...input, html: html.replace('score=0', 'score=1') })).isError).toBe(true);
    expect((await call("submit_game", { ...input, requestId: "external", html: '<html><script src="https://example.com/game.js"></script></html>' })).isError).toBe(true);
    const preview = data(await call("preview_game", { nodeId, buildId: submitted.buildId }));
    expect(preview).toMatchObject({ ok: true, entryUrl: expect.stringContaining("/site/") });
    expect(await (await fetch(base + preview.entryUrl)).text()).toContain("requestAnimationFrame");
    expect((await call("get_game_furnace", { nodeId }, { "x-forwarded-for": "10.0.0.5" })).isError).toBe(true);
    expect((await call("get_game_furnace", { nodeId }, { authorization: "Bearer forged" })).isError).toBe(true);
    expect((await call("get_game_furnace", { nodeId: "reference" })).isError).toBe(true);
    expect((await call("get_game_furnace", { canvasId: "missing", nodeId })).isError).toBe(true);
    const prepared = data(await call("prepare_game_project", { nodeId, requestId: "prepare", expectedInputHash: read.inputHash }));
    expect(prepared).toMatchObject({ ok: true, projectId: expect.any(String), resources: [{ path: "assets/res-reference.txt" }] });
    projectDirectory = prepared.projectDirectory;
    // Agent 已生成的产物；后端不运行构建。真实 Vite/浏览器验收另由 site-smoke 脚本驱动。
    await cp(path.join(projectDirectory!, "public"), path.join(projectDirectory!, "dist"), { recursive: true });
    await writeFile(path.join(projectDirectory!, "dist/index.html"), '<!doctype html><html><body><script type="module" src="./game.js"></script></body></html>');
    await writeFile(path.join(projectDirectory!, "dist/game.js"), 'document.body.dataset.game="running";');
    const site = data(await call("submit_game", { nodeId, requestId: "site-publish", expectedInputHash: read.inputHash, projectId: prepared.projectId }));
    expect(site, JSON.stringify(site)).toMatchObject({ ok: true, state: { activeBuildId: site.buildId } });
    const sitePreview = data(await call("preview_game", { nodeId, buildId: site.buildId }));
    expect(JSON.stringify(sitePreview).length).toBeLessThan(4096);
    const entry = await fetch(base + sitePreview.entryUrl);
    expect(entry.status).toBe(200);
    expect(entry.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    const proxiedEntry = await fetch(base + sitePreview.entryUrl, { headers: { "x-forwarded-host": "localhost:5173" } });
    expect(proxiedEntry.headers.get("content-security-policy")).toContain(`localhost:5173/api/extensions/game-furnace/site/${sitePreview.sessionId}/`);
    expect(proxiedEntry.headers.get("content-security-policy")).not.toContain(new URL(base).host);
    const script = await fetch(new URL("game.js", base + sitePreview.entryUrl));
    expect(script.headers.get("access-control-allow-origin")).toBe("*");
    expect(await script.text()).toContain('dataset.game="running"');
    const asset = await fetch(new URL("assets/res-reference.txt", base + sitePreview.entryUrl), { headers: { range: "bytes=0-2" } });
    expect(asset.status).toBe(206); expect((await asset.arrayBuffer()).byteLength).toBe(3);
    expect((await fetch(new URL("missing.js", base + sitePreview.entryUrl))).status).toBe(404);
    expect((await fetch(base + sitePreview.entryUrl.replace(sitePreview.sessionId, "0".repeat(64)))).status).toBe(404);
    const plane = service.modules().application.plugins();
    const rejectedDisable = await plane.write({ extensionId: "game-furnace", expectedRevision: plane.snapshot().revision, enabled: false, values: {}, secretRefs: [], actor: "test" });
    expect(rejectedDisable).toMatchObject({ ok: false, code: "config-invalid" });
    await plane.reconcile();
    expect((await rpc("tools/list", {})).tools.map((t: { name: string }) => t.name)).toContain("submit_game");
    await plane.write({ extensionId: "game-furnace", expectedRevision: plane.snapshot().revision, enabled: true, values: {}, secretRefs: [], actor: "test" });
    await plane.reconcile();
    const restored = data(await call("get_game_furnace", { nodeId }));
    expect(restored).toMatchObject({ ok: true, state: { activeBuildId: site.buildId } });
    const reopened = data(await call("preview_game", { nodeId, buildId: submitted.buildId }));
    expect(await (await fetch(base + reopened.entryUrl)).text()).toContain("requestAnimationFrame");
    expect(service.modules().application.plugins().workLease("game-furnace")!.activeWorkCount()).toBe(0);

    // 实际 Canvas clipboard 规划器 → 权威 Yjs submit → MCP 打开/编辑/试玩。
    const sourceSnapshot = (await service.modules().canvas.sync!.registry.resolve("c"))!.exportCanvas();
    if (!sourceSnapshot.ok) throw Error(sourceSnapshot.message);
    const payload = buildCanvasCopyPayload(sourceSnapshot.canvas, [nodeId])!;
    for (const targetCanvasId of ["c", "clipboard-target"]) {
      if (targetCanvasId !== "c") await canvas.createCanvas({ canvasId: targetCanvasId });
      const targetRoom = (await service.modules().canvas.sync!.registry.resolve(targetCanvasId))!;
      const targetSnapshot = targetRoom.exportCanvas();
      if (!targetSnapshot.ok) throw Error(targetSnapshot.message);
      const plan = planCanvasPaste({ canvas: targetSnapshot.canvas, payload, anchor: { kind: "point", position: { x: 500, y: 100 } },
        viewport: { x: 0, y: 0, zoom: 1 }, createId: (prefix, index) => `${prefix}-${targetCanvasId}-${index}` })!;
      expect(await targetRoom.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: targetCanvasId, baseRevision: targetSnapshot.canvas.revision,
        actorId: "local-dev", commandId: `paste-${targetCanvasId}`, commands: plan.commands })).toMatchObject({ ok: true });
      const copyId = plan.newNodeIds[0]!;
      const copy = data(await call("get_game_furnace", { canvasId: targetCanvasId, nodeId: copyId }));
      expect(copy, JSON.stringify(copy)).toMatchObject({ ok: true });
      expect(copy.projectStorageKey).not.toBe(restored.projectStorageKey);
      expect(copy.state.projectId).not.toBe(restored.state.projectId);
      expect(copy.state.activeBuildId).not.toBe(site.buildId);
      expect(copy.state.latestGenerationId).toBeUndefined();
      expect(copy.state.generations.every((generation: any) => generation.executionDetached && !generation.workId)).toBe(true);
      const copiedPreview = data(await call("preview_game", { canvasId: targetCanvasId, nodeId: copyId, buildId: copy.state.activeBuildId }));
      expect(copiedPreview.ok).toBe(true);
      expect(await (await fetch(new URL("game.js", base + copiedPreview.entryUrl))).text()).toContain('dataset.game="running"');
      const editedCopy = data(await call("update_game_furnace", { canvasId: targetCanvasId, nodeId: copyId, requestId: `copy-edit-${targetCanvasId}`,
        expectedInputHash: copy.inputHash, requirements: { gameplay: "仅修改复制项" } }));
      expect(editedCopy, JSON.stringify(editedCopy)).toMatchObject({ ok: true, state: { requirements: { gameplay: "仅修改复制项" } } });
      const reloadedCopy = data(await call("get_game_furnace", { canvasId: targetCanvasId, nodeId: copyId }));
      expect(reloadedCopy.state).toEqual(editedCopy.state);
    }
    expect(data(await call("get_game_furnace", { nodeId })).state).toEqual(restored.state);

    // Actual authoritative node association undo/redo in the same backend process.
    const historyRoom = (await service.modules().canvas.sync!.registry.resolve("c"))!;
    const historyBefore = historyRoom.exportCanvas();
    if (!historyBefore.ok) throw Error(historyBefore.message);
    const historyKey = historyBefore.canvas.nodeData[nodeId]!.projectStorageKey as string;
    const historyEdit = data(await call("update_game_furnace", { nodeId, requestId: "history-edit", expectedInputHash: restored.inputHash,
      requirements: { gameplay: "历史恢复测试的新玩法" } }));
    const historyAfter = historyRoom.exportCanvas();
    if (!historyAfter.ok) throw Error(historyAfter.message);
    const editedKey = historyAfter.canvas.nodeData[nodeId]!.projectStorageKey as string;
    for (const [requestId, projectStorageKey, expected] of [
      ["history-undo", historyKey, restored.state], ["history-redo", editedKey, historyEdit.state], ["history-back", historyKey, restored.state]
    ] as const) {
      const current = historyRoom.exportCanvas();
      if (!current.ok) throw Error(current.message);
      expect(await historyRoom.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "c", baseRevision: current.canvas.revision,
        actorId: "local-dev", commandId: requestId, commands: [{ type: "nodeData.patch", nodeId, value: { projectStorageKey } }] })).toMatchObject({ ok: true });
      expect(data(await call("get_game_furnace", { nodeId })).state).toEqual(expected);
    }
    const historyPreview = data(await call("preview_game", { nodeId, buildId: submitted.buildId }));
    expect(await (await fetch(base + historyPreview.entryUrl)).text()).toContain("requestAnimationFrame");

    // 从真实 canonical Canvas 导出完整引用；只复制该清单里的 Media 对象到独立存储。
    const snapshot = (await service.modules().canvas.sync!.registry.resolve("c"))!.exportCanvas();
    if (!snapshot.ok) throw Error(snapshot.message);
    const extensionArchiveDefinitions = [gameFurnaceArchiveDefinition];
    const publishedRepository = new SqliteYjsRepository({ path: path.join(dir, "canvas.sqlite"), readOnly: true });
    const exporter = new CanvasArchiveService({ repository: service.modules().canvas.composition!.repository,
      publishedReader: createPublishedReader(publishedRepository), mediaStorage, extensionArchiveDefinitions });
    const archive = await exporter.exportArchive(["c"]).finally(() => publishedRepository.close());
    expect(archive.canvases[0]!.canvas.nodeData).toEqual(snapshot.canvas.nodeData);
    expect((await exporter.verifyArchive(archive, { verifyMedia: true })).ok).toBe(true);
    const references = archive.canvases[0]!.mediaReferences!;
    expect(references.map(ref => ref.storageKey)).toContain(site.projectStorageKey);
    expect(references.map(ref => ref.storageKey)).toEqual(expect.arrayContaining(site.state.builds.flatMap((build: any) => [build.sourceAssetId, build.manifestAssetId])));
    const recoveredObjects = new Map(references.map(ref => [ref.storageKey, structuredClone(objects.get(ref.storageKey)!)]));
    const recoveredStorage = storageFor(recoveredObjects);
    const restoredDir = path.join(dir, "restored");
    mkdirSync(restoredDir);
    const offlineLegacy = new SqliteCanvasRepository({ path: path.join(restoredDir, "canvas.sqlite") });
    const offlineYjs = new SqliteYjsRepository({ path: path.join(restoredDir, "canvas.sqlite") });
    try {
      const importer = new CanvasArchiveService({ repository: offlineLegacy,
        mediaStorage: recoveredStorage, extensionArchiveDefinitions,
        publishedReader: createPublishedReader(offlineYjs), publication: createYjsArchivePublication(offlineYjs) });
      // 演练只恢复数据库、漏掉静态文件：必须在发布 Canvas 前失败。
      const fileKey = references.find(ref => ref.contentType.includes("javascript"))!.storageKey;
      const file = recoveredObjects.get(fileKey)!;
      recoveredObjects.delete(fileKey);
      await expect(importer.importArchive(archive, { verifyMedia: true })).rejects.toThrow(/媒体引用|COS/);
      expect(await offlineLegacy.getCanvas("c")).toBeNull();
      recoveredObjects.set(fileKey, file);
      await importer.importArchive(archive, { verifyMedia: true });
      // Existing authoritative state must be replaced before starting any room writer.
      const stale = structuredClone(archive.canvases[0]!.canvas);
      stale.document.nodes = [];
      stale.nodeData = {};
      const staleDoc = serverCanvasToYDoc(stale);
      try {
        await offlineYjs.replaceArchiveState("c", { state: { canvasId: "c", formatVersion: YJS_CANVAS_FORMAT_VERSION,
          roomEpoch: "pre-restore", checkpoint: Y.encodeStateAsUpdate(staleDoc), checkpointSeq: 0,
          updates: [], storageSeq: 0, projection: stale, createdAt: stale.updatedAt, updatedAt: stale.updatedAt },
          revision: stale.revision, commands: [] });
      } finally { staleDoc.destroy(); }
      expect((await createPublishedReader(offlineYjs).loadPublished("c"))!.document.nodes).toHaveLength(0);
      await importer.importArchive(archive, { replace: true, verifyMedia: true });
      expect((await createPublishedReader(offlineYjs).loadPublished("c"))!.nodeData[nodeId]).toEqual(snapshot.canvas.nodeData[nodeId]);
    } finally { offlineYjs.close(); offlineLegacy.close(); }
    const restoredService = await createBackendService({ env: {
      WOOHAA3_AGENT_LOOPBACK_MODE: "1", WOOHAA3_MCP_DEVELOPMENT_PRINCIPAL: "local-dev",
      WOOHAA3_TASK_STORE_PATH: path.join(restoredDir, "task.sqlite"),
      WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite", WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: path.join(restoredDir, "canvas.sqlite"),
      WOOHAA3_APPLICATION_STORE_PATH: path.join(restoredDir, "application.sqlite")
    }, logger: () => {}, enableYjsSync: true, modelsConfig: { version: 1, models: [] }, mediaStorage: recoveredStorage });
    const restoredServer = http.createServer((req, res) => void restoredService.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }));
    try {
      await restoredService.modules().application.plugins().reconcile();
      await new Promise<void>(resolve => restoredServer.listen(0, "127.0.0.1", resolve));
      const restoredBase = `http://127.0.0.1:${(restoredServer.address() as { port: number }).port}`;
      const recoveredCall = async (name: string, args: Record<string, unknown>) => data(await rpc("tools/call", { name, arguments: { canvasId: "c", nodeId, ...args } }, {}, restoredBase));
      expect(await recoveredCall("get_game_furnace", {})).toMatchObject({ ok: true, state: { activeBuildId: site.buildId } });
      const recoveredPreview = await recoveredCall("preview_game", { buildId: site.buildId });
      expect(recoveredPreview.ok).toBe(true);
      expect(await (await fetch(new URL("game.js", restoredBase + recoveredPreview.entryUrl))).text()).toContain('dataset.game="running"');
      expect(await (await fetch(new URL("assets/res-reference.txt", restoredBase + recoveredPreview.entryUrl))).text()).toBe("收集金币");
      const oldPreview = await recoveredCall("preview_game", { buildId: submitted.buildId });
      expect(await (await fetch(restoredBase + oldPreview.entryUrl)).text()).toContain("requestAnimationFrame");
    } finally {
      if (restoredServer.listening) await new Promise<void>(resolve => restoredServer.close(() => resolve()));
      await restoredService.close();
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await service.close();
    if (projectDirectory) rmSync(projectDirectory, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
