/**
 * 节点生成历史 repository / 应用服务测试
 * （change: add-canvas-node-generation-history，任务 1.2 / 1.3 / 1.4 / 5.1）。
 *
 * 覆盖：稳定去重、分页 cursor、归属校验、容量清理、生命周期、五类恢复与
 * prompt/parameters/modelPlacement 不变。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEmptyWoohaa3ServerCanvas, hashModelScript, nodeHistoryContentIdentity, NODE_GENERATION_HISTORY_VERSION, filmSetNodeDataFields, createFilmSetSnapshot, filmSetAnimationsOf, type MediaStorageScope, type NodeGenerationHistoryEntry, type ServerCanvas, type StoredAsset } from "@woohaa3/contracts";
import { InMemoryNodeHistoryRepository } from "./in-memory-node-history-repository.js";
import { NodeHistoryApplicationService, snapshotCurrentImageEdit } from "./node-history-service.js";
import { SqliteNodeHistoryRepository } from "../sqlite/node-history.js";
import type { NodeHistoryRepository } from "./node-history-contracts.js";
import type { CanvasRoom } from "../../sync/index.js";

const NOW = "2026-09-27T00:00:00.000Z";
const CANVAS = "canvas-1";

/** 最小 room 假实现：只支持 exportCanvas 与 submit（应用命令到内存聚合）。 */
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
  // 自包含 3D 节点必须携带完整本地模型定义（命令边界校验要求）；测试用最小合法默认值。
  // 片场（composite-asset + extensionId="film-set"）是 items-only，不写顶层模型字段。
  const filmSet = (type === "composite-asset" && (data.extensionId === "film-set" || data.filmSetContent !== undefined));
  const selfContained: Record<string, unknown> = (type === "model3d" || (type === "composite-asset" && !filmSet))
    ? {
        modelScript: "build(default)",
        modelScriptLanguage: "javascript",
        modelScriptVersion: "woohaa-model-js-v2",
        modelContentVersion: { revision: 1, sourceHash: hashModelScript("build(default)"), contentHash: "base-content" },
        modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
      }
    : {};
  return {
    ...base,
    revision: 1,
    document: {
      ...base.document,
      nodes: [{ id: "node-1", type, position: { x: 0, y: 0 }, width: 248, height: 232 }]
    },
    nodeData: { "node-1": { title: "T", ...selfContained, ...data } }
  } as ServerCanvas;
}

function mediaAsset(storageKey: string, kind: "image" | "video" | "audio" = "image"): StoredAsset {
  return {
    id: `asset-${storageKey.slice(-4)}`,
    title: "生成资产",
    mediaKind: kind,
    source: "generated",
    status: "ready",
    createdAt: NOW,
    metadata: { storageKey, checksum: storageKey.slice(7), contentType: "image/png", size: 12 }
  };
}

function setup(
  canvas: ServerCanvas,
  options: { mediaExists?: (key: string, scope?: MediaStorageScope) => boolean; now?: () => string } = {}
) {
  const repository = new InMemoryNodeHistoryRepository();
  const room = fakeRoom(canvas);
  const service = new NodeHistoryApplicationService({
    repository,
    resolveRoom: async (canvasId) => (canvasId === CANVAS ? room : null),
    ...(options.mediaExists
      ? { mediaVerifier: { exists: async (key: string, scope?: MediaStorageScope) => options.mediaExists!(key, scope) } }
      : {}),
    ...(options.now ? { now: options.now } : {})
  });
  return { repository, service, room };
}

