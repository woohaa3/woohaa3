/**
 * 同类型节点合并（change: 2026-10-27-merge-same-type-node-history，任务 3.2 / 3.3）。
 *
 * 覆盖：单批次切换 + 删除、entryId 按目标重算、同身份去重、失败补偿、容量淘汰、
 * 模型摆放显式写回（含 null）、operationId 幂等与参数复用拒绝、拒绝矩阵。
 */
import { describe, expect, it } from "vitest";
import {
  applyCanvasCommands,
  createEmptyWoohaa3ServerCanvas,
  DEFAULT_MODEL_PLACEMENT,
  hashModelScript,
  nodeHistoryContentIdentity,
  nodeHistoryEntryId,
  NODE_GENERATION_HISTORY_VERSION,
  type NodeGenerationHistoryEntry,
  type ServerCanvas
} from "@woohaa3/contracts";
import { InMemoryNodeHistoryRepository } from "./in-memory-node-history-repository.js";
import { NodeHistoryApplicationService } from "./node-history-service.js";
import { currentIdentityOf } from "./node-history-service/current-state.js";
import type { NodeHistoryRoomPort } from "./node-history-service/types.js";

const NOW = "2026-10-27T00:00:00.000Z";
const CANVAS = "canvas-merge";

type Submitted = { commandId: string; commands: readonly unknown[] };

function applyCommands(canvas: ServerCanvas, commands: readonly unknown[]): { canvas: ServerCanvas } | { error: string } {
  const applied = applyCanvasCommands(canvas, commands as never, { now: NOW });
  if (!applied.ok) return { error: `${applied.rejection.code}: ${applied.rejection.message}` };
  return { canvas: { ...applied.canvas, revision: canvas.revision + 1 } };
}

/**
 * 带 durable 命令记录的 room 假实现（与真实 room 的幂等/派生语义一致）。
 */
function fakeRoom(canvas: ServerCanvas, options: { rejectWith?: string } = {}) {
  let current = canvas;
  const records = new Map<string, { revision: number; modelBatch?: { submissionHash: string; nodes: [] } }>();
  const submitted: Submitted[] = [];
  let rejectWith = options.rejectWith;
  const room = {
    get canvas() {
      return current;
    },
    submitted,
    setReject(code: string | null) {
      rejectWith = code ?? undefined;
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
        if (input.expectedModelBatchHash !== undefined && prior.modelBatch?.submissionHash !== input.expectedModelBatchHash) {
          return { ok: false as const, code: "request-id-reused", message: "相同操作身份使用了不同参数" };
        }
        return { ok: true as const, status: "duplicate" as const, revision: prior.revision, noop: true };
      }
      const derived = (await input.derive(current)) as
        | { ok: true; batch: { commandId: string; commands: readonly unknown[] }; modelBatch?: { submissionHash: string; nodes: [] } }
        | { ok: false; code: string; message: string };
      if (!derived.ok) return derived;
      if (rejectWith) return { ok: false as const, code: rejectWith, message: "注入的提交失败" };
      const applied = applyCommands(current, derived.batch.commands);
      if ("error" in applied) return { ok: false as const, code: "rejected", message: applied.error };
      current = applied.canvas;
      records.set(input.commandId, {
        revision: current.revision,
        ...(derived.modelBatch ? { modelBatch: derived.modelBatch } : {})
      });
      submitted.push({ commandId: derived.batch.commandId, commands: derived.batch.commands });
      return { ok: true as const, status: "accepted" as const, revision: current.revision, noop: false };
    },
    async submit(batch: { commandId: string; commands: readonly unknown[] }) {
      const prior = records.get(batch.commandId);
      if (prior) return { ok: true as const, status: "duplicate" as const, revision: prior.revision, noop: true };
      if (rejectWith) return { ok: false as const, code: rejectWith, message: "注入的提交失败" };
      const applied = applyCommands(current, batch.commands);
      if ("error" in applied) return { ok: false as const, code: "rejected", message: applied.error };
      current = applied.canvas;
      records.set(batch.commandId, { revision: current.revision });
      submitted.push({ commandId: batch.commandId, commands: batch.commands });
      return { ok: true as const, status: "accepted" as const, revision: current.revision, noop: false };
    }
  };
  return room as typeof room & NodeHistoryRoomPort;
}

