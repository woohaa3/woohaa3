/**
 * 编辑完成回执 + 图片/模型编辑完成服务测试
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 2.1–2.7）。
 *
 * 覆盖：内容/历史部分完成、幂等与冲突、无净变化、并发基线、原图基线补存、重启补偿、
 * 纯媒体恢复清除旧定义、模型规范镜头归档。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyCanvasCommands,
  createEmptyWoohaa3ServerCanvas,
  hashModelScript,
  IMAGE_EDIT_DOCUMENT_VERSION,
  newWorldInstance,
  type ImageProjectDocument,
  modelContentIdentity,
  type CanvasCommand,
  type ImageEditDocument,
  type ServerCanvas,
  type StoredAsset
} from "@woohaa3/contracts";
import { InMemoryNodeHistoryRepository } from "./in-memory-node-history-repository.js";
import { NodeHistoryApplicationService } from "./node-history-service.js";
import { EditCompletionService } from "./edit-completion-service.js";
import { InMemoryEditCompletionRepository } from "./in-memory-edit-completion-repository.js";
import { SqliteEditCompletionRepository } from "../sqlite/edit-completion.js";
import type { CanvasRoom } from "../../sync/index.js";

const NOW = "2026-10-08T00:00:00.000Z";
const CANVAS = "canvas-1";
const BASE_KEY = "sha256-" + "a".repeat(64);
const OUT_KEY = "generation-outputs/" + "b".repeat(64) + ".png";
const BASE2_KEY = "sha256-" + "c".repeat(64);

function fakeRoom(canvas: ServerCanvas): CanvasRoom & { canvas: ServerCanvas; submissions: number; setCanvas: (next: ServerCanvas) => void } {
  let current = canvas;
  let submissions = 0;
  const durable = new Map<string, { revision: number }>();
  return {
    get canvas() {
      return current;
    },
    get submissions() {
      return submissions;
    },
    setCanvas(next: ServerCanvas) {
      current = next;
    },
    exportCanvas: () => ({ ok: true as const, canvas: current }),
    lookupCommand: async (id: string) => durable.get(id) ?? null,
    async submit(batch: { commandId: string; commands: readonly unknown[] }) {
      submissions += 1;
      const applied = applyCanvasCommands(current, batch.commands as never, { now: NOW });
      if (!applied.ok) {
        return { ok: false as const, status: "rejected" as const, commandId: "x", code: applied.rejection.code, message: applied.rejection.message };
      }
      current = { ...applied.canvas, revision: current.revision + 1 };
      durable.set(batch.commandId, { revision: current.revision });
      return { ok: true as const, status: "accepted" as const, commandId: "x", revision: current.revision, noop: false, update: null };
    }
  } as unknown as CanvasRoom & { canvas: ServerCanvas; submissions: number; setCanvas: (next: ServerCanvas) => void };
}

function imageCanvas(input: { outputStorageKey?: string; imageEdit?: ImageEditDocument | null; baseAssetId?: string } = {}): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas(CANVAS, NOW);
  const outputStorageKey = input.outputStorageKey ?? BASE_KEY;
  const output: StoredAsset = {
    id: "asset-output",
    title: "图片",
    mediaKind: "image",
    source: "uploaded",
    status: "ready",
    createdAt: NOW,
    metadata: { storageKey: outputStorageKey, checksum: "a".repeat(64), contentType: "image/png", size: 10 }
  };
  const data: Record<string, unknown> = { title: "图", outputAssetId: output.id, taskStatus: "successed" };
  if (input.imageEdit !== undefined) data.imageEdit = input.imageEdit;
  const assets: StoredAsset[] = [output];
  if (input.imageEdit) {
    assets.push({
      id: input.imageEdit.baseAssetId,
      title: "原图",
      mediaKind: "image",
      source: "uploaded",
      status: "ready",
      createdAt: NOW,
      metadata: { storageKey: BASE_KEY, checksum: "a".repeat(64), contentType: "image/png", size: 10 }
    });
  }
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [{ id: "node-1", type: "image", position: { x: 0, y: 0 }, width: 248, height: 232 }] },
    assets,
    nodeData: { "node-1": data }
  } as unknown as ServerCanvas;
}

function modelCanvas(script: string, opts: { placement?: unknown } = {}): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas(CANVAS, NOW);
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [{ id: "node-1", type: "model3d" }] },
    nodeData: {
      "node-1": {
        title: "模型",
        sharedWorldInstance: newWorldInstance("instance-node-1", { x: 0, y: 0 }),
        modelScript: script,
        modelScriptLanguage: "javascript",
        modelScriptVersion: "woohaa-model-js-v2",
        modelContentVersion: { revision: 1, sourceHash: hashModelScript(script), contentHash: "hc" },
        modelPlacement: opts.placement ?? { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
      }
    }
  } as unknown as ServerCanvas;
}

function setup(
  canvas: ServerCanvas,
  options: { mediaExists?: (key: string, scope?: { canvasId?: string }) => boolean; failHistory?: () => boolean } = {}
) {
  const repository = new InMemoryNodeHistoryRepository();
  const completions = new InMemoryEditCompletionRepository();
  const room = fakeRoom(canvas);
  const historyService = new NodeHistoryApplicationService({
    repository,
    resolveRoom: async (canvasId) => (canvasId === CANVAS ? room : null),
    ...(options.mediaExists ? { mediaVerifier: { exists: async (key: string, scope?: { canvasId?: string }) => options.mediaExists!(key, scope) } } : {})
  });
  const publisher = {
    registerEntry: async (entry: Parameters<typeof historyService.registerEntry>[0]) => {
      if (options.failHistory?.()) throw new Error("injected history failure");
      return historyService.registerEntry(entry);
    },
    listEntriesForNode: (canvasId: string, nodeId: string) => historyService.listEntriesForNode(canvasId, nodeId)
  };
  const editService = new EditCompletionService({
    completions,
    publisher,
    resolveRoom: async (canvasId) => (canvasId === CANVAS ? room : null),
    ...(options.mediaExists ? { mediaVerifier: { exists: async (key: string, scope?: { canvasId?: string }) => options.mediaExists!(key, scope) } } : {}),
    now: () => NOW
  });
  return { repository, completions, room, historyService, editService };
}

const editDoc: ImageEditDocument = {
  version: IMAGE_EDIT_DOCUMENT_VERSION,
  baseAssetId: "asset-base",
  sourceWidth: 100,
  sourceHeight: 80,
  shapes: [
    { id: "s1", tool: "pen", color: "#ff3b30", widthInSourcePixels: 2, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] }
  ]
};

function imageComplete(overrides: Partial<{ requestId: string; outputStorageKey: string; imageEdit: ImageEditDocument | undefined; baseline: string; baseStorageKey: string }> = {}) {
  return {
    canvasId: CANVAS,
    nodeId: "node-1",
    sessionId: "session-1",
    requestId: overrides.requestId ?? "req-1",
    kind: "image" as const,
    baselineContentIdentity: overrides.baseline ?? `media:${BASE_KEY}`,
    media: {
      baseAssetId: "asset-base",
      baseStorageKey: overrides.baseStorageKey ?? BASE_KEY,
      sourceWidth: 100,
      sourceHeight: 80,
      outputAssetId: "asset-out",
      outputStorageKey: overrides.outputStorageKey ?? OUT_KEY,
      checksum: "b".repeat(64),
      contentType: "image/png",
      size: 20,
      baseChecksum: "a".repeat(64),
      baseContentType: "image/png",
      baseSize: 10,
      ...(overrides.imageEdit !== undefined ? { imageEdit: overrides.imageEdit } : { imageEdit: editDoc })
    }
  };
}

describe("编辑完成 repository", () => {
  it("内存 adapter 幂等 upsert、按状态扫描与删除生命周期", async () => {
    const repo = new InMemoryEditCompletionRepository();
    const record = {
      canvasId: CANVAS,
      nodeId: "n",
      sessionId: "s",
      requestId: "r",
      kind: "image" as const,
      payloadFingerprint: "fp",
      baselineContentIdentity: "media:x",
      status: "prepared" as const,
      contentIdentity: "media:x",
      entryId: null,
      revision: 1,
      contentCommitted: false,
      pendingEntries: [],
      createdAt: NOW,
      updatedAt: NOW
    };
    await repo.put(record);
    await repo.put({ ...record, status: "history-pending", updatedAt: NOW });
    expect((await repo.get(CANVAS, "n", "r"))?.status).toBe("history-pending");
    expect(await repo.listByStatus("history-pending", 10)).toHaveLength(1);
    await repo.deleteNode(CANVAS, "n");
    expect(await repo.get(CANVAS, "n", "r")).toBeNull();
  });

  it("SQLite adapter 迁移可重复执行并持久化回执", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "edit-completion-"));
    const dbPath = path.join(dir, "canvas.db");
    const first = new SqliteEditCompletionRepository({ path: dbPath, now: () => NOW });
    await first.put({
      canvasId: CANVAS, nodeId: "n", sessionId: "s", requestId: "r", kind: "image",
      payloadFingerprint: "fp", baselineContentIdentity: "media:x", status: "history-pending",
      contentIdentity: "media:y", entryId: "e1", revision: 2, contentCommitted: true,
      pendingEntries: [], createdAt: NOW, updatedAt: NOW
    });
    first.close();
    // 再次打开（重复迁移）应保留数据且不报错。
    const second = new SqliteEditCompletionRepository({ path: dbPath, now: () => NOW });
    const record = await second.get(CANVAS, "n", "r");
    expect(record?.status).toBe("history-pending");
    expect(await second.listByStatus("history-pending", 10)).toHaveLength(1);
    second.close();
  });

  it("SQLite prepared 扫描排除空 begin、模型和终态回执，并在重开后保留固定历史", async () => {
    const { editService, completions } = setup(imageCanvas(), { failHistory: () => true });
    await editService.complete(imageComplete());
    const frozen = (await completions.get(CANVAS, "node-1", "req-1"))!;
    expect(frozen.pendingEntries.length).toBeGreaterThan(0);
    const dir = mkdtempSync(path.join(tmpdir(), "edit-completion-prepared-"));
    const dbPath = path.join(dir, "canvas.db");
    const repository = new SqliteEditCompletionRepository({ path: dbPath, now: () => NOW });
    try {
      for (let index = 0; index < 120; index++) {
        await repository.put({ ...frozen, requestId: `begin:${index}`, status: "prepared", pendingEntries: [], updatedAt: "2026-10-01T00:00:00.000Z" });
      }
      await repository.put({ ...frozen, requestId: "prepared-model", status: "prepared", kind: "model" });
      await repository.put({ ...frozen, requestId: "completed", status: "completed" });
      await repository.put({ ...frozen, requestId: "prepared-image", status: "prepared" });
      expect(await repository.listPreparedImages(1)).toMatchObject([{ requestId: "prepared-image", pendingEntries: frozen.pendingEntries }]);
      expect(await repository.listPreparedImages(0)).toEqual([]);
    } finally { repository.close(); }
    const reopened = new SqliteEditCompletionRepository({ path: dbPath, now: () => NOW });
    try {
      expect(await reopened.listPreparedImages(100)).toMatchObject([{ requestId: "prepared-image", pendingEntries: frozen.pendingEntries }]);
    } finally { reopened.close(); }
  });

});

describe("图片编辑完成", () => {
  it("提交后出现原图基线 + 一个最终编辑版本，且重复完成不追加", async () => {
    const { editService, historyService, room } = setup(imageCanvas());
    const first = await editService.complete(imageComplete());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.receipt.status).toBe("completed");
    expect(first.receipt.contentCommitted).toBe(true);
    const revisionsAfterFirst = room.canvas.revision;

    const entries = await historyService.listEntriesForNode(CANVAS, "node-1");
    expect(entries.some((entry) => entry.sourceIdentity.startsWith("image-baseline:"))).toBe(true);
    expect(entries.filter((entry) => entry.sourceIdentity.startsWith("image-edit:"))).toHaveLength(1);

    // 重复完成：同 requestId 同 payload 返回既有结果，不追加 revision/版本。
    const second = await editService.complete(imageComplete());
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.receipt.entryId).toBe(first.receipt.entryId);
    expect(room.canvas.revision).toBe(revisionsAfterFirst);
    const after = await historyService.listEntriesForNode(CANVAS, "node-1");
    expect(after.filter((entry) => entry.sourceIdentity.startsWith("image-edit:"))).toHaveLength(1);
  });

  it("同 requestId 不同 payload 返回稳定冲突", async () => {
    const { editService } = setup(imageCanvas());
    await editService.complete(imageComplete());
    const conflict = await editService.complete(imageComplete({ outputStorageKey: "generation-outputs/" + "c".repeat(64) + ".png" }));
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe("EDIT_SESSION_REQUEST_CONFLICT");
  });

  it("历史登记失败时保持 history-pending，补偿后补齐同一版本", async () => {
    let failing = true;
    const { editService, historyService } = setup(imageCanvas(), { failHistory: () => failing });
    const result = await editService.complete(imageComplete());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.status).toBe("history-pending");
    expect(result.receipt.contentCommitted).toBe(true);
    expect(await historyService.listEntriesForNode(CANVAS, "node-1")).toHaveLength(0);
    // 恢复历史存储后补偿。
    failing = false;
    const compensated = await editService.processPending();
    expect(compensated.completed).toBe(1);
    const status = await editService.status({ canvasId: CANVAS, nodeId: "node-1", requestId: "req-1" });
    expect(status.ok && status.receipt.status).toBe("completed");
    expect((await historyService.listEntriesForNode(CANVAS, "node-1")).length).toBeGreaterThan(0);
  });

  it("内容基线被其它写入替换时拒绝并保留（不静默覆盖）", async () => {
    const { editService, room } = setup(imageCanvas());
    // begin 捕获基线。
    await editService.begin({
      canvasId: CANVAS, nodeId: "node-1", sessionId: "session-x", requestId: "begin:session-x",
      kind: "image", baselineContentIdentity: `media:${BASE_KEY}`
    });
    // 模拟远端写入替换节点输出。
    const patched = applyCanvasCommands(room.canvas, [
      { type: "asset.upsert", asset: { id: "asset-other", title: "o", mediaKind: "image", source: "generated", status: "ready", createdAt: NOW, metadata: { storageKey: BASE2_KEY, checksum: "c".repeat(64), contentType: "image/png", size: 1 } } },
      { type: "nodeData.patch", nodeId: "node-1", value: { outputAssetId: "asset-other" } }
    ] as CanvasCommand[], { now: NOW });
    expect(patched.ok).toBe(true);
    if (patched.ok) (room as unknown as { setCanvas: (next: ServerCanvas) => void }).setCanvas({ ...patched.canvas, revision: 2 });
    const result = await editService.complete({
      ...imageComplete({ requestId: "req-2" }),
      sessionId: "session-x"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("EDIT_SESSION_BASELINE_STALE");
  });

  it("上传原图首次编辑可回退到原图基线", async () => {
    const { editService, historyService } = setup(imageCanvas());
    await editService.complete(imageComplete());
    const entries = await historyService.listEntriesForNode(CANVAS, "node-1");
    const baseline = entries.find((entry) => entry.sourceIdentity.startsWith("image-baseline:"));
    expect(baseline).toBeDefined();
    expect(baseline!.payload).toMatchObject({ kind: "image", storageKey: BASE_KEY });
  });

  it("恢复纯媒体版本清除旧编辑定义，恢复编辑版本写回 base/output/定义", async () => {
    const { editService, historyService, repository, room } = setup(imageCanvas());
    await editService.complete(imageComplete());
    const entries = await historyService.listEntriesForNode(CANVAS, "node-1");
    const editEntry = entries.find((entry) => entry.sourceIdentity.startsWith("image-edit:"))!;
    const baselineEntry = entries.find((entry) => entry.sourceIdentity.startsWith("image-baseline:"))!;

    // 当前节点已带编辑定义（complete 写回）。
    expect((room.canvas.nodeData["node-1"] as { imageEdit?: unknown }).imageEdit).not.toBeNull();

    // 恢复基线：清除旧定义。
    const restored = await historyService.restore({ canvasId: CANVAS, nodeId: "node-1", entryId: baselineEntry.entryId });
    expect(restored.ok).toBe(true);
    expect((room.canvas.nodeData["node-1"] as { imageEdit?: unknown }).imageEdit).toBeNull();

    // 恢复编辑版本：写回编辑定义。
    const restoredEdit = await historyService.restore({ canvasId: CANVAS, nodeId: "node-1", entryId: editEntry.entryId });
    expect(restoredEdit.ok).toBe(true);
    const data = room.canvas.nodeData["node-1"] as { imageEdit?: ImageEditDocument };
    expect(data.imageEdit?.version).toBe(IMAGE_EDIT_DOCUMENT_VERSION);
    void repository;
  });

  it("所需原图缺失时恢复编辑版本被拒绝", async () => {
    let baseExists = true;
    const { editService, historyService } = setup(imageCanvas(), { mediaExists: (key) => (key === OUT_KEY ? true : baseExists) });
    await editService.complete(imageComplete());
    const entries = await historyService.listEntriesForNode(CANVAS, "node-1");
    const editEntry = entries.find((entry) => entry.sourceIdentity.startsWith("image-edit:"))!;
    // 提交成功后再令原图不可解析。
    baseExists = false;
    const restored = await historyService.restore({ canvasId: CANVAS, nodeId: "node-1", entryId: editEntry.entryId });
    expect(restored.ok).toBe(false);
    if (!restored.ok) expect(restored.code).toBe("unrecoverable");
  });

  it("恢复旧版本前先保护当前编辑版本（回退前留档）", async () => {
    const { editService, historyService } = setup(imageCanvas());
    await editService.complete(imageComplete());
    const entries = await historyService.listEntriesForNode(CANVAS, "node-1");
    const baselineEntry = entries.find((entry) => entry.sourceIdentity.startsWith("image-baseline:"))!;
    const before = entries.filter((entry) => entry.sourceIdentity.startsWith("image-edit:")).length;
    // 恢复纯媒体基线：当前编辑版本应先被留档保护。
    const restored = await historyService.restore({ canvasId: CANVAS, nodeId: "node-1", entryId: baselineEntry.entryId });
    expect(restored.ok).toBe(true);
    const after = await historyService.listEntriesForNode(CANVAS, "node-1");
    const editAfter = after.filter((entry) => entry.sourceIdentity.startsWith("image-edit:"));
    // 原编辑版本仍在（未被删除），且后续可从它恢复回来。
    expect(editAfter.length).toBeGreaterThanOrEqual(before);
    const recoverBack = await historyService.restore({ canvasId: CANVAS, nodeId: "node-1", entryId: editAfter[0].entryId });
    expect(recoverBack.ok).toBe(true);
  });

  it("缺少持久历史能力时明确拒绝（不静默回退）", async () => {
    const completions = new InMemoryEditCompletionRepository();
    const editService = new EditCompletionService({
      completions,
      publisher: { registerEntry: async () => ({ status: "inserted", entryId: "x" }), listEntriesForNode: async () => [] },
      resolveRoom: async () => null
    });
    const result = await editService.complete(imageComplete());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("EDIT_SESSION_TARGET_INVALID");
  });
});

describe("模型会话完成", () => {
  it("归档包含模型最终版本且不额外推进 revision", async () => {
    const canvas = modelCanvas("build(default)");
    const { editService, room, historyService } = setup(canvas);
    const revisionBefore = room.canvas.revision;
    const result = await editService.complete({
      canvasId: CANVAS, nodeId: "node-1", sessionId: "s", requestId: "mreq-1", kind: "model",
      baselineContentIdentity: "model-source:other", model: { baselineSourceHash: "other", finalSourceHash: hashModelScript("build(default)") }
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.receipt.status).toBe("completed");
    expect(room.canvas.revision).toBe(revisionBefore);
    const entries = await historyService.listEntriesForNode(CANVAS, "node-1");
    expect(entries).toHaveLength(1);
    expect(entries[0].payload).toMatchObject({ kind: "model" });
  });

  it("无净变化（内容回到基线）不新增版本", async () => {
    const canvas = modelCanvas("build(default)");
    const { editService, historyService } = setup(canvas);
    const placement = { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 };
    // 会话 begin 捕获的基线身份即当前模型内容身份。
    await editService.begin({
      canvasId: CANVAS, nodeId: "node-1", sessionId: "s", requestId: "begin:s", kind: "model",
      baselineContentIdentity: modelContentIdentity(hashModelScript("build(default)"), placement)
    });
    const result = await editService.complete({
      canvasId: CANVAS, nodeId: "node-1", sessionId: "s", requestId: "mreq-2", kind: "model",
      baselineContentIdentity: modelContentIdentity(hashModelScript("build(default)"), placement),
      model: { baselineSourceHash: hashModelScript("build(default)"), finalSourceHash: hashModelScript("build(default)") }
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.receipt.entryId).toBeNull();
    expect(await historyService.listEntriesForNode(CANVAS, "node-1")).toHaveLength(0);
  });
});

describe("受保护 status 与放弃", () => {
  it("prepared 草稿可放弃；内容已提交后不可放弃", async () => {
    const { editService } = setup(imageCanvas());
    await editService.begin({
      canvasId: CANVAS, nodeId: "node-1", sessionId: "s-prep", requestId: "begin:s-prep",
      kind: "image", baselineContentIdentity: `media:${BASE_KEY}`
    });
    const abandoned = await editService.abandon({ canvasId: CANVAS, nodeId: "node-1", requestId: "begin:s-prep" });
    expect(abandoned.ok).toBe(true);

    await editService.complete(imageComplete());
    const afterCommit = await editService.abandon({ canvasId: CANVAS, nodeId: "node-1", requestId: "req-1" });
    expect(afterCommit.ok).toBe(false);
  });

  it("status 对未知请求返回稳定 not-found", async () => {
    const { editService } = setup(imageCanvas());
    const result = await editService.status({ canvasId: CANVAS, nodeId: "node-1", requestId: "missing" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("EDIT_SESSION_NOT_FOUND");
  });
});

/**
 * 工程分支回归（编辑扩展工作区，任务 4.2/4.4）。
 *
 * 覆盖：工程对象也是恢复必需对象（缺失即整次失败、不部分提交）；工程身份由「基线 + 定义身份 +
 * 输出」派生（同内容重试命中同一版本，不同内容追加新版本）；画布尺寸（裁剪）与来源尺寸分离。
 */