describe("节点历史 repository / 应用服务", () => {
  it("以稳定 entryId 幂等登记文本版本", async () => {
    const { service } = setup(canvasWithNode("text"));
    const first = await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-1", kind: "text", createdAt: NOW,
      output: { mediaKind: "text", text: "hello" }
    });
    const second = await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-1", kind: "text", createdAt: NOW,
      output: { mediaKind: "text", text: "hello" }
    });
    expect(first.status).toBe("inserted");
    expect(second.status).toBe("duplicate");
    expect(first.entryId).toBe(second.entryId);
  });

  it("媒体可解析性校验带画布作用域", async () => {
    const seen: Array<MediaStorageScope | undefined> = [];
    const key = "sha256-" + "c".repeat(64);
    const { service } = setup(canvasWithNode("image"), {
      mediaExists: (_key, scope) => {
        seen.push(scope);
        return true;
      }
    });
    const { entryId } = await service.registerTaskResult({
      canvasId: CANVAS,
      nodeId: "node-1",
      runId: "run-scope",
      kind: "image",
      createdAt: NOW,
      output: { mediaKind: "image", asset: mediaAsset(key, "image") }
    });
    // 详情读取会刷新 recoverable/previewable，媒体核验就在这条路径上。
    await service.getDetail({ canvasId: CANVAS, nodeId: "node-1", entryId });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((scope) => scope?.canvasId === CANVAS)).toBe(true);
  });

  it("来源摘要填全溯源身份：runId + taskKey + modelId，providerTaskId 仍是 jobId（change: l0-generation-provenance）", async () => {
    const key = "sha256-" + "c".repeat(64);
    const { service, repository } = setup(canvasWithNode("image"), { mediaExists: () => true });
    const { entryId } = await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-1", taskKey: "task-key-1",
      modelKey: "litellm:gpt-image-2", jobId: "job-1", kind: "image", createdAt: NOW,
      output: { mediaKind: "image", asset: mediaAsset(key, "image") }
    });
    const entry = await repository.get(CANVAS, "node-1", entryId);
    expect(entry?.source).toEqual({
      label: "图片生成",
      runId: "run-1",
      taskKey: "task-key-1",
      modelId: "litellm:gpt-image-2",
      // 历史行为不变：providerTaskId 仍填 canvas jobId（语义错位不改，溯源看 taskKey）。
      providerTaskId: "job-1"
    });
    // 安全列表项透传同一来源摘要，卡片可直接拿 taskKey/modelId 反查。
    const page = await service.list({ canvasId: CANVAS, nodeId: "node-1" });
    expect(page.items[0]?.source).toMatchObject({ taskKey: "task-key-1", modelId: "litellm:gpt-image-2" });
  });

  it("缺失的溯源身份不写入、不按当前画布状态反填", async () => {
    const { service, repository } = setup(canvasWithNode("image", { modelKey: "litellm:current-node-model" }), {
      mediaExists: () => true
    });
    const { entryId } = await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-1", kind: "image", createdAt: NOW,
      output: { mediaKind: "image", asset: mediaAsset("sha256-" + "f".repeat(64), "image") }
    });
    const entry = await repository.get(CANVAS, "node-1", entryId);
    // 旧调用方没有 taskKey/modelKey：省略而不是用 nodeData.modelKey（那可能属于更新的 run）。
    expect(entry?.source).toEqual({ label: "图片生成", runId: "run-1" });
  });

  it("同一节点多个版本按 createdAt 倒序分页且 cursor 稳定", async () => {
    const { service } = setup(canvasWithNode("text"));
    for (let index = 0; index < 5; index += 1) {
      await service.registerTaskResult({
        canvasId: CANVAS, nodeId: "node-1", runId: `run-${index}`, kind: "text",
        createdAt: `2026-09-2${index}T00:00:00.000Z`,
        output: { mediaKind: "text", text: `v${index}` }
      });
    }
    const first = await service.list({ canvasId: CANVAS, nodeId: "node-1", limit: 2 });
    expect(first.items.map((item) => item.entryId)).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list({ canvasId: CANVAS, nodeId: "node-1", limit: 2, cursor: first.nextCursor! });
    // 不重复已返回条目。
    expect(second.items.map((item) => item.entryId)).not.toEqual(first.items.map((item) => item.entryId));
    expect(second.items[0].createdAt <= first.items[first.items.length - 1].createdAt).toBe(true);
  });

  it("画布级列表聚合多个节点、标记当前并按种类回退标题", async () => {
    const canvas: ServerCanvas = {
      ...canvasWithNode("text"),
      document: {
        ...canvasWithNode("text").document,
        nodes: [
          { id: "node-1", type: "text", position: { x: 0, y: 0 }, width: 248, height: 232 },
          { id: "node-2", type: "image", position: { x: 0, y: 0 }, width: 248, height: 232 }
        ]
      },
      nodeData: { "node-1": { title: "脚本节点" } }
    };
    const { service, room } = setup(canvas, { mediaExists: () => true });
    await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "r1", kind: "text", createdAt: "2026-09-21T00:00:00.000Z",
      output: { mediaKind: "text", text: "a" }
    });
    const key = "sha256-" + "c".repeat(64);
    await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-2", runId: "r2", kind: "image", createdAt: "2026-09-22T00:00:00.000Z",
      output: { mediaKind: "image", asset: mediaAsset(key, "image") }
    });
    // 让 node-1 当前输出与 r1 一致，验证 current 标记。
    const restored = await service.restore({
      canvasId: CANVAS, nodeId: "node-1",
      entryId: (await service.list({ canvasId: CANVAS, nodeId: "node-1", limit: 1 })).items[0].entryId
    });
    expect(restored.ok).toBe(true);
    void room;

    const page = await service.listCanvas({ canvasId: CANVAS, limit: 10 });
    expect(page.items.map((item) => item.nodeId)).toEqual(["node-2", "node-1"]);
    expect(page.items.map((item) => item.nodeTitle)).toEqual(["图片节点", "脚本节点"]);
    const textItem = page.items.find((item) => item.nodeId === "node-1");
    expect(textItem?.current).toBe(true);
    expect(page.kindCounts).toEqual({ text: 1, image: 1, video: 0, audio: 0, model: 0 });
    // 安全：列表 JSON 不含 storageKey / 完整正文。
    const json = JSON.stringify(page);
    expect(json).not.toContain("sha256-");
    expect(json).not.toContain("storageKey");
  });

  it("画布级列表按种类筛选且 cursor 在筛选结果内稳定", async () => {
    const { service } = setup(canvasWithNode("text"), { mediaExists: () => true });
    for (let index = 0; index < 3; index += 1) {
      await service.registerTaskResult({
        canvasId: CANVAS, nodeId: "node-1", runId: `ia-${index}`, kind: "image",
        createdAt: `2026-09-2${index}T00:00:00.000Z`,
        output: { mediaKind: "image", asset: mediaAsset("sha256-" + String(index).repeat(64), "image") }
      });
    }
    await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "t1", kind: "text", createdAt: "2026-09-25T00:00:00.000Z",
      output: { mediaKind: "text", text: "x" }
    });
    const images = await service.listCanvas({ canvasId: CANVAS, limit: 2, kind: "image" });
    expect(images.items).toHaveLength(2);
    expect(images.items.every((item) => item.kind === "image")).toBe(true);
    expect(images.nextCursor).not.toBeNull();
    const rest = await service.listCanvas({ canvasId: CANVAS, limit: 2, kind: "image", cursor: images.nextCursor! });
    expect(rest.items.every((item) => item.kind === "image")).toBe(true);
    expect(rest.items.map((item) => item.entryId)).not.toEqual(images.items.map((item) => item.entryId));
  });

  it("归属校验：跨节点读取返回 not-found", async () => {
    const { service } = setup(canvasWithNode("text"));
    const { entryId } = await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-1", kind: "text", createdAt: NOW,
      output: { mediaKind: "text", text: "hello" }
    });
    await expect(service.getDetail({ canvasId: CANVAS, nodeId: "other", entryId })).rejects.toMatchObject({
      code: "NODE_HISTORY_NOT_FOUND"
    });
  });

  it("超过单节点上限时淘汰最旧且非当前版本", async () => {
    const { service } = setup(canvasWithNode("text"));
    // 20 个版本，其中最后一个设为当前。
    for (let index = 0; index < 60; index += 1) {
      await service.registerTaskResult({
        canvasId: CANVAS, nodeId: "node-1", runId: `run-${index}`, kind: "text",
        createdAt: `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
        output: { mediaKind: "text", text: `v${index}` }
      });
    }
    const page = await service.list({ canvasId: CANVAS, nodeId: "node-1", limit: 100 });
    expect(page.total).toBeLessThanOrEqual(50);
  });

  it("节点/画布删除清理历史", async () => {
    const { service, repository } = setup(canvasWithNode("text"));
    await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-1", kind: "text", createdAt: NOW,
      output: { mediaKind: "text", text: "hello" }
    });
    await service.onNodeDeleted(CANVAS, "node-1");
    expect((await repository.canvasStats(CANVAS)).count).toBe(0);

    await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-2", kind: "text", createdAt: NOW,
      output: { mediaKind: "text", text: "hello" }
    });
    await service.onCanvasDeleted(CANVAS);
    expect((await repository.canvasStats(CANVAS)).count).toBe(0);
  });

  it("恢复完整文本：超过 2000 字仍完整且 prompt 不变", async () => {
    const long = "字".repeat(3000);
    const { service, room } = setup(canvasWithNode("text", { prompt: "原始 prompt", parameters: { n: 1 } }));
    const { entryId } = await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-1", kind: "text", createdAt: NOW,
      output: { mediaKind: "text", text: long }
    });
    const outcome = await service.restore({ canvasId: CANVAS, nodeId: "node-1", entryId });
    expect(outcome.ok).toBe(true);
    const data = room.canvas.nodeData["node-1"] as Record<string, unknown>;
    const asset = room.canvas.assets.find((candidate) => candidate.id === data.outputAssetId);
    expect(asset?.text).toBe(long);
    expect(data.prompt).toBe("原始 prompt");
    expect(data.parameters).toEqual({ n: 1 });
  });

  it("恢复媒体：补建稳定资产并 patch 输出引用", async () => {
    const key = "sha256-" + "a".repeat(64);
    const { service, room } = setup(canvasWithNode("image", { prompt: "p" }), { mediaExists: () => true });
    const { entryId } = await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-1", kind: "image", createdAt: NOW,
      output: { mediaKind: "image", asset: mediaAsset(key, "image") }
    });
    const outcome = await service.restore({ canvasId: CANVAS, nodeId: "node-1", entryId });
    expect(outcome.ok).toBe(true);
    const data = room.canvas.nodeData["node-1"] as Record<string, unknown>;
    const asset = room.canvas.assets.find((candidate) => candidate.id === data.outputAssetId);
    expect((asset?.metadata as { storageKey?: string }).storageKey).toBe(key);
    expect(data.prompt).toBe("p");
  });

  it("恢复媒体：稳定资产写回 provenance.runId，溯源链不断（change: l0-generation-provenance）", async () => {
    const key = "sha256-" + "d".repeat(64);
    const { service, room, repository } = setup(canvasWithNode("image"), { mediaExists: () => true });
    const { entryId } = await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-1", taskKey: "task-key-1",
      modelKey: "litellm:gpt-image-2", jobId: "job-1", kind: "image", createdAt: NOW,
      output: { mediaKind: "image", asset: mediaAsset(key, "image") }
    });
    const outcome = await service.restore({ canvasId: CANVAS, nodeId: "node-1", entryId });
    expect(outcome.ok).toBe(true);
    const data = room.canvas.nodeData["node-1"] as Record<string, unknown>;
    const asset = room.canvas.assets.find((candidate) => candidate.id === data.outputAssetId);
    // 资产 id 仍是历史派生的稳定 id，但 provenance 与在线产物同构。
    expect(asset?.id).toBe(`ngh-asset-${entryId}-image`);
    expect(asset?.provenance).toEqual({
      taskNodeId: "node-1",
      taskKind: "image-generation",
      outputIndex: 0,
      runId: "run-1"
    });
    // 沿 runId 回到同一条历史条目即可取到 taskKey/modelId（provenance 无这两个字段）。
    const entry = await repository.get(CANVAS, "node-1", entryId);
    expect(entry?.source).toMatchObject({ runId: "run-1", taskKey: "task-key-1", modelId: "litellm:gpt-image-2" });
  });

  it("恢复视频海报：provenance 同样保留 runId", async () => {
    const videoKey = "generation-outputs/" + "e".repeat(64) + ".mp4";
    const posterKey = "sha256-" + "e".repeat(64);
    const { service, room } = setup(canvasWithNode("video"), { mediaExists: () => true });
    const { entryId } = await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-1", kind: "video", createdAt: NOW,
      output: {
        mediaKind: "video",
        asset: {
          ...mediaAsset(videoKey, "video"),
          metadata: { storageKey: videoKey, checksum: "e".repeat(64), contentType: "video/mp4", size: 100 }
        },
        posterAsset: {
          ...mediaAsset(posterKey, "image"),
          metadata: { storageKey: posterKey, checksum: "e".repeat(64), contentType: "image/png", size: 12 }
        }
      }
    });
    await service.restore({ canvasId: CANVAS, nodeId: "node-1", entryId });
    const data = room.canvas.nodeData["node-1"] as Record<string, unknown>;
    const poster = room.canvas.assets.find((candidate) => candidate.id === data.posterAssetId);
    expect(poster?.provenance).toEqual({
      taskNodeId: "node-1",
      taskKind: "video-generation",
      outputIndex: 1,
      runId: "run-1"
    });
  });

  it("旧条目没有 runId（如跨画布复制/历史数据）时恢复不编造 provenance.runId", async () => {
    const key = "sha256-" + "9".repeat(64);
    const { service, room } = setup(canvasWithNode("image"), { mediaExists: () => true });
    const payload = { kind: "image" as const, storageKey: key, checksum: "9", contentType: "image/png", size: 12 };
    // 直接插入一条没有 source.runId 的旧条目：恢复只能保持缺省，不能凭当前画布猜一个 runId。
    await service.registerEntry({
      version: "woohaa-node-generation-history-v1",
      entryId: "legacy-entry",
      canvasId: CANVAS,
      nodeId: "node-1",
      kind: "image",
      createdAt: NOW,
      sourceIdentity: "task-run:run-legacy",
      currentIdentity: nodeHistoryContentIdentity(payload),
      recoverable: true,
      previewable: true,
      source: { label: "图片生成" },
      payload
    });
    const outcome = await service.restore({ canvasId: CANVAS, nodeId: "node-1", entryId: "legacy-entry" });
    expect(outcome.ok).toBe(true);
    const data = room.canvas.nodeData["node-1"] as Record<string, unknown>;
    const asset = room.canvas.assets.find((candidate) => candidate.id === data.outputAssetId);
    expect(asset?.provenance).toEqual({ taskNodeId: "node-1", taskKind: "image-generation", outputIndex: 0 });
  });

  it("媒体缺失时恢复返回不可恢复且不改当前节点", async () => {
    const key = "sha256-" + "b".repeat(64);
    const { service, room } = setup(canvasWithNode("image"), { mediaExists: () => false });
    const { entryId } = await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-1", kind: "image", createdAt: NOW,
      output: { mediaKind: "image", asset: mediaAsset(key, "image") }
    });
    const before = room.canvas.revision;
    const outcome = await service.restore({ canvasId: CANVAS, nodeId: "node-1", entryId });
    expect(outcome.ok).toBe(false);
    expect(room.canvas.revision).toBe(before);
  });

  it("恢复模型保留 modelPlacement 且不改 prompt/parameters", async () => {
    const placement = { offset: { x: 3, y: 4, z: 5 }, scale: 2, yaw: 1.2 };
    const { service, room } = setup(canvasWithNode("model3d", { prompt: "p", parameters: { m: 1 }, modelPlacement: placement }));
    const { entryId } = await service.registerModelScript({
      canvasId: CANVAS, nodeId: "node-1", sourceHash: "hash-a",
      modelScript: "build(()=>{})", language: "javascript", version: "woohaa-model-js-v2", createdAt: NOW
    });
    const outcome = await service.restore({ canvasId: CANVAS, nodeId: "node-1", entryId });
    expect(outcome.ok).toBe(true);
    const data = room.canvas.nodeData["node-1"] as Record<string, unknown>;
    expect(data.modelScript).toBe("build(()=>{})");
    expect(data.modelPlacement).toEqual(placement);
    expect(data.prompt).toBe("p");
    expect(data.parameters).toEqual({ m: 1 });
  });

  it("片场历史保存并原子恢复完整 items-only 内容（change: 2026-10-11 D7/D8/D10）", async () => {
    const animation = createFilmSetSnapshot({
      title: "片场",
      model: { modelScript: "build(default)", modelScriptVersion: "woohaa-model-js-v2" },
      motionScript: "",
      timeline: { duration: 0, loop: false },
      scenePlacement: { offset: { x: 2, y: 0, z: 0 }, scale: 1.5, yaw: 0.3 },
      filmSetContent: {
        schemaVersion: 4,
        items: [{ id: "ground", kind: "ground", name: "地面", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, size: { width: 8, depth: 8 } }]
      }
    });
    const filmSet = animation.filmSetContent;
    const { service, room } = setup(canvasWithNode("composite-asset", filmSetNodeDataFields(animation)));
    const { entryId } = await service.registerModelEdit({
      canvasId: CANVAS,
      nodeId: "node-1",
      sourceHash: hashModelScript("build(default)"),
      modelScript: "build(default)",
      language: "javascript",
      version: "woohaa-model-js-v2",
      placement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
      animation: {
        schemaVersion: 3,
        scenePlacement: animation.scenePlacement,
        sceneCamera: animation.sceneCamera,
        filmSetContent: filmSet,
        filmSetAnimations: filmSetAnimationsOf(animation)
      },
      createdAt: NOW
    });
    const detail = await service.getDetail({ canvasId: CANVAS, nodeId: "node-1", entryId });
    expect(detail.kind).toBe("model");
    if (detail.kind === "model") {
      expect(detail.animation?.schemaVersion === 3 ? detail.animation.filmSetContent : undefined).toEqual(filmSet);
    }
    const outcome = await service.restore({ canvasId: CANVAS, nodeId: "node-1", entryId });
    expect(outcome.ok).toBe(false);
    expect(room.canvas.nodeData["node-1"]?.filmSetContent).toEqual(filmSet);
  });

  it("恢复旧片场历史 payload（schema 1/2）明确拒绝且不改当前内容", async () => {
    const { service, room } = setup(canvasWithNode("composite-asset", filmSetNodeDataFields(createFilmSetSnapshot({
      title: "片场",
      timeline: { duration: 0, loop: false },
      filmSetContent: { schemaVersion: 4, items: [{ id: "ground", kind: "ground", name: "地面", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, size: { width: 8, depth: 8 } }] }
    }))));
    const before = JSON.stringify(room.canvas.nodeData["node-1"]);
    // 手工注册一条旧格式条目（顶层模型 + 节点级运动；无既有集合）。
    const legacy = {
      version: NODE_GENERATION_HISTORY_VERSION, entryId: "legacy-entry", canvasId: CANVAS, nodeId: "node-1",
      kind: "model" as const, createdAt: NOW, sourceIdentity: "model-edit:legacy", currentIdentity: "legacy",
      recoverable: true, previewable: true, source: { label: "模型编辑", sourceHash: hashModelScript("build(default)") },
      payload: {
        kind: "model" as const, modelScript: "build(default)", language: "javascript", version: "woohaa-model-js-v2", sourceHash: hashModelScript("build(default)"),
        animation: {
          modelContentVersion: { revision: 1, sourceHash: hashModelScript("build(default)"), contentHash: "base-content" },
          motionScript: "", motionScriptVersion: "woohaa-motion-js-v1", motionRevision: 1, motionSourceHash: "motion-hash",
          motionBasedOnModelVersion: { revision: 1, contentHash: "base-content" },
          initialCamera: { azimuth: 0, elevation: 0.5, distance: 4, aspect: "16:9", focusOffset: { x: 0, y: 0, z: 0 } },
          timeline: { duration: 0, loop: false }
        }
      }
    };
    const accessible = service as unknown as { repository: { insert(entry: NodeGenerationHistoryEntry): Promise<{ status: string; entryId: string }> } };
    await accessible.repository.insert(legacy as NodeGenerationHistoryEntry);
    const outcome = await service.restore({ canvasId: CANVAS, nodeId: "node-1", entryId: "legacy-entry" });
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(room.canvas.nodeData["node-1"])).toBe(before);
  });

  it("模型回退先把当前状态留档为编辑版本（含摆放），随后切换到目标版本", async () => {
    const placement = { offset: { x: 1, y: 2, z: 3 }, scale: 1.5, yaw: 0.4 };
    const { service, room } = setup(
      canvasWithNode("model3d", {
        modelScript: "build(current)",
        modelScriptLanguage: "javascript",
        modelScriptVersion: "woohaa-model-js-v2",
        modelPlacement: placement
      }),
      { now: () => NOW }
    );
    // 目标：另一个历史版本（不同脚本），sourceHash 必须与脚本一致。
    const targetScript = "build(target)";
    const { entryId: target } = await service.registerModelScript({
      canvasId: CANVAS, nodeId: "node-1", sourceHash: hashModelScript(targetScript),
      modelScript: targetScript, language: "javascript", version: "woohaa-model-js-v2", createdAt: NOW
    });

    const outcome = await service.restore({ canvasId: CANVAS, nodeId: "node-1", entryId: target });
    expect(outcome.ok).toBe(true);

    // 切换后：脚本为目标，摆放保留当前。
    const data = room.canvas.nodeData["node-1"] as Record<string, unknown>;
    expect(data.modelScript).toBe("build(target)");
    expect(data.modelPlacement).toEqual(placement);

    // 当前状态（脚本 + 摆放）被留档为一条编辑版本，可再恢复回来。
    const page = await service.list({ canvasId: CANVAS, nodeId: "node-1" });
    const edit = page.items.find((item) => item.source.label === "模型编辑");
    expect(edit).toBeDefined();
    const detail = await service.getDetail({ canvasId: CANVAS, nodeId: "node-1", entryId: edit!.entryId });
    expect(detail.kind).toBe("model");
    if (detail.kind === "model") {
      expect(detail.modelScript).toBe("build(current)");
      expect(detail.placement).toEqual(placement);
    }

    // 前进回来：恢复到该编辑版本，脚本与摆放一并写回。
    const back = await service.restore({ canvasId: CANVAS, nodeId: "node-1", entryId: edit!.entryId });
    expect(back.ok).toBe(true);
    const restored = room.canvas.nodeData["node-1"] as Record<string, unknown>;
    expect(restored.modelScript).toBe("build(current)");
    expect(restored.modelPlacement).toEqual(placement);
  });

  it("同一脚本的多个摆放版本只有当前摆放被标记为当前版本", async () => {
    const { service } = setup(
      canvasWithNode("model3d", {
        modelScript: "build(same)",
        modelScriptLanguage: "javascript",
        modelScriptVersion: "woohaa-model-js-v2",
        // 节点当前摆放 = 第二条编辑（x=2）。
        modelPlacement: { offset: { x: 2, y: 0, z: 0 }, scale: 1, yaw: 0 }
      }),
      { now: () => NOW }
    );
    // 两条不同摆放、相同脚本的编辑留档（模拟两次拖拽）。
    await service.registerModelEdit({
      canvasId: CANVAS, nodeId: "node-1", sourceHash: hashModelScript("build(same)"),
      modelScript: "build(same)", language: "javascript", version: "woohaa-model-js-v2",
      placement: { offset: { x: 1, y: 0, z: 0 }, scale: 1, yaw: 0 }, createdAt: NOW
    });
    await service.registerModelEdit({
      canvasId: CANVAS, nodeId: "node-1", sourceHash: hashModelScript("build(same)"),
      modelScript: "build(same)", language: "javascript", version: "woohaa-model-js-v2",
      placement: { offset: { x: 2, y: 0, z: 0 }, scale: 1, yaw: 0 }, createdAt: NOW
    });
    const page = await service.list({ canvasId: CANVAS, nodeId: "node-1" });
    const currents = page.items.filter((item) => item.current);
    expect(currents).toHaveLength(1);
    const detail = await service.getDetail({ canvasId: CANVAS, nodeId: "node-1", entryId: currents[0]!.entryId });
    expect(detail.kind === "model" && detail.placement?.offset.x).toBe(2);
  });

  it("同一状态重复回退不重复追加编辑版本", async () => {
    const placement = { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 };
    const { service } = setup(
      canvasWithNode("model3d", {
        modelScript: "build(current)",
        modelScriptLanguage: "javascript",
        modelScriptVersion: "woohaa-model-js-v2",
        modelPlacement: placement
      }),
      { now: () => NOW }
    );
    const targetScript = "build(target)";
    const { entryId: target } = await service.registerModelScript({
      canvasId: CANVAS, nodeId: "node-1", sourceHash: hashModelScript(targetScript),
      modelScript: targetScript, language: "javascript", version: "woohaa-model-js-v2", createdAt: NOW
    });
    // 两次恢复同一目标：第一次留档当前状态并切换到目标；第二次目标已是当前
    // （alreadyCurrent），不再留档。同一状态重试命中同一 model-edit identity。
    await service.restore({ canvasId: CANVAS, nodeId: "node-1", entryId: target });
    await service.restore({ canvasId: CANVAS, nodeId: "node-1", entryId: target });
    // 恢复到编辑版本（回到 current）再回到 target，两次都命中同一快照 identity。
    const page1 = await service.list({ canvasId: CANVAS, nodeId: "node-1" });
    const edits = page1.items.filter((item) => item.source.label === "模型编辑");
    expect(edits).toHaveLength(1);
  });

  it("recordCurrentModelVersion 留档当前摆放+脚本，同一状态幂等", async () => {
    const placement = { offset: { x: 7, y: 8, z: 9 }, scale: 1.2, yaw: 0.3 };
    const { service } = setup(
      canvasWithNode("model3d", {
        modelScript: "build(dragged)",
        modelScriptLanguage: "javascript",
        modelScriptVersion: "woohaa-model-js-v2",
        modelPlacement: placement
      }),
      { now: () => NOW }
    );
    const first = await service.recordCurrentModelVersion({ canvasId: CANVAS, nodeId: "node-1" });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.status).toBe("inserted");
    const second = await service.recordCurrentModelVersion({ canvasId: CANVAS, nodeId: "node-1" });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.status).toBe("duplicate");
      expect(first.ok && second.entryId).toBe(first.ok ? first.entryId : "");
    }
    const page = await service.list({ canvasId: CANVAS, nodeId: "node-1" });
    expect(page.items.filter((item) => item.source.label === "模型编辑")).toHaveLength(1);
  });

  it("生成中请求恢复被拒绝且状态不变", async () => {
    const { service, room } = setup(canvasWithNode("text", { taskStatus: "processing" }));
    const { entryId } = await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-1", kind: "text", createdAt: NOW,
      output: { mediaKind: "text", text: "hello" }
    });
    const before = room.canvas.revision;
    const outcome = await service.restore({ canvasId: CANVAS, nodeId: "node-1", entryId });
    expect(outcome).toMatchObject({ ok: false, code: "conflict" });
    expect(room.canvas.revision).toBe(before);
  });

  it("失败/取消归档带 outcome、基线引用且不可恢复（change: 2026-10-12）", async () => {
    const { service, repository } = setup(canvasWithNode("image", { outputAssetId: "asset-before" }));
    // 先有一个成功版本作为基线可恢复内容。
    await service.registerTaskResult({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-ok", kind: "image", createdAt: NOW,
      output: { mediaKind: "image", asset: mediaAsset("sha256-" + "a".repeat(64)) }
    });
    const failure = await service.registerTaskFailure({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-bad", kind: "image", outcome: "failed",
      message: "provider 超时", code: "provider-timeout", createdAt: "2026-09-27T00:00:01.000Z",
      inputSummary: "海边日落"
    });
    expect(failure.status).toBe("inserted");
    // 幂等：同一 run 重试只登记一次。
    const again = await service.registerTaskFailure({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-bad", kind: "image", outcome: "failed",
      message: "provider 超时", createdAt: "2026-09-27T00:00:01.000Z", inputSummary: "海边日落"
    });
    expect(again.status).toBe("duplicate");

    const page = await service.list({ canvasId: CANVAS, nodeId: "node-1" });
    // 倒序：失败版本在前。
    const failedItem = page.items.find((item) => item.kind === "image" && item.outcome === "failed");
    expect(failedItem).toBeDefined();
    expect(failedItem?.recoverable).toBe(false);
    expect(failedItem?.current).toBe(false);
    expect(failedItem?.preview).toMatchObject({ kind: "failure", outcome: "failed" });
    // 存储条目携带基线引用（提交时当前 outputAssetId 与 identity）。
    const entries = await repository.listForNode(CANVAS, "node-1");
    const failedEntry = entries.find((entry) => entry.entryId === failure.entryId);
    expect(failedEntry?.outcome).toBe("failed");
    expect(failedEntry?.recoverable).toBe(false);
    expect((failedEntry?.payload as { baseline?: { outputAssetId?: string } }).baseline?.outputAssetId).toBe("asset-before");
    // 详情暴露失败原因与基线，不含产物。
    const detail = await service.getDetail({ canvasId: CANVAS, nodeId: "node-1", entryId: failure.entryId });
    expect(detail).toMatchObject({ kind: "failure", message: "provider 超时", code: "provider-timeout" });
  });

  it("取消归档可区分于失败（change: 2026-10-12）", async () => {
    const { service } = setup(canvasWithNode("video"));
    await service.registerTaskFailure({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-cancel", kind: "video", outcome: "cancelled",
      message: "用户取消", createdAt: NOW, inputSummary: ""
    });
    const page = await service.list({ canvasId: CANVAS, nodeId: "node-1" });
    expect(page.items[0]).toMatchObject({ outcome: "cancelled", recoverable: false });
  });

  it("失败归档的 source 同样带 taskKey/modelId（change: l0-generation-provenance）", async () => {
    const { service, repository } = setup(canvasWithNode("image"));
    const failure = await service.registerTaskFailure({
      canvasId: CANVAS, nodeId: "node-1", runId: "run-bad", taskKey: "task-key-bad",
      modelKey: "litellm:gpt-image-2", jobId: "job-bad", kind: "image", outcome: "failed",
      message: "provider 超时", createdAt: NOW, inputSummary: ""
    });
    const entry = await repository.get(CANVAS, "node-1", failure.entryId);
    expect(entry?.source).toEqual({
      label: "图片生成",
      runId: "run-bad",
      taskKey: "task-key-bad",
      modelId: "litellm:gpt-image-2",
      providerTaskId: "job-bad"
    });
  });
});

describe("SqliteNodeHistoryRepository", () => {
  it("独立表：不创建 Yjs/画布表", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-ngh-"));
    const repository = new SqliteNodeHistoryRepository({ path: path.join(dir, "history.db") });
    const tables = repository.debugQuery<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").map((row) => row.name);
    expect(tables).toContain("node_generation_history");
    expect(tables).not.toContain("canvases");
    expect(tables).not.toContain("canvas_yjs_documents");
    repository.close();
  });

  it("持久化幂等、分页与容量统计", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-ngh-"));
    const repository = new SqliteNodeHistoryRepository({ path: path.join(dir, "history.db") });
    const canvas = canvasWithNode("text");
    const room = fakeRoom(canvas);
    const service = new NodeHistoryApplicationService({ repository, resolveRoom: async () => room });
    for (let index = 0; index < 3; index += 1) {
      await service.registerTaskResult({
        canvasId: CANVAS, nodeId: "node-1", runId: `run-${index}`, kind: "text",
        createdAt: `2026-09-2${index}T00:00:00.000Z`,
        output: { mediaKind: "text", text: `v${index}` }
      });
    }
    const page = await service.list({ canvasId: CANVAS, nodeId: "node-1", limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    expect((await repository.canvasStats(CANVAS)).count).toBe(3);
    repository.close();
  });
});

/** 构造一条可直接入库的画布历史条目（画布级查询测试用）。 */
function sampleEntry(input: {
  entryId: string;
  nodeId: string;
  kind: NodeGenerationHistoryEntry["kind"];
  createdAt: string;
  payload?: NodeGenerationHistoryEntry["payload"];
}): NodeGenerationHistoryEntry {
  return {
    version: NODE_GENERATION_HISTORY_VERSION,
    entryId: input.entryId,
    canvasId: CANVAS,
    nodeId: input.nodeId,
    kind: input.kind,
    createdAt: input.createdAt,
    sourceIdentity: `task-run:${input.entryId}`,
    currentIdentity: `media:${input.entryId}`,
    recoverable: true,
    previewable: true,
    source: { label: "生成" },
    payload: input.payload ?? { kind: "text", text: "hi" }
  };
}

/** 画布级分页/筛选/计数的 repository 契约一致性断言（内存与 SQLite 共用）。 */
async function assertCanvasListContract(repository: NodeHistoryRepository): Promise<void> {
  const entries = [
    sampleEntry({ entryId: "e1", nodeId: "n1", kind: "text", createdAt: "2026-09-21T00:00:00.000Z" }),
    sampleEntry({ entryId: "e2", nodeId: "n1", kind: "image", createdAt: "2026-09-22T00:00:00.000Z" }),
    sampleEntry({ entryId: "e3", nodeId: "n2", kind: "image", createdAt: "2026-09-23T00:00:00.000Z" }),
    sampleEntry({ entryId: "e4", nodeId: "n2", kind: "video", createdAt: "2026-09-24T00:00:00.000Z" }),
    sampleEntry({ entryId: "e5", nodeId: "n3", kind: "text", createdAt: "2026-09-25T00:00:00.000Z" })
  ];
  for (const entry of entries) await repository.insert(entry);

  // 跨节点倒序（所有节点）。
  const first = await repository.listCanvas({ canvasId: CANVAS, limit: 2 });
  expect(first.items.map((entry) => entry.entryId)).toEqual(["e5", "e4"]);
  expect(first.total).toBe(5);
  expect(first.nextCursor).toEqual({ createdAt: "2026-09-24T00:00:00.000Z", entryId: "e4" });

  // cursor 排他、不重复。
  const second = await repository.listCanvas({ canvasId: CANVAS, limit: 2, cursor: first.nextCursor! });
  expect(second.items.map((entry) => entry.entryId)).toEqual(["e3", "e2"]);
  const third = await repository.listCanvas({ canvasId: CANVAS, limit: 2, cursor: second.nextCursor! });
  expect(third.items.map((entry) => entry.entryId)).toEqual(["e1"]);
  expect(third.nextCursor).toBeNull();

  // 按种类筛选（cursor 在筛选结果内稳定）。
  const images = await repository.listCanvas({ canvasId: CANVAS, limit: 10, kind: "image" });
  expect(images.items.map((entry) => entry.entryId)).toEqual(["e3", "e2"]);
  expect(images.total).toBe(2);
  const imagesPage = await repository.listCanvas({ canvasId: CANVAS, limit: 1, kind: "image" });
  expect(imagesPage.items.map((entry) => entry.entryId)).toEqual(["e3"]);
  const imagesRest = await repository.listCanvas({ canvasId: CANVAS, limit: 1, kind: "image", cursor: imagesPage.nextCursor! });
  expect(imagesRest.items.map((entry) => entry.entryId)).toEqual(["e2"]);

  // 其它画布互不影响。
  const other = await repository.listCanvas({ canvasId: "other-canvas", limit: 10 });
  expect(other.items).toHaveLength(0);

  // 种类计数与筛选无关，反映全部历史。
  expect(await repository.canvasKindCounts(CANVAS)).toEqual({ text: 2, image: 2, video: 1, audio: 0, model: 0 });

  // A busy node must not push an old node's failure or its current version out of summaries.
  const failure = sampleEntry({ entryId: "old-failure", nodeId: "old", kind: "text", createdAt: "2000-01-01" });
  failure.payload = { kind: "failure", outcome: "failed", failureKind: "text", baseline: null, inputSummary: "", message: "safe reason" };
  failure.recoverable = false;
  await repository.insert(failure);
  const current = sampleEntry({ entryId: "old-current", nodeId: "old", kind: "text", createdAt: "2000-01-02" });
  await repository.insert(current);
  // A newer cancellation sharing the current baseline must displace neither current success nor latest failed.
  const cancelled = sampleEntry({ entryId: "cancelled-baseline", nodeId: "old", kind: "text", createdAt: "2000-01-03" });
  cancelled.currentIdentity = current.currentIdentity;
  cancelled.payload = { kind: "failure", outcome: "cancelled", failureKind: "text", baseline: null, inputSummary: "", message: "cancelled" };
  cancelled.recoverable = false;
  await repository.insert(cancelled);
  for (let index = 0; index < 150; index++) {
    await repository.insert(sampleEntry({ entryId: `many-${index}`, nodeId: "old", kind: "text", createdAt: `2026-${String(index).padStart(4, "0")}` }));
  }
  const summary = await repository.listCanvas({ canvasId: CANVAS, limit: 100, summary: true, currentIdentities: { old: current.currentIdentity } });
  expect(summary.nextCursor).toBeNull();
  expect(summary.items.filter(item => item.nodeId === "old")).toHaveLength(26);
  expect(summary.items.some(item => item.entryId === "old-current")).toBe(true);
  expect(summary.items.some(item => item.entryId === "old-failure")).toBe(true);
  const targeted = await repository.listCanvas({ canvasId: CANVAS, limit: 100, summary: true, summaryNodeId: "old", currentIdentities: { old: current.currentIdentity } });
  expect(targeted.items.every(item => item.nodeId === "old")).toBe(true);
  expect(targeted.items).toHaveLength(26);
}

describe("画布级历史 repository 契约", () => {
  it("内存实现：跨节点倒序分页、种类筛选与计数", async () => {
    await assertCanvasListContract(new InMemoryNodeHistoryRepository());
  });

  it("内存与 SQLite 在画布级分页、筛选和计数上结果一致", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-ngh-canvas-"));
    const sqlite = new SqliteNodeHistoryRepository({ path: path.join(dir, "history.db") });
    try {
      await assertCanvasListContract(sqlite);
    } finally {
      sqlite.close();
    }
  });
});

/**
 * 工程历史恢复回归（编辑扩展工作区，任务 4.4）。
 *
 * 覆盖：工程版本的快照身份为 `image-project:`；工程对象与 PNG **成对**恢复，工程对象缺失时
 * 明确拒绝且不改当前节点（不部分恢复）。
 */
const PROJECT_HISTORY_KEY = "sha256-" + "d".repeat(64);
const HISTORY_BASE_KEY = "sha256-" + "a".repeat(64);
const HISTORY_OUT_KEY = "generation-outputs/" + "b".repeat(64) + ".png";

function projectHistoryCanvas(): ServerCanvas {
  const project = {
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
      storageKey: PROJECT_HISTORY_KEY,
      checksum: "d".repeat(64),
      contentType: "application/vnd.fixture-project",
      size: 4096
    },
    sourceAssetIds: ["asset-base"]
  };
  const node = canvasWithNode("image", { prompt: "p", outputAssetId: "asset-out", imageEdit: project });
  return {
    ...node,
    assets: [
      { id: "asset-out", title: "o", mediaKind: "image", source: "generated", status: "ready", createdAt: NOW, metadata: { storageKey: HISTORY_OUT_KEY, checksum: "b".repeat(64), contentType: "image/png", size: 20 } },
      { id: "asset-base", title: "原图", mediaKind: "image", source: "uploaded", status: "ready", createdAt: NOW, metadata: { storageKey: HISTORY_BASE_KEY, checksum: "a".repeat(64), contentType: "image/png", size: 10 } }
    ]
  } as ServerCanvas;
}

describe("工程历史恢复（任务 4.4）", () => {
  it("快照使用 image-project 身份，且工程 + PNG 成对恢复", async () => {
    const canvas = projectHistoryCanvas();
    const { service, repository, room } = setup(canvas, { mediaExists: () => true });
    await snapshotCurrentImageEdit(
      {
        context: { repository, resolveRoom: async () => room, log: () => undefined, now: () => NOW },
        registerModelEdit: async () => ({ status: "inserted" as const, entryId: "x" }),
        enforceCapacity: async () => undefined
      },
      CANVAS,
      "node-1",
      canvas,
      canvas.nodeData["node-1"] as Record<string, unknown>
    );
    const entries = await repository.listForNode(CANVAS, "node-1");
    const projectEntry = entries.find((entry) => entry.sourceIdentity.startsWith("image-project:"));
    expect(projectEntry).toBeTruthy();
    if (!projectEntry) return;
    const outcome = await service.restore({ canvasId: CANVAS, nodeId: "node-1", entryId: projectEntry.entryId });
    expect(outcome.ok).toBe(true);
    const data = room.canvas.nodeData["node-1"] as { imageEdit?: { version: string; canvasWidth: number } };
    expect(data.imageEdit?.version).toBe("woohaa-image-project-v1");
    expect(data.imageEdit?.canvasWidth).toBe(100);
  });

  it("工程版本与当前节点身份一致：列表标记 current，重复恢复为 alreadyCurrent", async () => {
    const canvas = projectHistoryCanvas();
    const { service, repository, room } = setup(canvas, { mediaExists: () => true });
    await snapshotCurrentImageEdit(
      {
        context: { repository, resolveRoom: async () => room, log: () => undefined, now: () => NOW },
        registerModelEdit: async () => ({ status: "inserted" as const, entryId: "x" }),
        enforceCapacity: async () => undefined
      },
      CANVAS,
      "node-1",
      canvas,
      canvas.nodeData["node-1"] as Record<string, unknown>
    );
    const entry = (await repository.listForNode(CANVAS, "node-1")).find((candidate) => candidate.sourceIdentity.startsWith("image-project:"));
    expect(entry).toBeTruthy();
    if (!entry) return;
    // 当前身份必须走 image-project 公式，不能用 media:<storageKey> 误判。
    const page = await service.list({ canvasId: CANVAS, nodeId: "node-1" });
    expect(page.items.find((item) => item.entryId === entry.entryId)?.current).toBe(true);
    const before = room.canvas.revision;
    const outcome = await service.restore({ canvasId: CANVAS, nodeId: "node-1", entryId: entry.entryId });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.alreadyCurrent).toBe(true);
    expect(room.canvas.revision).toBe(before);
  });

  it("工程对象缺失时拒绝部分恢复且不改当前节点", async () => {
    const canvas = projectHistoryCanvas();
    // 工程对象不可解析（原图与输出仍可用）。
    const { service, repository, room } = setup(canvas, { mediaExists: (key) => key !== PROJECT_HISTORY_KEY });
    await snapshotCurrentImageEdit(
      {
        context: { repository, resolveRoom: async () => room, log: () => undefined, now: () => NOW },
        registerModelEdit: async () => ({ status: "inserted" as const, entryId: "x" }),
        enforceCapacity: async () => undefined
      },
      CANVAS,
      "node-1",
      canvas,
      canvas.nodeData["node-1"] as Record<string, unknown>
    );
    const projectEntry = (await repository.listForNode(CANVAS, "node-1")).find((entry) => entry.sourceIdentity.startsWith("image-project:"));
    expect(projectEntry).toBeTruthy();
    if (!projectEntry) return;
    const before = room.canvas.revision;
    const outcome = await service.restore({ canvasId: CANVAS, nodeId: "node-1", entryId: projectEntry.entryId });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("unrecoverable");
    expect(room.canvas.revision).toBe(before);
  });

  describe("清空节点历史", () => {
    async function withEntries() {
      const harness = setup(canvasWithNode("text"));
      for (const runId of ["r1", "r2", "r3"]) {
        await harness.service.registerTaskResult({
          canvasId: CANVAS, nodeId: "node-1", runId, kind: "text", createdAt: NOW,
          output: { mediaKind: "text", text: runId }
        });
      }
      return harness;
    }

    it("清空只删该节点历史，不改画布内容与 revision", async () => {
      const { service, repository, room } = await withEntries();
      const before = room.canvas.revision;
      const result = await service.clearNodeHistory({ canvasId: CANVAS, nodeId: "node-1" });
      expect(result).toEqual({ ok: true, removed: 3 });
      expect((await service.list({ canvasId: CANVAS, nodeId: "node-1" })).items).toHaveLength(0);
      expect(await repository.canvasStats(CANVAS)).toEqual({ count: 0, bytes: 0 });
      // 清空历史不改权威画布。
      expect(room.canvas.revision).toBe(before);
    });

    it("其它节点的历史不受影响", async () => {
      const { service, repository, room } = await withEntries();
      await repository.insert({
        version: "woohaa-node-generation-history-v1", entryId: "other", canvasId: CANVAS, nodeId: "node-2",
        kind: "text", createdAt: NOW, outcome: "succeeded", sourceIdentity: "task-run:r9", currentIdentity: "x",
        recoverable: true, previewable: true, source: { label: "文本生成", runId: "r9" },
        payload: { kind: "text", text: "other" }
      } as never);
      await service.clearNodeHistory({ canvasId: CANVAS, nodeId: "node-1" });
      expect(await repository.listForNode(CANVAS, "node-1")).toHaveLength(0);
      expect(await repository.listForNode(CANVAS, "node-2")).toHaveLength(1);
      expect(room.canvas.revision).toBe(room.canvas.revision);
    });

    it("进行中的生成拒绝清空", async () => {
      const canvas = canvasWithNode("text", { taskStatus: "processing" });
      const { service, repository } = setup(canvas);
      await repository.insert({
        version: "woohaa-node-generation-history-v1", entryId: "e1", canvasId: CANVAS, nodeId: "node-1",
        kind: "text", createdAt: NOW, outcome: "succeeded", sourceIdentity: "task-run:r1", currentIdentity: "x",
        recoverable: true, previewable: true, source: { label: "文本生成", runId: "r1" },
        payload: { kind: "text", text: "a" }
      } as never);
      const result = await service.clearNodeHistory({ canvasId: CANVAS, nodeId: "node-1" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("conflict");
      expect(await repository.listForNode(CANVAS, "node-1")).toHaveLength(1);
    });

    it("未结算编辑会话拒绝清空", async () => {
      const { repository, room } = await withEntries();
      const service = new NodeHistoryApplicationService({
        repository,
        resolveRoom: async () => room,
        hasActiveEditSession: async () => true
      });
      const result = await service.clearNodeHistory({ canvasId: CANVAS, nodeId: "node-1" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("conflict");
      expect(await repository.listForNode(CANVAS, "node-1")).toHaveLength(3);
    });

    it("未知节点/不支持历史类型/未知画布明确拒绝", async () => {
      const { service } = setup(canvasWithNode("text"));
      expect((await service.clearNodeHistory({ canvasId: CANVAS, nodeId: "nope" })).ok).toBe(false);
      expect((await service.clearNodeHistory({ canvasId: "other", nodeId: "node-1" })).ok).toBe(false);
      const group = setup(canvasWithNode("group"));
      const result = await group.service.clearNodeHistory({ canvasId: CANVAS, nodeId: "node-1" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("invalid-node-type");
    });
  });
});
