/**
 * 模型历史缩略图作业测试
 * （change: add-canvas-node-generation-history，任务 2.4 / design D5）。
 *
 * 覆盖：只从权威历史脚本执行（不接受浏览器源码/Scene IR）、按 sourceHash 缓存命中、
 * 失败只影响单项且缓存受预算约束。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, executeModelScriptVersioned, sceneIrVersionFor, type ServerCanvas } from "@woohaa3/contracts";
import { InMemoryNodeHistoryRepository } from "../storage/core/in-memory-node-history-repository.js";
import { NodeHistoryApplicationService } from "../storage/core/node-history-service.js";
import type { NodeHistoryRoomPort } from "../storage/core/node-history-service.js";
import { NodeHistoryThumbnailJob } from "./node-history-thumbnail.js";
import { createRenderCache, type RendererClient } from "./index.js";

const NOW = "2026-09-27T00:00:00.000Z";
const CANVAS = "canvas-1";
const SCRIPT = "scene.box({ id: 'body', size: [1, 2, 1], color: '#ff0000' });";

function fakeRoom(canvas: ServerCanvas): NodeHistoryRoomPort {
  return {
    exportCanvas: () => ({ ok: true as const, canvas }),
    async submit() {
      return { ok: true as const, status: "accepted" as const, revision: canvas.revision, noop: false };
    }
  };
}

function canvasWithNode(): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas(CANVAS, NOW);
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [{ id: "node-1", type: "model3d", position: { x: 0, y: 0 } }] },
    nodeData: { "node-1": { title: "模型" } }
  };
}

async function setup() {
  const repository = new InMemoryNodeHistoryRepository();
  const service = new NodeHistoryApplicationService({ repository, resolveRoom: async () => fakeRoom(canvasWithNode()) });
  const { entryId } = await service.registerModelScript({
    canvasId: CANVAS, nodeId: "node-1", sourceHash: "hash-a",
    modelScript: SCRIPT, language: "javascript", version: "woohaa-model-js-v2", createdAt: NOW
  });
  return { service, entryId };
}

function renderer(): { client: RendererClient; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      render: async () => {
        calls += 1;
        return { ok: true, png: Buffer.from([1, 2, 3, 4]), renderVersion: "woohaa-model-render-v1" };
      },
      available: () => true,
      close: async () => undefined
    }
  };
}

describe("NodeHistoryThumbnailJob", () => {
  it("从权威历史脚本执行并缓存（同 source 不再创建 renderer 作业）", async () => {
    const { service, entryId } = await setup();
    const { client, calls } = renderer();
    const job = new NodeHistoryThumbnailJob({ service, rendererClient: client, scriptExecutor: { executeSync: (source, version) => syncExecute(source, version) } });
    const first = await job.render({ canvasId: CANVAS, nodeId: "node-1", entryId });
    expect(first.ok).toBe(true);
    expect(calls()).toBe(1);
    const second = await job.render({ canvasId: CANVAS, nodeId: "node-1", entryId });
    expect(second.ok && second.cached).toBe(true);
    expect(calls()).toBe(1);
  });

  it("依赖失败不缓存，恢复后重试权威历史并缓存成功结果", async () => {
    const { service, entryId } = await setup();
    const recovered = renderer();
    let unavailable = true;
    const client: RendererClient = {
      ...recovered.client,
      render: async request => unavailable
        ? { ok: false, code: "renderer-unavailable", message: "not ready" }
        : recovered.client.render(request)
    };
    const job = new NodeHistoryThumbnailJob({ service, rendererClient: client,
      scriptExecutor: { executeSync: (source, version) => syncExecute(source, version) } });
    const input = { canvasId: CANVAS, nodeId: "node-1", entryId };
    expect(await job.render(input)).toMatchObject({ ok: false, code: "renderer-unavailable" });
    expect(job.cacheSize().entries).toBe(0);
    expect((await service.getDetail(input)).kind).toBe("model");
    unavailable = false;
    expect(await job.render(input)).toMatchObject({ ok: true, cached: false });
    expect(await job.render(input)).toMatchObject({ ok: true, cached: true });
    expect(recovered.calls()).toBe(1);
  });

  it("模型脚本不可执行时失败但不阻止详情/恢复", async () => {
    const { service, entryId } = await setup();
    const { client, calls } = renderer();
    const job = new NodeHistoryThumbnailJob({
      service,
      rendererClient: client,
      scriptExecutor: { executeSync: () => ({ ok: false, stage: "execute", code: "runtime-error", message: "boom" }) }
    });
    const result = await job.render({ canvasId: CANVAS, nodeId: "node-1", entryId });
    expect(result.ok).toBe(false);
    expect(calls()).toBe(0);
    // 详情仍可用。
    const detail = await service.getDetail({ canvasId: CANVAS, nodeId: "node-1", entryId });
    expect(detail.kind).toBe("model");
  });

  it("缓存受字节预算约束（超预算淘汰）", async () => {
    const { service, entryId } = await setup();
    const { client } = renderer();
    const cache = createRenderCache({ maxBytes: 8 });
    const job = new NodeHistoryThumbnailJob({
      service,
      rendererClient: client,
      cache,
      capture: { width: 64, height: 64 },
      scriptExecutor: { executeSync: (source, version) => syncExecute(source, version) }
    });
    await job.render({ canvasId: CANVAS, nodeId: "node-1", entryId });
    expect(job.cacheSize().bytes).toBeLessThanOrEqual(8);
  });
});

/** 用共享 executor 生成确定性 Scene IR（避免 worker 开销）。 */
function syncExecute(source: string, version: unknown) {
  const result = executeModelScriptVersioned(source, version);
  if (!result.ok) return result;
  return {
    ok: true as const,
    version: version as import("@woohaa3/contracts").SupportedModelScriptVersion,
    sceneVersion: sceneIrVersionFor(version as never),
    ops: result.scene.ops,
    json: result.json,
    sourceHash: "hash"
  };
}
