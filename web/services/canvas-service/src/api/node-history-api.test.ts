/**
 * 节点生成历史 HTTP API 契约测试
 * （change: add-canvas-node-generation-history，任务 1.3 / 1.4 / 5.1）。
 *
 * 真实 HTTP server：画布授权、列表安全 metadata、详情、cursor 分页、越权枚举、
 * 恢复冲突与幂等。
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, decideAppPathMount, type ServerCanvas } from "@woohaa3/contracts";
import { InMemoryNodeHistoryRepository } from "../storage/core/in-memory-node-history-repository.js";
import { NodeHistoryApplicationService } from "../storage/core/node-history-service.js";
import { createNodeHistoryRequestHandler, DEFAULT_NODE_HISTORY_API_BASE_PATH, type NodeHistoryRequestHandlerOptions } from "./node-history-api.js";
import type { CanvasRoom } from "../sync/index.js";

const NOW = "2026-09-27T00:00:00.000Z";
const CANVAS = "canvas-1";
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function fakeRoom(canvas: ServerCanvas): CanvasRoom & { canvas: ServerCanvas } {
  let current = canvas;
  // durable 回执（与真实 room 的幂等语义一致）：合并的重试依赖 submissionHash。
  const records = new Map<string, { revision: number; modelBatch?: { submissionHash: string } }>();
  type Applied = { ok: true; revision: number } | { ok: false; code: string; message: string };
  const apply = async (
    commandId: string,
    commands: readonly unknown[],
    modelBatch?: { submissionHash: string }
  ): Promise<Applied> => {
    const { applyCanvasCommands } = await import("@woohaa3/contracts");
    const applied = applyCanvasCommands(current, commands as never, { now: NOW });
    if (!applied.ok) return { ok: false, code: applied.rejection.code, message: applied.rejection.message };
    current = { ...applied.canvas, revision: current.revision + 1 };
    records.set(commandId, { revision: current.revision, ...(modelBatch ? { modelBatch } : {}) });
    return { ok: true, revision: current.revision };
  };
  return {
    get canvas() {
      return current;
    },
    exportCanvas: () => ({ ok: true as const, canvas: current }),
    async lookupCommand(commandId: string) {
      return records.get(commandId) ?? null;
    },
    async submitDerived(input: {
      commandId: string;
      expectedModelBatchHash?: string;
      derive: (canvas: ServerCanvas) => Promise<unknown> | unknown;
    }) {
      const prior = records.get(input.commandId);
      if (prior) {
        if (input.expectedModelBatchHash !== undefined
          && prior.modelBatch?.submissionHash !== input.expectedModelBatchHash) {
          return { ok: false as const, code: "request-id-reused", message: "相同操作身份使用了不同参数" };
        }
        return { ok: true as const, status: "duplicate" as const, revision: prior.revision, noop: true };
      }
      const derived = (await input.derive(current)) as
        | { ok: true; batch: { commands: readonly unknown[] }; modelBatch?: { submissionHash: string } }
        | { ok: false; code: string; message: string };
      if (!derived.ok) return derived;
      const applied = await apply(input.commandId, derived.batch.commands, derived.modelBatch);
      if (!applied.ok) return { ok: false as const, code: applied.code, message: applied.message };
      return { ok: true as const, status: "accepted" as const, revision: applied.revision, noop: false };
    },
    async submit(batch: { commandId: string; commands: readonly unknown[] }) {
      const prior = records.get(batch.commandId);
      if (prior) return { ok: true as const, status: "duplicate" as const, commandId: batch.commandId, revision: prior.revision, noop: true, update: null };
      const applied = await apply(batch.commandId, batch.commands);
      if (!applied.ok) return { ok: false as const, status: "rejected" as const, commandId: batch.commandId, code: applied.code, message: applied.message };
      return { ok: true as const, status: "accepted" as const, commandId: batch.commandId, revision: applied.revision, noop: false, update: null };
    }
  } as unknown as CanvasRoom & { canvas: ServerCanvas };
}

function canvasWithNode(type: string, data: Record<string, unknown> = {}): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas(CANVAS, NOW);
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [{ id: "node-1", type, position: { x: 0, y: 0 }, width: 248, height: 232 }] },
    nodeData: { "node-1": { title: "T", ...data } }
  };
}

function canvasWithTwoTextNodes(sourceType = "text", targetType = "text"): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas(CANVAS, NOW);
  return {
    ...base,
    revision: 1,
    document: {
      ...base.document,
      nodes: [
        { id: "source", type: sourceType, position: { x: 0, y: 0 }, width: 196, height: 64 },
        { id: "target", type: targetType, position: { x: 300, y: 0 }, width: 196, height: 64 }
      ]
    },
    nodeData: {
      source: { title: "来源", result: { kind: "text", text: "source-current" } },
      target: { title: "目标", result: { kind: "text", text: "target-current" } }
    }
  } as ServerCanvas;
}

async function start(canvas: ServerCanvas, overrides: Partial<NodeHistoryRequestHandlerOptions> = {}): Promise<{
  base: string;
  service: NodeHistoryApplicationService;
  room: CanvasRoom & { canvas: ServerCanvas };
}> {
  const repository = new InMemoryNodeHistoryRepository();
  const room = fakeRoom(canvas);
  const service = new NodeHistoryApplicationService({ repository, resolveRoom: async () => room });
  const handler = createNodeHistoryRequestHandler({
    service,
    canvasExists: async (canvasId) => canvasId === CANVAS,
    ...overrides
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
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  closers.push(async () => {
    server.close();
  });
  return { base: `http://127.0.0.1:${port}`, service, room };
}

describe("节点历史 HTTP API", () => {
  it("摘要读取沿用画布权限且只返回安全 metadata", async () => {
    const { base, service } = await start(canvasWithNode("text"));
    await service.registerTaskResult({ canvasId: CANVAS, nodeId: "node-1", runId: "r-summary", kind: "text", createdAt: NOW,
      output: { mediaKind: "text", text: "private full content" } });
    const url = `${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}`;
    const response = await fetch(`${url}/${CANVAS}?summary=true&summaryNodeId=node-1`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].source.runId).toBe("r-summary");
    expect(body.items[0]).not.toHaveProperty("payload");
    expect((await fetch(`${url}/other-canvas?summary=true&summaryNodeId=node-1`)).status).toBe(404);
  });
  it("列表返回安全 metadata 与受控预览引用（不含 storageKey/正文）", async () => {
    const { base, service } = await start(canvasWithNode("image", { prompt: "p" }));
    await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-1", kind: "image", createdAt: NOW,
      output: {
        mediaKind: "image",
        asset: {
          id: "asset-1", title: "生成资产", mediaKind: "image", source: "generated", status: "ready", createdAt: NOW,
          metadata: { storageKey: "sha256-" + "a".repeat(64), checksum: "a".repeat(64), contentType: "image/png", size: 1 }
        }
      }
    });
    const response = await fetch(`${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/${CANVAS}/node-1`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ entryId: string; preview: { kind: string; href: string } }>; nextCursor: string | null };
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("sha256-");
    expect(body.items[0]?.preview.kind).toBe("image");
    expect(body.items[0]?.preview.href).toContain("/preview");
  });

  it.each(["sha256-" + "c".repeat(64), "generation-outputs/" + "c".repeat(64) + ".png"])("预览保留公开挂载前缀与媒体目录：%s", async (storageKey) => {
    const { base, service } = await start(canvasWithNode("image", { prompt: "p" }));
    await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-1", kind: "image", createdAt: NOW,
      output: {
        mediaKind: "image",
        asset: {
          id: "asset-1", title: "生成资产", mediaKind: "image", source: "generated", status: "ready", createdAt: NOW,
          metadata: { storageKey, checksum: "c".repeat(64), contentType: "image/png", size: 1 }
        }
      }
    });
    const entryId = (await service.list({ canvasId: CANVAS, nodeId: "node-1" })).items[0]!.entryId;
    const requestPath = `${DEFAULT_NODE_HISTORY_API_BASE_PATH}/${CANVAS}/node-1/${entryId}/preview`;
    const response = await fetch(`${base}${requestPath}`, { redirect: "manual" });
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    // 服务端只看到逻辑路径；相对 Location 由浏览器在真实挂载前缀下解析。
    expect(location.startsWith("../")).toBe(true);
    const prefixed = new URL(location, `http://host/dev/token${requestPath}`);
    expect(prefixed.pathname).toBe(`/dev/token/api/media/${storageKey}`);
    expect(decideAppPathMount("/dev/token/", prefixed.pathname).action).toBe("forward");
    const rooted = new URL(location, `http://host${requestPath}`);
    expect(rooted.pathname).toBe(`/api/media/${storageKey}`);
  });

  it("cursor 分页稳定返回更旧一页且不重复", async () => {
    const { base, service } = await start(canvasWithNode("text"));
    for (let index = 0; index < 4; index += 1) {
      await service.registerTaskResult({
        canvasId: CANVAS, nodeId: "node-1", runId: `run-${index}`, kind: "text",
        createdAt: `2026-09-2${index}T00:00:00.000Z`,
        output: { mediaKind: "text", text: `v${index}` }
      });
    }
    const first = (await (await fetch(`${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/${CANVAS}/node-1?limit=2`)).json()) as {
      items: Array<{ entryId: string }>; nextCursor: string;
    };
    const second = (await (await fetch(
      `${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/${CANVAS}/node-1?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`
    )).json()) as { items: Array<{ entryId: string }> };
    expect(second.items).toHaveLength(2);
    expect(second.items.map((item) => item.entryId)).not.toEqual(first.items.map((item) => item.entryId));
  });

  it("越权枚举其它画布返回稳定 not-found", async () => {
    const { base, service } = await start(canvasWithNode("text"));
    const { entryId } = await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-1", kind: "text", createdAt: NOW,
      output: { mediaKind: "text", text: "hello" }
    });
    const otherCanvas = await fetch(`${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/other-canvas/node-1`);
    expect(otherCanvas.status).toBe(404);
    const { code } = (await otherCanvas.json()) as { code: string };
    expect(code).toBe("NODE_HISTORY_NOT_FOUND");
    const otherNode = await fetch(`${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/${CANVAS}/other-node/${entryId}`);
    expect(otherNode.status).toBe(404);
  });

  it("详情返回完整正文，恢复成功后当前标记回流", async () => {
    const { base, service, room } = await start(canvasWithNode("text", { prompt: "p" }));
    const { entryId } = await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-1", kind: "text", createdAt: NOW,
      output: { mediaKind: "text", text: "x".repeat(3000) }
    });
    const detail = (await (await fetch(
      `${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/${CANVAS}/node-1/${entryId}`
    )).json()) as { entry: { kind: string; text: string } };
    expect(detail.entry.kind).toBe("text");
    expect(detail.entry.text).toHaveLength(3000);

    const apply = await fetch(`${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/${CANVAS}/node-1/${entryId}/apply`, { method: "POST" });
    expect(apply.status).toBe(200);
    expect(room.canvas.nodeData["node-1"]).toMatchObject({ prompt: "p" });
    const after = (await (await fetch(`${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/${CANVAS}/node-1`)).json()) as {
      items: Array<{ current: boolean }>;
    };
    expect(after.items[0]?.current).toBe(true);
  });

  it("生成中恢复返回 409 conflict", async () => {
    const { base, service } = await start(canvasWithNode("text", { taskStatus: "processing" }));
    const { entryId } = await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-1", kind: "text", createdAt: NOW,
      output: { mediaKind: "text", text: "hello" }
    });
    const response = await fetch(`${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/${CANVAS}/node-1/${entryId}/apply`, { method: "POST" });
    expect(response.status).toBe(409);
  });

  it("画布级列表返回跨节点条目、安全标题与种类计数", async () => {
    const { base, service } = await start(canvasWithNode("text"));
    await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "r1", kind: "text", createdAt: NOW,
      output: { mediaKind: "text", text: "x".repeat(3000) }
    });
    const response = await fetch(`${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/${CANVAS}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ entryId: string; nodeId: string; nodeTitle: string }>;
      kindCounts: Record<string, number>;
      nextCursor: string | null;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ nodeId: "node-1", nodeTitle: "T" });
    expect(body.kindCounts).toEqual({ text: 1, image: 0, video: 0, audio: 0, motion: 0, model: 0 });
    // 安全：不含完整正文。
    expect(JSON.stringify(body)).not.toContain("x".repeat(1000));
  });

  it("画布级列表支持 kind 筛选与 cursor 分页", async () => {
    const { base, service } = await start(canvasWithNode("text"));
    for (let index = 0; index < 3; index += 1) {
      await service.registerTaskResult({
        canvasId: CANVAS, nodeId: "node-1", runId: `run-${index}`, kind: "text",
        createdAt: `2026-09-2${index}T00:00:00.000Z`,
        output: { mediaKind: "text", text: `v${index}` }
      });
    }
    const filtered = (await (await fetch(`${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/${CANVAS}?kind=text&limit=2`)).json()) as {
      items: Array<{ kind: string }>; nextCursor: string | null;
    };
    expect(filtered.items).toHaveLength(2);
    expect(filtered.items.every((item) => item.kind === "text")).toBe(true);
    expect(filtered.nextCursor).not.toBeNull();
    const rest = (await (await fetch(
      `${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/${CANVAS}?kind=text&limit=2&cursor=${encodeURIComponent(filtered.nextCursor!)}`
    )).json()) as { items: Array<{ entryId: string }> };
    expect(rest.items).toHaveLength(1);
  });

  it("画布级列表越权/不存在返回稳定 not-found", async () => {
    const { base } = await start(canvasWithNode("text"));
    const response = await fetch(`${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/other-canvas`);
    expect(response.status).toBe(404);
    const { code } = (await response.json()) as { code: string };
    expect(code).toBe("NODE_HISTORY_NOT_FOUND");
  });

  it("画布级路由拒绝非 GET", async () => {
    const { base } = await start(canvasWithNode("text"));
    const response = await fetch(`${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/${CANVAS}`, { method: "POST" });
    expect(response.status).toBe(405);
  });

  describe("清空节点历史", () => {
    async function seed(service: NodeHistoryApplicationService) {
      for (const runId of ["r1", "r2"]) {
        await service.registerTaskResult({
          canvasId: CANVAS, nodeId: "node-1", runId, kind: "text", createdAt: NOW,
          output: { mediaKind: "text", text: runId }
        });
      }
    }

    it("POST clear 返回删除数量并清空列表", async () => {
      const { base, service } = await start(canvasWithNode("text"));
      await seed(service);
      const response = await fetch(`${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/${CANVAS}/node-1/clear`, { method: "POST" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, removed: 2 });
      const list = (await (await fetch(`${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/${CANVAS}/node-1`)).json()) as { items: unknown[] };
      expect(list.items).toHaveLength(0);
    });

    it("clear 不吞掉 entryId 路由：详情仍按三段解析", async () => {
      const { base, service } = await start(canvasWithNode("text"));
      await seed(service);
      const entryId = (await service.list({ canvasId: CANVAS, nodeId: "node-1" })).items[0]!.entryId;
      const detail = await fetch(`${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/${CANVAS}/node-1/${entryId}`);
      expect(detail.status).toBe(200);
    });

    it("clear 拒绝非 POST/DELETE", async () => {
      const { base, service } = await start(canvasWithNode("text"));
      await seed(service);
      const response = await fetch(`${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/${CANVAS}/node-1/clear`);
      expect(response.status).toBe(405);
      // 列表未被清空。
      expect((await service.list({ canvasId: CANVAS, nodeId: "node-1" })).items).toHaveLength(2);
    });

    it("注入 authorizeWrite 时按 write 权限拒绝", async () => {
      const repository = new InMemoryNodeHistoryRepository();
      const room = fakeRoom(canvasWithNode("text"));
      const service = new NodeHistoryApplicationService({ repository, resolveRoom: async () => room });
      await seed(service);
      const handler = createNodeHistoryRequestHandler({
        service,
        canvasExists: async () => true,
        authorizeWrite: async () => ({ ok: false, status: 403, code: "FORBIDDEN", message: "无权修改该画布" })
      });
      const server = http.createServer((req, res) => { void handler(req, res); });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      closers.push(async () => { server.close(); });
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const response = await fetch(`http://127.0.0.1:${port}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/${CANVAS}/node-1/clear`, { method: "POST" });
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe("FORBIDDEN");
      expect((await service.list({ canvasId: CANVAS, nodeId: "node-1" })).items).toHaveLength(2);
    });

    it("未知画布与未知节点返回稳定 not-found", async () => {
      const { base } = await start(canvasWithNode("text"));
      const unknownCanvas = await fetch(`${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/other/node-1/clear`, { method: "POST" });
      expect(unknownCanvas.status).toBe(404);
      const unknownNode = await fetch(`${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/${CANVAS}/missing/clear`, { method: "POST" });
      expect(unknownNode.status).toBe(404);
    });
  });

  describe("同类型节点合并", () => {
    const mergePath = `${DEFAULT_NODE_HISTORY_API_BASE_PATH}/${CANVAS}/target/merge`;

    async function seedSource(service: NodeHistoryApplicationService) {
      await service.registerTaskResult({
        canvasId: CANVAS, nodeId: "source", runId: "run-s", kind: "text", createdAt: NOW,
        output: { mediaKind: "text", text: "source-current" }
      });
    }

    it("POST merge 复制来源历史、切换目标内容并删除来源节点", async () => {
      const { base, service, room } = await start(canvasWithTwoTextNodes());
      await seedSource(service);
      const response = await fetch(`${base}${mergePath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceNodeId: "source", operationId: "op-route-1" })
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true, targetNodeId: "target", sourceNodeId: "source",
        copied: 1, duplicates: 0, evicted: 0, alreadyMerged: false
      });
      // 画布：来源删除、目标承载来源当前版本。
      expect(room.canvas.document.nodes.map((node) => node.id)).toEqual(["target"]);
      expect((room.canvas.nodeData.target as { result: { text: string } }).result.text).toBe("source-current");
      // 历史：来源清空，目标含来源条目。
      const targetList = (await (await fetch(`${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/${CANVAS}/target`)).json()) as {
        items: Array<{ entryId: string }>;
      };
      expect(targetList.items.length).toBeGreaterThanOrEqual(1);
    });

    it("同一 operationId 重试返回首次回执", async () => {
      const { base, service } = await start(canvasWithTwoTextNodes());
      await seedSource(service);
      const body = JSON.stringify({ sourceNodeId: "source", operationId: "op-route-retry" });
      const first = await fetch(`${base}${mergePath}`, { method: "POST", body });
      expect(first.status).toBe(200);
      const retry = await fetch(`${base}${mergePath}`, { method: "POST", body });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ ok: true, alreadyMerged: true, copied: 0 });
    });

    it("写权限被拒绝时不读取或写入任何状态", async () => {
      const { base, service, room } = await start(canvasWithTwoTextNodes(), {
        authorizeWrite: async () => ({ ok: false, status: 403, code: "FORBIDDEN", message: "无权修改该画布" })
      });
      await seedSource(service);
      const response = await fetch(`${base}${mergePath}`, {
        method: "POST",
        body: JSON.stringify({ sourceNodeId: "source", operationId: "op-route-denied" })
      });
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe("FORBIDDEN");
      expect(room.canvas.document.nodes.map((node) => node.id).sort()).toEqual(["source", "target"]);
      expect((await service.list({ canvasId: CANVAS, nodeId: "source" })).items).toHaveLength(1);
    });

    it("类型不同返回 400", async () => {
      const { base } = await start(canvasWithTwoTextNodes("image"));
      const response = await fetch(`${base}${mergePath}`, {
        method: "POST",
        body: JSON.stringify({ sourceNodeId: "source", operationId: "op-route-type" })
      });
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("NODE_HISTORY_INVALID");
    });

    it("类型不匹配或并发修改返回 409", async () => {
      const { base, service } = await start(canvasWithTwoTextNodes());
      await seedSource(service);
      const response = await fetch(`${base}${mergePath}`, {
        method: "POST",
        body: JSON.stringify({
          sourceNodeId: "source", operationId: "op-route-conflict",
          expectedSourceCurrentIdentity: "text:stale"
        })
      });
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("NODE_HISTORY_CONFLICT");
    });

    it("来源没有当前版本时返回 409 且不复制历史", async () => {
      const { base, service } = await start(canvasWithTwoTextNodes());
      const response = await fetch(`${base}${mergePath}`, {
        method: "POST",
        body: JSON.stringify({ sourceNodeId: "source", operationId: "op-route-unrecoverable" })
      });
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("NODE_HISTORY_UNRECOVERABLE");
      expect((await service.list({ canvasId: CANVAS, nodeId: "target" })).items).toHaveLength(0);
    });

    it("缺 body 或非法 JSON 返回 400 且不写历史", async () => {
      const { base, service } = await start(canvasWithTwoTextNodes());
      await seedSource(service);
      const missing = await fetch(`${base}${mergePath}`, { method: "POST" });
      expect(missing.status).toBe(400);
      const malformed = await fetch(`${base}${mergePath}`, { method: "POST", body: "{not-json" });
      expect(malformed.status).toBe(400);
      expect((await service.list({ canvasId: CANVAS, nodeId: "target" })).items).toHaveLength(0);
    });

    it("非 POST 返回 405", async () => {
      const { base } = await start(canvasWithTwoTextNodes());
      expect((await fetch(`${base}${mergePath}`)).status).toBe(405);
    });

    it("未知画布返回稳定 not-found", async () => {
      const { base } = await start(canvasWithTwoTextNodes());
      const response = await fetch(`${base}${DEFAULT_NODE_HISTORY_API_BASE_PATH}/other/target/merge`, {
        method: "POST",
        body: JSON.stringify({ sourceNodeId: "source", operationId: "op-route-other" })
      });
      expect(response.status).toBe(404);
      expect((await response.json()).code).toBe("NODE_HISTORY_NOT_FOUND");
    });
  });
});