const PROJECT_KEY = "sha256-" + "d".repeat(64);

function projectDoc(overrides: Partial<ImageProjectDocument> = {}): ImageProjectDocument {
  return {
    version: "woohaa-image-project-v1",
    engine: "fixture-editor",
    engineVersion: "fixture-editor-v1",
    formatVersion: 1,
    baseAssetId: "asset-base",
    sourceWidth: 400,
    sourceHeight: 300,
    canvasWidth: 100,
    canvasHeight: 80,
    documentContentHash: "0123456789abcdef",
    project: {
      storageKey: PROJECT_KEY,
      checksum: "d".repeat(64),
      contentType: "application/vnd.fixture-project",
      size: 4096
    },
    sourceAssetIds: ["asset-base"],
    ...overrides
  };
}

function projectComplete(overrides: { requestId?: string; outputStorageKey?: string; project?: ImageProjectDocument } = {}) {
  const document = overrides.project ?? projectDoc();
  const base = imageComplete({
    requestId: overrides.requestId ?? "req-project-1",
    outputStorageKey: overrides.outputStorageKey ?? OUT_KEY,
    imageEdit: document as never
  });
  return {
    ...base,
    media: {
      ...base.media,
      sourceWidth: document.sourceWidth,
      sourceHeight: document.sourceHeight,
      canvasWidth: document.canvasWidth,
      canvasHeight: document.canvasHeight,
      project: document.project
    }
  };
}