function textNode(id: string, text: string): { node: unknown; data: Record<string, unknown> } {
  return {
    node: { id, type: "text", position: { x: 0, y: 0 }, width: 196, height: 64 },
    data: { title: id, result: { kind: "text", text } }
  };
}

function imageNode(id: string, outputAssetId?: string): { node: unknown; data: Record<string, unknown> } {
  return {
    node: { id, type: "image", position: { x: 0, y: 0 }, width: 260, height: 195 },
    data: { title: id, ...(outputAssetId ? { outputAssetId } : {}) }
  };
}

function imageAsset(id: string, storageKey: string) {
  return {
    id,
    title: `${id}.png`,
    mediaKind: "image",
    source: "uploaded",
    status: "ready",
    url: `/api/media/${storageKey}`,
    metadata: { storageKey, checksum: storageKey, contentType: "image/png", size: 1 },
    createdAt: NOW
  };
}

function imageCanvas(nodes: Array<{ node: unknown; data: Record<string, unknown> }>, assets: unknown[]) {
  const base = canvasWith(nodes);
  return { ...base, assets } as unknown as ServerCanvas;
}

function canvasWith(nodes: Array<{ node: unknown; data: Record<string, unknown> }>): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas(CANVAS, NOW);
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: nodes.map((entry) => entry.node) as never },
    nodeData: Object.fromEntries(nodes.map((entry) => [(entry.node as { id: string }).id, entry.data]))
  } as ServerCanvas;
}

function modelNode(id: string, script: string, placement: Record<string, number | Record<string, number>> | null) {
  return {
    node: { id, type: "model3d", position: { x: 0, y: 0 }, width: 248, height: 232 },
    data: {
      title: id,
      modelScript: script,
      modelScriptLanguage: "javascript",
      modelScriptVersion: "woohaa-model-js-v2",
      modelContentVersion: { revision: 1, sourceHash: hashModelScript(script), contentHash: `${id}-content` },
      ...(placement ? { modelPlacement: placement } : {})
    }
  };
}

function setup(canvas: ServerCanvas, options: Parameters<typeof fakeRoom>[1] & { editSession?: boolean } = {}) {
  const repository = new InMemoryNodeHistoryRepository();
  const room = fakeRoom(canvas, options);
  const service = new NodeHistoryApplicationService({
    repository,
    resolveRoom: async (canvasId) => (canvasId === CANVAS ? room : null),
    ...(options.editSession ? { hasActiveEditSession: async () => true } : {})
  });
  return { repository, room, service };
}

function textHistoryEntry(nodeId: string, runId: string, text: string, createdAt = NOW): NodeGenerationHistoryEntry {
  const identity = { kind: "task-run" as const, runId };
  return {
    version: NODE_GENERATION_HISTORY_VERSION,
    entryId: nodeHistoryEntryId({ canvasId: CANVAS, nodeId, identity }),
    canvasId: CANVAS,
    nodeId,
    kind: "text",
    createdAt,
    sourceIdentity: `task-run:${runId}`,
    currentIdentity: nodeHistoryContentIdentity({ kind: "text", text }),
    recoverable: true,
    previewable: true,
    source: { label: "生成", runId },
    payload: { kind: "text", text }
  };
}

