/**
 * 节点生成历史集成验收
 * （change: add-canvas-node-generation-history，任务 5.1）。
 *
 * 覆盖：跨存储部分完成 + reconciliation、并发新版本、容量清理、active generation
 * conflict、以及「成功终态先登记历史再 latest-run-wins」。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type StoredAsset, type ServerCanvas } from "@woohaa3/contracts";
import { InMemoryNodeHistoryRepository } from "./in-memory-node-history-repository.js";
import { NodeHistoryApplicationService } from "./node-history-service.js";
import { CanvasRoom, InMemoryYjsDocumentRepository } from "../../sync/index.js";

const NOW = "2026-09-27T00:00:00.000Z";
const CANVAS = "canvas-1";

function fakeRoom(canvas: ServerCanvas): CanvasRoom & { canvas: ServerCanvas } {
  let current = canvas;
  return {
    get canvas() {
      return current;
    },
    exportCanvas: () => ({ ok: true as const, canvas: current }),
    async submit(batch: { commands: readonly unknown[] }) {
      const { applyCanvasCommands } = await import("@woohaa3/contracts");
      const applied = applyCanvasCommands(current, batch.commands as never, { now: NOW });
      if (!applied.ok) return { ok: false as const, status: "rejected" as const, commandId: "x", code: applied.rejection.code, message: applied.rejection.message };
      current = { ...applied.canvas, revision: current.revision + 1 };
      return { ok: true as const, status: "accepted" as const, commandId: "x", revision: current.revision, noop: false, update: null };
    }
  } as unknown as CanvasRoom & { canvas: ServerCanvas };
}

function canvasWithNode(type: string, data: Record<string, unknown> = {}): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas(CANVAS, NOW);
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [{ id: "node-1", type, position: { x: 0, y: 0 } }] },
    nodeData: { "node-1": { title: "T", ...data } }
  };
}

function imageAsset(key: string): StoredAsset {
  return {
    id: "asset-1", title: "生成资产", mediaKind: "image", source: "generated", status: "ready", createdAt: NOW,
    metadata: { storageKey: key, checksum: key.slice(7), contentType: "image/png", size: 1 }
  };
}

describe("节点生成历史集成验收（任务 5.1）", () => {
  it("真实 room 反复应用两个版本时不会被旧恢复回执吞掉", async () => {
    const room = new CanvasRoom({ canvasId: CANVAS, repository: new InMemoryYjsDocumentRepository(), now: () => NOW });
    try {
      await room.initialize({ canvas: canvasWithNode("image", { prompt: "保留提示词" }), roomEpoch: "history-repeat", createdAt: NOW });
      const service = new NodeHistoryApplicationService({ repository: new InMemoryNodeHistoryRepository(), resolveRoom: async () => room });
      const entries = [];
      for (const digit of ["a", "b"]) {
        entries.push(await service.registerTaskResult({
          canvasId: CANVAS, nodeId: "node-1", runId: `run-${digit}`, kind: "image", createdAt: NOW,
          output: { mediaKind: "image", asset: imageAsset(`sha256-${digit.repeat(64)}`) }
        }));
      }
      for (const entryId of [entries[0]!.entryId, entries[1]!.entryId, entries[0]!.entryId, entries[1]!.entryId, entries[0]!.entryId]) {
        const before = room.exportCanvas();
        expect(before.ok).toBe(true);
        const restored = await service.restore({ canvasId: CANVAS, nodeId: "node-1", entryId });
        expect(restored.ok).toBe(true);
        const current = room.exportCanvas();
        expect(current.ok).toBe(true);
        if (!before.ok || !current.ok) return;
        expect(current.canvas.revision).toBe(before.canvas.revision + 1);
        expect(current.canvas.nodeData["node-1"].prompt).toBe("保留提示词");
        expect((await service.list({ canvasId: CANVAS, nodeId: "node-1" })).items.find(item => item.entryId === entryId)?.current).toBe(true);
        const again = await service.restore({ canvasId: CANVAS, nodeId: "node-1", entryId });
        expect(again).toMatchObject({ ok: true, alreadyCurrent: true, revision: current.canvas.revision });
      }
    } finally {
      room.dispose();
    }
  });

  it("真实 room：恢复产物的 provenance.runId 经 Y.Doc 往返仍保留（change: l0-generation-provenance）", async () => {
    const room = new CanvasRoom({ canvasId: CANVAS, repository: new InMemoryYjsDocumentRepository(), now: () => NOW });
    try {
      await room.initialize({ canvas: canvasWithNode("image"), roomEpoch: "history-provenance", createdAt: NOW });
      const repository = new InMemoryNodeHistoryRepository();
      const service = new NodeHistoryApplicationService({ repository, resolveRoom: async () => room });
      const { entryId } = await service.registerTaskResult({
        canvasId: CANVAS, nodeId: "node-1", runId: "run-1", taskKey: "task-key-1",
        modelKey: "litellm:gpt-image-2", jobId: "job-1", kind: "image", createdAt: NOW,
        output: { mediaKind: "image", asset: imageAsset("sha256-" + "a".repeat(64)) }
      });
      const restored = await service.restore({ canvasId: CANVAS, nodeId: "node-1", entryId });
      expect(restored.ok).toBe(true);

      const exported = room.exportCanvas();
      expect(exported.ok).toBe(true);
      if (!exported.ok) return;
      const asset = exported.canvas.assets.find(
        (candidate) => candidate.id === exported.canvas.nodeData["node-1"].outputAssetId
      );
      // 经 Y.Doc 落地再导出（走 aggregate 的资产/provenance 白名单）后 runId 仍在。
      expect(asset?.provenance).toEqual({
        taskNodeId: "node-1",
        taskKind: "image-generation",
        outputIndex: 0,
        runId: "run-1"
      });
      // provenance 不带 taskKey/modelId：它们在同一条历史条目的 source 上，由 runId 关联。
      const entry = await repository.get(CANVAS, "node-1", entryId);
      expect(entry?.source).toMatchObject({ runId: "run-1", taskKey: "task-key-1", modelId: "litellm:gpt-image-2" });
    } finally {
      room.dispose();
    }
  });

  it("跨存储部分完成：历史登记成功但 current 节点未变（旧 run 晚到）", async () => {
    const room = fakeRoom(canvasWithNode("image", { activeRunId: "run-2" }));
    const repository = new InMemoryNodeHistoryRepository();
    const service = new NodeHistoryApplicationService({ repository, resolveRoom: async () => room });
    await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-1", kind: "image", createdAt: NOW,
      output: { mediaKind: "image", asset: imageAsset("sha256-" + "a".repeat(64)) }
    });
    const page = await service.list({ canvasId: CANVAS, nodeId: "node-1" });
    expect(page.items).toHaveLength(1);
    // 旧 run 成为历史版本，但当前节点保持 run-2。
    expect(room.canvas.nodeData["node-1"].activeRunId).toBe("run-2");
  });

  it("并发新版本：重复登记同一 run 只产生一个版本", async () => {
    const room = fakeRoom(canvasWithNode("text"));
    const repository = new InMemoryNodeHistoryRepository();
    const service = new NodeHistoryApplicationService({ repository, resolveRoom: async () => room });
    await Promise.all([
      service.registerTaskResult({ canvasId: CANVAS, nodeId: "node-1", runId: "r", kind: "text", createdAt: NOW, output: { mediaKind: "text", text: "a" } }),
      service.registerTaskResult({ canvasId: CANVAS, nodeId: "node-1", runId: "r", kind: "text", createdAt: NOW, output: { mediaKind: "text", text: "a" } })
    ]);
    expect((await repository.canvasStats(CANVAS)).count).toBe(1);
  });

  it("active generation 恢复会切换当前版本并让在途结果变旧", async () => {
    const room = fakeRoom(canvasWithNode("text", { taskStatus: "pending" }));
    const repository = new InMemoryNodeHistoryRepository();
    const service = new NodeHistoryApplicationService({ repository, resolveRoom: async () => room });
    const { entryId } = await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "r", kind: "text", createdAt: NOW, output: { mediaKind: "text", text: "a" }
    });
    const before = room.canvas.revision;
    const outcome = await service.restore({ canvasId: CANVAS, nodeId: "node-1", entryId });
    expect(outcome.ok).toBe(true);
    expect(room.canvas.revision).toBeGreaterThan(before);
    expect(room.canvas.nodeData["node-1"]).toMatchObject({ activeRunId: `history:${entryId}`, taskStatus: "successed" });
  });

  it("容量清理保留当前版本", async () => {
    const repository = new InMemoryNodeHistoryRepository();
    // 先恢复一个条目使其成为 current，再灌满更多版本，确认 current 未被淘汰。
    const currentKey = "sha256-" + "c".repeat(64);
    const room = fakeRoom(canvasWithNode("image", { outputAssetId: "asset-1", resourceKind: "image" }));
    (room.canvas.assets as StoredAsset[]).push(imageAsset(currentKey));
    const service = new NodeHistoryApplicationService({
      repository,
      resolveRoom: async () => room,
      mediaVerifier: { exists: async () => true }
    });
    const current = await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "current", kind: "image", createdAt: "2026-01-01T00:00:00.000Z",
      output: { mediaKind: "image", asset: imageAsset(currentKey) }
    });
    for (let index = 0; index < 60; index += 1) {
      const key = `sha256-${String(index).padStart(64, "a")}`;
      await service.registerTaskResult({
        canvasId: CANVAS, nodeId: "node-1", runId: `run-${index}`, kind: "image",
        createdAt: `2026-02-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
        output: { mediaKind: "image", asset: imageAsset(key) }
      });
    }
    const entries = await repository.listForNode(CANVAS, "node-1");
    expect(entries.length).toBeLessThanOrEqual(50);
    // current 版本仍在（entryId = current.entryId）。
    expect(entries.some((entry) => entry.entryId === current.entryId)).toBe(true);
  });

  it("reconciliation：命令成功但历史登记失败后可由 projector 重试补齐", async () => {
    const room = fakeRoom(canvasWithNode("text"));
    const repository = new InMemoryNodeHistoryRepository();
    let failOnce = true;
    const service = new NodeHistoryApplicationService({
      repository,
      resolveRoom: async () => room
    });
    // 首次登记抛错，模拟跨存储部分完成。
    const originalInsert = repository.insert.bind(repository);
    repository.insert = async (entry) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("injected history write failure");
      }
      return originalInsert(entry);
    };
    await expect(service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "r", kind: "text", createdAt: NOW, output: { mediaKind: "text", text: "a" }
    })).rejects.toThrow();
    // 重试（reconciliation）补齐同一版本。
    await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "r", kind: "text", createdAt: NOW, output: { mediaKind: "text", text: "a" }
    });
    expect((await repository.canvasStats(CANVAS)).count).toBe(1);
  });
});