describe("工程编辑完成（任务 4.2/4.4）", () => {
  it("工程 + PNG 成对提交：登记工程版本并保留画布/来源尺寸", async () => {
    const { editService, historyService, room } = setup(imageCanvas(), { mediaExists: () => true });
    const result = await editService.complete(projectComplete());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.status).toBe("completed");
    const entries = await historyService.listEntriesForNode(CANVAS, "node-1");
    expect(entries.filter((entry) => entry.sourceIdentity.startsWith("image-project:"))).toHaveLength(1);
    const data = room.canvas.nodeData["node-1"] as { imageEdit?: ImageProjectDocument };
    expect(data.imageEdit?.version).toBe("woohaa-image-project-v1");
    // 画布尺寸（裁剪后）与来源尺寸分离保留。
    expect(data.imageEdit?.canvasWidth).toBe(100);
    expect(data.imageEdit?.sourceWidth).toBe(400);
  });

  it("媒体核验带上画布作用域：远端画布的产物只在托管存储里", async () => {
    const scopes: Array<string | undefined> = [];
    const { editService } = setup(imageCanvas(), {
      mediaExists: (_key, scope) => {
        scopes.push(scope?.canvasId);
        return true;
      }
    });
    const result = await editService.complete(projectComplete());
    expect(result.ok).toBe(true);
    // 原图、输出与工程对象三次探测都必须声明同一张画布。
    expect(scopes).toEqual([CANVAS, CANVAS, CANVAS]);
  });

  it("工程对象不可解析时整次失败，不部分提交", async () => {
    // 只让原图与输出可解析，工程对象缺失。
    const { editService, room } = setup(imageCanvas(), {
      mediaExists: (key) => key !== PROJECT_KEY
    });
    const revision = room.canvas.revision;
    const result = await editService.complete(projectComplete());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("EDIT_SESSION_MEDIA_UNRESOLVABLE");
    expect(room.canvas.revision).toBe(revision);
  });

  it("同 requestId 重放命中同一版本，不重复归档", async () => {
    const { editService, historyService, room } = setup(imageCanvas(), { mediaExists: () => true });
    const first = await editService.complete(projectComplete());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const revisions = room.canvas.revision;
    const second = await editService.complete(projectComplete());
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.receipt.entryId).toBe(first.receipt.entryId);
    expect(room.canvas.revision).toBe(revisions);
    const entries = await historyService.listEntriesForNode(CANVAS, "node-1");
    expect(entries.filter((entry) => entry.sourceIdentity.startsWith("image-project:"))).toHaveLength(1);
  });

  it("推进基线后再应用不同工程内容：追加新版本并更新节点定义", async () => {
    const { editService, historyService, room } = setup(imageCanvas(), { mediaExists: () => true });
    const first = await editService.complete(projectComplete());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 保存成功后宿主以新内容身份重新 begin；不同内容产生新版本。
    await editService.begin({
      canvasId: CANVAS,
      nodeId: "node-1",
      sessionId: "session-1",
      requestId: "begin:session-1",
      kind: "image",
      baselineContentIdentity: first.receipt.contentIdentity
    });
    const changed = await editService.complete(
      projectComplete({
        requestId: "req-project-3",
        outputStorageKey: "generation-outputs/" + "e".repeat(64) + ".png",
        project: projectDoc({ documentContentHash: "fedcba9876543210" })
      })
    );
    expect(changed.ok).toBe(true);
    const data = room.canvas.nodeData["node-1"] as { imageEdit?: ImageProjectDocument };
    expect(data.imageEdit?.documentContentHash).toBe("fedcba9876543210");
    const entries = await historyService.listEntriesForNode(CANVAS, "node-1");
    expect(entries.filter((entry) => entry.sourceIdentity.startsWith("image-project:")).length).toBeGreaterThanOrEqual(1);
  });

  it("复用同一 begin 会沿用陈旧基线：宿主必须换 sessionId 才能写第二版（A2 根因）", async () => {
    // 回归：`begin` 按 `begin:<sessionId>` 幂等返回**第一次**的基线，`complete` 又优先用这份
    // 持久化基线。所以同一个 sessionId 在首次成功保存之后，节点身份已经变了，第二次提交
    // 一律被判基线过期 —— 表现就是「点了应用到节点，刷新后没有新版本」（2026-10-24 审片 A2）。
    const { editService, historyService } = setup(imageCanvas(), { mediaExists: () => true });
    const begun = await editService.begin({
      canvasId: CANVAS,
      nodeId: "node-1",
      sessionId: "reused",
      requestId: "begin:reused",
      kind: "image",
      baselineContentIdentity: "media:" + BASE_KEY
    });
    expect(begun.ok).toBe(true);
    const first = await editService.complete(
      projectComplete({ requestId: "req-a", outputStorageKey: "generation-outputs/" + "b".repeat(64) + ".png", project: projectDoc({ documentContentHash: "1111111111111111" }) })
    );
    expect(first.ok).toBe(true);

    // 同一个 sessionId 再 begin：拿到的是旧基线（不重新采集）。
    const reused = await editService.begin({
      canvasId: CANVAS,
      nodeId: "node-1",
      sessionId: "reused",
      requestId: "begin:reused",
      kind: "image",
      baselineContentIdentity: "media:" + BASE_KEY
    });
    expect(reused.ok).toBe(true);
    if (!reused.ok || !begun.ok) return;
    expect(reused.baselineContentIdentity).toBe(begun.baselineContentIdentity);

    const second = await editService.complete(
      projectComplete({ requestId: "req-b", outputStorageKey: "generation-outputs/" + "c".repeat(64) + ".png", project: projectDoc({ documentContentHash: "2222222222222222" }) })
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("EDIT_SESSION_BASELINE_STALE");

    // 换新 sessionId 重新 begin（宿主的修复动作）→ 第二版正常写入。
    const rotated = await editService.begin({
      canvasId: CANVAS,
      nodeId: "node-1",
      sessionId: "rotated",
      requestId: "begin:rotated",
      kind: "image",
      baselineContentIdentity: "media:" + BASE_KEY
    });
    expect(rotated.ok).toBe(true);
    const third = await editService.complete({
      ...projectComplete({ requestId: "req-c", outputStorageKey: "generation-outputs/" + "c".repeat(64) + ".png", project: projectDoc({ documentContentHash: "2222222222222222" }) }),
      sessionId: "rotated"
    } as never);
    expect(third.ok).toBe(true);
    const entries = await historyService.listEntriesForNode(CANVAS, "node-1");
    const projects = entries.filter((entry) => entry.sourceIdentity.startsWith("image-project:"));
    expect(projects.length).toBeGreaterThanOrEqual(2);
  });
});