describe("同类型节点合并", () => {
  it("单批次切换目标内容并删除来源，历史按目标重算 entryId 复制", async () => {
    const canvas = canvasWith([
      textNode("source", "source-current"),
      textNode("target", "target-current")
    ]);
    const { repository, room, service } = setup(canvas);
    const oldEntry = textHistoryEntry("source", "run-old", "old-version", "2026-10-27T00:00:01.000Z");
    await repository.insert(oldEntry);
    await repository.insert(textHistoryEntry("source", "run-current", "source-current", "2026-10-27T00:00:02.000Z"));
    await repository.insert(textHistoryEntry("target", "run-target", "target-current", "2026-10-27T00:00:03.000Z"));

    const outcome = await service.mergeNodeHistory({
      canvasId: CANVAS, targetNodeId: "target", sourceNodeId: "source", operationId: "op-1"
    });
    expect(outcome).toMatchObject({
      ok: true, targetNodeId: "target", sourceNodeId: "source",
      copied: 2, duplicates: 0, evicted: 0, alreadyMerged: false
    });

    // 单批次：patch 在前、remove 在后；带 expectedNodeData CAS。
    expect(room.submitted).toHaveLength(1);
    const commands = room.submitted[0]!.commands as Array<Record<string, unknown>>;
    expect(commands.at(-1)).toEqual({ type: "node.remove", nodeIds: ["source"] });
    const patch = commands.find((command) => command.type === "nodeData.patch") as {
      nodeId: string;
      value: Record<string, unknown>;
      expectedNodeData: Record<string, unknown>;
    };
    expect(patch.nodeId).toBe("target");
    expect(patch.value.result).toEqual({ kind: "text", text: "source-current" });
    expect(Object.keys(patch.expectedNodeData).sort()).toEqual(["source", "target"]);

    // 画布：来源删除，目标内容切换到来源当前版本。
    expect(room.canvas.document.nodes.map((node) => node.id)).toEqual(["target"]);
    expect((room.canvas.nodeData.target as { result: { text: string } }).result.text).toBe("source-current");

    // 历史：来源清空，目标保留自身 + 来源两条（payload/createdAt/source 原样，entryId 重算）。
    expect(await repository.listForNode(CANVAS, "source")).toHaveLength(0);
    const targetEntries = await repository.listForNode(CANVAS, "target");
    expect(targetEntries).toHaveLength(3);
    const copied = targetEntries.find((entry) => entry.payload.kind === "text" && entry.payload.text === "old-version")!;
    expect(copied.nodeId).toBe("target");
    expect(copied.createdAt).toBe("2026-10-27T00:00:01.000Z");
    expect(copied.payload).toEqual({ kind: "text", text: "old-version" });
    expect(copied.sourceIdentity).toBe(`local-operation:merge:op-1:${oldEntry.entryId}`);
    expect(copied.entryId).toBe(nodeHistoryEntryId({
      canvasId: CANVAS,
      nodeId: "target",
      identity: { kind: "local-operation", operationId: `merge:op-1:${oldEntry.entryId}` }
    }));
    expect(outcome.ok && outcome.revision).toBe(room.canvas.revision);
  });

  it("同一 operationId 重试返回首次回执且不重复写入", async () => {
    const canvas = canvasWith([textNode("source", "source-current"), textNode("target", "target-current")]);
    const { repository, room, service } = setup(canvas);
    await repository.insert(textHistoryEntry("source", "run-current", "source-current"));
    await service.mergeNodeHistory({ canvasId: CANVAS, targetNodeId: "target", sourceNodeId: "source", operationId: "op-1" });
    const firstCount = (await repository.listForNode(CANVAS, "target")).length;
    const firstRevision = room.canvas.revision;

    const retry = await service.mergeNodeHistory({
      canvasId: CANVAS, targetNodeId: "target", sourceNodeId: "source", operationId: "op-1"
    });
    expect(retry).toMatchObject({ ok: true, alreadyMerged: true, copied: 0, duplicates: 0, revision: firstRevision });
    expect(await repository.listForNode(CANVAS, "target")).toHaveLength(firstCount);
    expect(room.submitted).toHaveLength(1);
  });

  it("同一 operationId 复用不同参数被拒绝", async () => {
    const canvas = canvasWith([
      textNode("source", "source-current"),
      textNode("other", "other-current"),
      textNode("target", "target-current")
    ]);
    const { repository, service } = setup(canvas);
    await repository.insert(textHistoryEntry("source", "run-current", "source-current"));
    await service.mergeNodeHistory({ canvasId: CANVAS, targetNodeId: "target", sourceNodeId: "source", operationId: "op-1" });

    const reused = await service.mergeNodeHistory({
      canvasId: CANVAS, targetNodeId: "target", sourceNodeId: "other", operationId: "op-1"
    });
    expect(reused).toMatchObject({ ok: false, code: "conflict" });
    // 其它节点与历史都未变。
    expect(await repository.listForNode(CANVAS, "other")).toHaveLength(0);
  });

  it("两边内容 identity 相同也保留两条版本，不按内容去重", async () => {
    const canvas = canvasWith([textNode("source", "source-current"), textNode("target", "target-current")]);
    const { repository, service } = setup(canvas);
    await repository.insert(textHistoryEntry("source", "run-shared", "shared", "2026-10-27T00:00:01.000Z"));
    await repository.insert(textHistoryEntry("source", "run-current", "source-current", "2026-10-27T00:00:02.000Z"));
    // 目标已有内容相同的版本；合并必须保留它，并再追加来源的同内容版本。
    await repository.insert(textHistoryEntry("target", "run-shared", "shared"));

    const outcome = await service.mergeNodeHistory({
      canvasId: CANVAS, targetNodeId: "target", sourceNodeId: "source", operationId: "op-dedup"
    });
    expect(outcome).toMatchObject({ ok: true, copied: 2, duplicates: 0 });
    const targetEntries = await repository.listForNode(CANVAS, "target");
    expect(targetEntries).toHaveLength(3);
    expect(targetEntries.filter((entry) => entry.payload.kind === "text" && entry.payload.text === "shared"))
      .toHaveLength(2);
  });

  it("画布批次失败时补偿删除本次复制的条目并保留来源", async () => {
    const canvas = canvasWith([textNode("source", "source-current"), textNode("target", "target-current")]);
    const { repository, room, service } = setup(canvas);
    await repository.insert(textHistoryEntry("source", "run-old", "old-version"));
    await repository.insert(textHistoryEntry("source", "run-current", "source-current"));
    await repository.insert(textHistoryEntry("target", "run-target", "target-current"));
    room.setReject("conflict");

    const outcome = await service.mergeNodeHistory({
      canvasId: CANVAS, targetNodeId: "target", sourceNodeId: "source", operationId: "op-fail"
    });
    expect(outcome).toMatchObject({ ok: false, code: "conflict" });
    // 目标历史只剩自身条目；来源历史完整；两个节点都在。
    expect((await repository.listForNode(CANVAS, "target")).map((entry) => entry.sourceIdentity))
      .toEqual(["task-run:run-target"]);
    expect(await repository.listForNode(CANVAS, "source")).toHaveLength(2);
    expect(room.canvas.document.nodes.map((node) => node.id).sort()).toEqual(["source", "target"]);
    expect((room.canvas.nodeData.target as { result: { text: string } }).result.text).toBe("target-current");
  });

  it("合并后超过单节点上限时按最旧淘汰非当前版本并保护来源当前版本", async () => {
    const canvas = canvasWith([textNode("source", "source-current"), textNode("target", "target-current")]);
    const { repository, service } = setup(canvas);
    // 目标已有 50 条（上限），均不是当前内容；合并再复制 1 条即触发淘汰。
    for (let index = 0; index < 50; index += 1) {
      await repository.insert(textHistoryEntry(
        "target", `bulk-${index}`, `bulk-${index}`, `2026-10-26T00:00:${String(index).padStart(2, "0")}.000Z`
      ));
    }
    await repository.insert(textHistoryEntry("source", "run-current", "source-current"));

    const outcome = await service.mergeNodeHistory({
      canvasId: CANVAS, targetNodeId: "target", sourceNodeId: "source", operationId: "op-capacity"
    });
    expect(outcome).toMatchObject({ ok: true, copied: 1, evicted: 1 });
    const entries = await repository.listForNode(CANVAS, "target");
    expect(entries).toHaveLength(50);
    expect(entries.some((entry) => entry.payload.kind === "text" && entry.payload.text === "source-current")).toBe(true);
    // 最旧的一条被淘汰，当前版本始终保留。
    expect(entries.some((entry) => entry.payload.kind === "text" && entry.payload.text === "bulk-0")).toBe(false);
  });

  it("模型合并显式写回来源摆放，使目标当前身份等于来源", async () => {
    const sourcePlacement = { offset: { x: 1, y: 2, z: 3 }, scale: 2, yaw: 0.5 };
    const targetPlacement = { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 };
    const canvas = canvasWith([
      modelNode("source", "build(source)", sourcePlacement),
      modelNode("target", "build(target)", targetPlacement)
    ]);
    const { room, service } = setup(canvas);
    // 以模型编辑版本登记来源当前内容（带摆放）。
    await service.registerModelEdit({
      canvasId: CANVAS, nodeId: "source", sourceHash: hashModelScript("build(source)"),
      modelScript: "build(source)", language: "javascript", version: "woohaa-model-js-v2",
      placement: sourcePlacement, createdAt: NOW
    });
    const expectedSourceIdentity = currentIdentityOf(canvas, "source", "model");

    const outcome = await service.mergeNodeHistory({
      canvasId: CANVAS, targetNodeId: "target", sourceNodeId: "source", operationId: "op-model"
    });
    expect(outcome).toMatchObject({ ok: true });
    const targetData = room.canvas.nodeData.target as { modelScript: string; modelPlacement: unknown };
    expect(targetData.modelScript).toBe("build(source)");
    expect(targetData.modelPlacement).toEqual(sourcePlacement);
    expect(currentIdentityOf(room.canvas, "target", "model")).toBe(expectedSourceIdentity);
  });

  it("来源没有摆放时同批显式写 null，由 reducers 归一化为等价默认摆放", async () => {
    const canvas = canvasWith([
      modelNode("source", "build(source)", null),
      modelNode("target", "build(target)", { offset: { x: 4, y: 5, z: 6 }, scale: 3, yaw: 1 })
    ]);
    const { repository, room, service } = setup(canvas);
    await service.registerModelScript({
      canvasId: CANVAS, nodeId: "source", sourceHash: hashModelScript("build(source)"),
      modelScript: "build(source)", language: "javascript", version: "woohaa-model-js-v2", createdAt: NOW
    });

    // 模型 patch 的权威归一会把显式 null 写成默认摆放（零偏移、单位缩放、无旋转），
    // 与来源「没有摆放」在渲染与内容上等价；摆放字段本身仍显式参与同批写入。
    const outcome = await service.mergeNodeHistory({
      canvasId: CANVAS, targetNodeId: "target", sourceNodeId: "source", operationId: "op-model-null"
    });
    expect(outcome).toMatchObject({ ok: true });
    const patch = room.submitted[0]!.commands.find((command) =>
      (command as { type?: string }).type === "nodeData.patch"
    ) as { value: Record<string, unknown> };
    expect(Object.prototype.hasOwnProperty.call(patch.value, "modelPlacement")).toBe(true);
    const targetData = room.canvas.nodeData.target as { modelScript: string; modelPlacement: unknown };
    expect(targetData.modelScript).toBe("build(source)");
    expect(targetData.modelPlacement).toEqual(DEFAULT_MODEL_PLACEMENT);
    // 来源的缺摆放版本被原样复制到目标历史。
    const copied = (await repository.listForNode(CANVAS, "target"))
      .find((entry) => entry.payload.kind === "model" && entry.payload.modelScript === "build(source)");
    expect(copied?.payload).toMatchObject({ kind: "model", modelScript: "build(source)" });
    expect((copied?.payload as { placement?: unknown }).placement).toBeUndefined();
  });

  it("拒绝矩阵：类型不同、进行中生成、未结算会话、无当前版本、托管节点", async () => {
    const mixed = canvasWith([
      { node: { id: "source", type: "image", position: { x: 0, y: 0 } }, data: {} },
      textNode("target", "target-current")
    ]);
    expect(await setup(mixed).service.mergeNodeHistory({
      canvasId: CANVAS, targetNodeId: "target", sourceNodeId: "source", operationId: "op-a"
    })).toMatchObject({ ok: false, code: "invalid-node-type" });

    const generating = canvasWith([
      { node: { id: "source", type: "text", position: { x: 0, y: 0 } }, data: { taskStatus: "processing" } },
      textNode("target", "target-current")
    ]);
    expect(await setup(generating).service.mergeNodeHistory({
      canvasId: CANVAS, targetNodeId: "target", sourceNodeId: "source", operationId: "op-b"
    })).toMatchObject({ ok: false, code: "conflict" });

    const plain = canvasWith([textNode("source", "source-current"), textNode("target", "target-current")]);
    expect(await setup(plain, { editSession: true }).service.mergeNodeHistory({
      canvasId: CANVAS, targetNodeId: "target", sourceNodeId: "source", operationId: "op-c"
    })).toMatchObject({ ok: false, code: "conflict" });

    // 来源当前内容没有任何匹配条目。
    expect(await setup(plain).service.mergeNodeHistory({
      canvasId: CANVAS, targetNodeId: "target", sourceNodeId: "source", operationId: "op-d"
    })).toMatchObject({ ok: false, code: "no-current-version" });

    const managed = canvasWith([
      {
        node: { id: "source", type: "text", position: { x: 0, y: 0 } },
        data: { managedBy: { schemaVersion: 1, extensionId: "film-set", ownerNodeId: "set", entityId: "e", lifecycle: "owner-managed" } }
      },
      textNode("target", "target-current")
    ]);
    const managedSetup = setup(managed);
    await managedSetup.repository.insert(textHistoryEntry("source", "run-current", "source-current"));
    expect(await managedSetup.service.mergeNodeHistory({
      canvasId: CANVAS, targetNodeId: "target", sourceNodeId: "source", operationId: "op-e"
    })).toMatchObject({ ok: false, code: "invalid-node-type" });
  });

  it("来源当前版本媒体不可恢复时拒绝且不复制历史", async () => {
    const base = canvasWith([
      { node: { id: "source", type: "image", position: { x: 0, y: 0 } }, data: { outputAssetId: "asset-1" } },
      { node: { id: "target", type: "image", position: { x: 300, y: 0 } }, data: {} }
    ]);
    const canvas = {
      ...base,
      assets: [{ id: "asset-1", metadata: { storageKey: "missing-key" } }]
    } as unknown as ServerCanvas;
    const repository = new InMemoryNodeHistoryRepository();
    const room = fakeRoom(canvas);
    const service = new NodeHistoryApplicationService({
      repository,
      resolveRoom: async () => room,
      mediaVerifier: { exists: async () => false }
    });
    const entry: NodeGenerationHistoryEntry = {
      ...textHistoryEntry("source", "run-media", "unused"),
      kind: "image",
      sourceIdentity: "task-run:run-media",
      currentIdentity: "media:missing-key",
      payload: { kind: "image", storageKey: "missing-key", checksum: "c", contentType: "image/png", size: 1 }
    };
    await repository.insert(entry);

    const outcome = await service.mergeNodeHistory({
      canvasId: CANVAS, targetNodeId: "target", sourceNodeId: "source", operationId: "op-media"
    });
    expect(outcome).toMatchObject({ ok: false, code: "unrecoverable" });
    expect(await repository.listForNode(CANVAS, "target")).toHaveLength(0);
    expect(room.submitted).toHaveLength(0);
  });

  it("期望当前身份不一致时拒绝（并发保护）", async () => {
    const canvas = canvasWith([textNode("source", "source-current"), textNode("target", "target-current")]);
    const { repository, service } = setup(canvas);
    await repository.insert(textHistoryEntry("source", "run-current", "source-current"));
    const outcome = await service.mergeNodeHistory({
      canvasId: CANVAS, targetNodeId: "target", sourceNodeId: "source", operationId: "op-expect",
      expectedSourceCurrentIdentity: "text:stale"
    });
    expect(outcome).toMatchObject({ ok: false, code: "conflict" });
  });

  it("来源图片有当前输出但无历史时先补登 image-baseline 再合并", async () => {
    const canvas = imageCanvas(
      [imageNode("source", "asset-1"), imageNode("target", "asset-2")],
      [imageAsset("asset-1", "image-key-1"), imageAsset("asset-2", "image-key-2")]
    );
    const { repository, room, service } = setup(canvas);

    const outcome = await service.mergeNodeHistory({
      canvasId: CANVAS, targetNodeId: "target", sourceNodeId: "source", operationId: "op-image-backfill"
    });
    expect(outcome).toMatchObject({ ok: true, copied: 1, duplicates: 0 });
    expect(room.canvas.document.nodes.map((node) => node.id)).toEqual(["target"]);
    const targetAssetId = (room.canvas.nodeData.target as { outputAssetId: string }).outputAssetId;
    const targetAsset = room.canvas.assets.find((asset) => asset.id === targetAssetId);
    expect((targetAsset?.metadata as { storageKey?: string } | undefined)?.storageKey).toBe("image-key-1");
    expect(await repository.listForNode(CANVAS, "source")).toHaveLength(0);
    const targetEntries = await repository.listForNode(CANVAS, "target");
    // 目标原来的图片（image-key-2）也必须先留档，不能因为目标没有历史就丢失。
    expect(targetEntries).toHaveLength(2);
    expect(targetEntries.some((entry) =>
      entry.sourceIdentity === "image-baseline:image-key-2"
      && entry.currentIdentity === "media:image-key-2"
    )).toBe(true);
    const copied = targetEntries.find((entry) =>
      entry.sourceIdentity.startsWith("local-operation:merge:op-image-backfill:")
    );
    expect(copied).toMatchObject({
      recoverable: true,
      previewable: true,
      currentIdentity: "media:image-key-1"
    });
    expect(currentIdentityOf(room.canvas, "target", "image")).toBe(copied!.currentIdentity);
  });

  it("两个图片内容完全相同也保留两条当前版本", async () => {
    const canvas = imageCanvas(
      [imageNode("source", "asset-1"), imageNode("target", "asset-1")],
      [imageAsset("asset-1", "image-key-1")]
    );
    const { repository, room, service } = setup(canvas);
    // 两边各自先有一条当前版本（模拟历史面板里都只有一个版本）。
    await service.backfillCurrentImageHistory(CANVAS);
    expect(await repository.listForNode(CANVAS, "source")).toHaveLength(1);
    expect(await repository.listForNode(CANVAS, "target")).toHaveLength(1);

    const outcome = await service.mergeNodeHistory({
      canvasId: CANVAS, targetNodeId: "target", sourceNodeId: "source", operationId: "op-same-image"
    });
    expect(outcome).toMatchObject({ ok: true, copied: 1, duplicates: 0 });
    const targetEntries = await repository.listForNode(CANVAS, "target");
    expect(targetEntries).toHaveLength(2);
    expect(targetEntries.filter((entry) => entry.currentIdentity === "media:image-key-1")).toHaveLength(2);
    expect(room.canvas.document.nodes.map((node) => node.id)).toEqual(["target"]);
  });

  it("两个导入图片都没有历史且内容相同，合并后仍保留两条当前版本", async () => {
    // 真实导入路径：两个节点都只有当前资产，从未登记历史。合并前来源与目标都必须
    // 补登各自当前输出，不能只补来源（否则目标原图会被合并覆盖而消失）。
    const canvas = imageCanvas(
      [imageNode("source", "asset-1"), imageNode("target", "asset-1")],
      [imageAsset("asset-1", "image-key-1")]
    );
    const { repository, room, service } = setup(canvas);
    expect(await repository.listForNode(CANVAS, "source")).toHaveLength(0);
    expect(await repository.listForNode(CANVAS, "target")).toHaveLength(0);

    const outcome = await service.mergeNodeHistory({
      canvasId: CANVAS, targetNodeId: "target", sourceNodeId: "source", operationId: "op-same-import"
    });
    expect(outcome).toMatchObject({ ok: true, copied: 1, duplicates: 0 });
    const targetEntries = await repository.listForNode(CANVAS, "target");
    expect(targetEntries).toHaveLength(2);
    expect(targetEntries.filter((entry) => entry.currentIdentity === "media:image-key-1")).toHaveLength(2);
    const sourceIdentities = targetEntries.map((entry) => entry.sourceIdentity);
    expect(sourceIdentities).toContain("image-baseline:image-key-1");
    expect(sourceIdentities.filter((identity) =>
      identity.startsWith("local-operation:merge:op-same-import:")
    )).toHaveLength(1);
    expect(room.canvas.document.nodes.map((node) => node.id)).toEqual(["target"]);
  });

  it("图片补给：只补已显示输出、幂等且不推进画布修订", async () => {
    const canvas = imageCanvas(
      [imageNode("img", "asset-1"), imageNode("empty")],
      [imageAsset("asset-1", "image-key-1")]
    );
    const { repository, room, service } = setup(canvas);

    const first = await service.backfillCurrentImageHistory(CANVAS);
    expect(first.inserted).toEqual(["img"]);
    expect(first.duplicates).toEqual([]);
    expect(first.skipped).toEqual([{ nodeId: "empty", reason: "no-output" }]);
    const entries = await repository.listForNode(CANVAS, "img");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sourceIdentity: "image-baseline:image-key-1",
      currentIdentity: "media:image-key-1",
      recoverable: true,
      previewable: true
    });
    expect(room.canvas.revision).toBe(1);

    const second = await service.backfillCurrentImageHistory(CANVAS);
    expect(second.inserted).toEqual([]);
    expect(second.duplicates).toEqual(["img"]);
    expect(await repository.listForNode(CANVAS, "img")).toHaveLength(1);
    expect(room.canvas.revision).toBe(1);
  });

  it("图片补给跳过不可解析的媒体，不制造假版本", async () => {
    const canvas = imageCanvas([imageNode("img", "asset-1")], [imageAsset("asset-1", "image-key-1")]);
    const repository = new InMemoryNodeHistoryRepository();
    const room = fakeRoom(canvas);
    const service = new NodeHistoryApplicationService({
      repository,
      resolveRoom: async () => room,
      mediaVerifier: { exists: async () => false }
    });

    const result = await service.backfillCurrentImageHistory(CANVAS);
    expect(result.inserted).toEqual([]);
    expect(result.skipped).toEqual([{ nodeId: "img", reason: "unresolvable" }]);
    expect(await repository.listForNode(CANVAS, "img")).toHaveLength(0);
  });
});