it("画布提交后回执落盘失败，重启补偿使用已冻结历史且不重读后来的节点", async () => {
  const { editService, completions, room, historyService } = setup(imageCanvas());
  const put = completions.put.bind(completions);
  let crash = true;
  vi.spyOn(completions, "put").mockImplementation(async (record) => {
    if (crash && record.status === "history-pending") { crash = false; throw new Error("crash after durable submit"); }
    return put(record);
  });
  await expect(editService.complete(imageComplete())).rejects.toThrow("crash");
  expect(room.submissions).toBe(1);
  expect(await completions.get(CANVAS, "node-1", "req-1")).toMatchObject({ status: "prepared", contentCommitted: false });
  const prepared = (await completions.get(CANVAS, "node-1", "req-1"))!;
  for (let index = 0; index < 120; index++) {
    await completions.put({ ...prepared, requestId: `begin:unused-${index}`, pendingEntries: [], updatedAt: "2026-10-01T00:00:00.000Z" });
  }
  room.setCanvas(imageCanvas({ outputStorageKey: BASE2_KEY }));
  expect(await editService.processPending()).toEqual({ scanned: 1, completed: 1 });
  expect(await editService.status({ canvasId: CANVAS, nodeId: "node-1", requestId: "req-1" })).toMatchObject({ ok: true, receipt: { status: "completed", contentCommitted: true } });
  const entries = await historyService.listEntriesForNode(CANVAS, "node-1");
  expect(JSON.stringify(entries)).toContain(OUT_KEY);
  expect(JSON.stringify(entries)).not.toContain(BASE2_KEY);
  expect((await editService.complete(imageComplete())).ok).toBe(true);
  expect(room.submissions).toBe(1);
});

it("prepared 尚未提交时 status 不误报成功，可用同一请求续作", async () => {
  const { editService, room } = setup(imageCanvas());
  const submit = vi.spyOn(room, "submit").mockRejectedValueOnce(new Error("before durable submit"));
  await expect(editService.complete(imageComplete())).rejects.toThrow("before durable submit");
  expect(await editService.status({ canvasId: CANVAS, nodeId: "node-1", requestId: "req-1" })).toMatchObject({ ok: true, receipt: { status: "prepared", contentCommitted: false } });
  submit.mockRestore();
  expect(await editService.complete(imageComplete())).toMatchObject({ ok: true, receipt: { status: "completed", contentCommitted: true } });
  expect(room.submissions).toBe(1);
});
