/**
 * Metadata-only 归档测试（任务 8.1–8.5）。
 *
 * 覆盖：格式/结构、SHA-256 与记录数校验、篡改检测、禁用二进制、dry-run 零写入、
 * no-overwrite、replace 备份与失败恢复、COS 引用校验。
 */
import { describe, expect, it } from "vitest";
import type { MediaStorage, MediaObject } from "@woohaa3/contracts";
import { MediaObjectNotFoundError } from "@woohaa3/contracts";
import { createEmptyWoohaa3ServerCanvas, type StoredAsset } from "@woohaa3/contracts";
import { CanvasArchiveService,
  CanvasStorageError,
  InMemoryCanvasRepository,
  CanvasApplicationService,
  buildCanvasArchive,
  extractAssetReferences,
  validateArchiveShape,
  type CanvasArchive } from "./index.js";

const NOW = "2026-09-23T00:00:00.000Z";
const CHECKSUM = "a".repeat(64);
const STORAGE_KEY = `sha256-${CHECKSUM}`;

function mediaStorage(keys: string[] = [STORAGE_KEY]): MediaStorage {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  for (const key of keys) objects.set(key, { bytes: new Uint8Array([1, 2, 3, 4]), contentType: "image/png" });
  return {
    async put(key, bytes, contentType) {
      objects.set(key, { bytes: new Uint8Array(bytes), contentType });
    },
    async get(key): Promise<MediaObject> {
      const record = objects.get(key);
      if (!record) throw new MediaObjectNotFoundError(key);
      return record;
    },
    async exists(key) {
      return objects.has(key);
    },
    async stat(key) {
      const record = objects.get(key);
      if (!record) throw new MediaObjectNotFoundError(key);
      return { size: record.bytes.byteLength, contentType: record.contentType };
    }
  };
}

function imageAsset(): StoredAsset {
  return {
    id: "asset-1",
    nodeId: "image-1",
    title: "图",
    mediaKind: "image",
    source: "generated",
    status: "ready",
    createdAt: NOW,
    url: `/api/media/${STORAGE_KEY}`,
    metadata: { storageKey: STORAGE_KEY, checksum: CHECKSUM, contentType: "image/png", size: 4 }
  };
}

async function populatedRepository(): Promise<{ repository: InMemoryCanvasRepository; service: CanvasApplicationService }> {
  const repository = new InMemoryCanvasRepository();
  const service = new CanvasApplicationService({ repository, mediaStorage: mediaStorage(), now: () => NOW });
  await service.createCanvas({ canvasId: "canvas-a", title: "A" });
  await service.commitCommands({
    canvasId: "canvas-a",
    expectedRevision: 1,
    operationId: "op-1",
    actorId: "actor",
    commands: [
      { type: "node.add", node: { id: "image-1", type: "image", position: { x: 0, y: 0 } } },
      { type: "asset.upsert", asset: imageAsset() }
    ]
  });
  await service.createCanvas({ canvasId: "canvas-b", title: "B" });
  return { repository, service };
}

describe("归档格式与结构（任务 8.1）", () => {
  it("extractAssetReferences 只取稳定 metadata", () => {
    const canvas = { ...createEmptyWoohaa3ServerCanvas("canvas-a", NOW), assets: [imageAsset()] };
    const references = extractAssetReferences(canvas);
    expect(references).toEqual([
      {
        assetId: "asset-1",
        mediaKind: "image",
        storageKey: STORAGE_KEY,
        checksum: CHECKSUM,
        contentType: "image/png",
        size: 4
      }
    ]);
  });

  it("validateArchiveShape 拒绝非对象 / 未知格式 / 缺字段", () => {
    expect(validateArchiveShape("x")?.code).toBe("not-an-object");
    expect(validateArchiveShape({ format: "other" })?.code).toBe("unsupported-format");
    expect(validateArchiveShape({ format: "woohaa3-canvas-archive-v1" })?.code).toBe("missing-field");
  });

  it("归档禁止 Blob / base64 / 签名 URL", async () => {
    const { repository } = await populatedRepository();
    const service = new CanvasArchiveService({ repository, now: () => NOW });
    const archive = await service.exportArchive();
    const json = JSON.stringify(archive);
    expect(json).not.toContain("base64");
    expect(json).not.toContain("blob:");
    expect(json).not.toContain("X-Amz-Signature");
    expect(json).not.toContain("_id");
  });
});

describe("export 与 verify（任务 8.2）", () => {
  it("Yjs 部署导出 published 投影，不取过期 legacy 节点数据", async () => {
    const { repository } = await populatedRepository();
    const legacy = (await repository.getCanvas("canvas-a"))!;
    const canonical = { ...legacy, revision: 9, nodeData: { "image-1": { extensionId: "fixture", saved: "latest" } } };
    const exporter = new CanvasArchiveService({ repository, publishedReader: { async loadPublished(id) { return id === "canvas-a" ? canonical : null; } } });
    const archive = await exporter.exportArchive();
    expect(archive.canvases.find(record => record.canvasId === "canvas-a")!.canvas).toEqual(canonical);
    expect(archive.canvases.find(record => record.canvasId === "canvas-b")!.canvas).toEqual(await repository.getCanvas("canvas-b"));
  });

  it("通用扩展引用登记、去重、旧归档恢复与新清单裁剪拒绝", async () => {
    const { repository, service } = await populatedRepository();
    await service.commitCommands({ canvasId: "canvas-a", expectedRevision: 2, operationId: "extension", actorId: "actor",
      commands: [{ type: "nodeData.patch", nodeId: "image-1", value: { extensionId: "fixture", projectKey: STORAGE_KEY } }] });
    const extensionArchiveDefinitions = [{ extensionId: "fixture", async collectMediaKeys({ nodeData, read }: {
      nodeData: Record<string, unknown>; read: (key: string) => Promise<MediaObject>
    }) { await read(nodeData.projectKey as string); return [nodeData.projectKey as string, nodeData.projectKey as string]; } }];
    const exporter = new CanvasArchiveService({ repository, mediaStorage: mediaStorage(), extensionArchiveDefinitions, now: () => NOW });
    const archive = await exporter.exportArchive(["canvas-a"]);
    expect(archive.canvases[0].mediaReferences).toEqual([{ extensionId: "fixture", nodeId: "image-1", storageKey: STORAGE_KEY,
      checksum: CHECKSUM, contentType: "image/png", size: 4 }]);
    expect((await exporter.verifyArchive(archive, { verifyMedia: true })).ok).toBe(true);
    const missing = new CanvasArchiveService({ repository, mediaStorage: mediaStorage([]), extensionArchiveDefinitions });
    expect(await missing.verifyArchive(archive, { verifyMedia: true })).toMatchObject({ ok: false, code: "missing-cos-object" });
    // 重算外层 checksum 仍不得隐藏扩展依赖。
    const rehash = async (mediaReferences?: typeof archive.canvases[0]["mediaReferences"]) => buildCanvasArchive({ createdAt: NOW,
      canvases: [{ canvas: archive.canvases[0].canvas, operations: [], ...(mediaReferences ? { mediaReferences } : {}) }] },
      async text => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, "0")).join(""));
    const tampered = await rehash([{ ...archive.canvases[0].mediaReferences![0], nodeId: "wrong" }]);
    expect(await exporter.verifyArchive(tampered, { verifyMedia: true })).toMatchObject({ ok: false, code: "invalid-shape" });
    const legacy = await rehash();
    expect((await exporter.verifyArchive(legacy, { verifyMedia: true })).ok).toBe(true);
    expect(await missing.verifyArchive(legacy, { verifyMedia: true })).toMatchObject({ ok: false, code: "missing-cos-object" });
  });

  it("拒绝同数量却替换了 key 的资产引用清单", async () => {
    const { repository } = await populatedRepository();
    const exporter = new CanvasArchiveService({ repository, computeSha256: async () => "fixture" });
    const archive = await exporter.exportArchive();
    archive.canvases[0].assets[0].storageKey = `sha256-${"b".repeat(64)}`;
    expect(await exporter.verifyArchive(archive)).toMatchObject({ ok: false, code: "invalid-shape" });
  });

  it("导出后 verify 通过，并含 canvases/operations 文件清单", async () => {
    const { repository } = await populatedRepository();
    const service = new CanvasArchiveService({ repository, mediaStorage: mediaStorage(), now: () => NOW });
    const archive = await service.exportArchive();
    expect(archive.format).toBe("woohaa3-canvas-archive-v1");
    expect(archive.canvases.map((record) => record.canvasId).sort()).toEqual(["canvas-a", "canvas-b"]);
    expect(archive.files.map((file) => file.name)).toEqual(["canvases.json", "operations.json"]);
    const verified = await service.verifyArchive(archive);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.canvasCount).toBe(2);
      expect(verified.operationCount).toBe(1);
      expect(verified.assetCount).toBe(1);
    }
  });

  it("篡改结构化记录导致 checksum-mismatch", async () => {
    const { repository } = await populatedRepository();
    const service = new CanvasArchiveService({ repository, now: () => NOW });
    const archive = await service.exportArchive();
    const tampered = structuredClone(archive);
    tampered.canvases[0].canvas.title = "被篡改";
    const verified = await service.verifyArchive(tampered);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.code).toBe("checksum-mismatch");
  });

  it("篡改 manifest 记录数量导致 record-count-mismatch", async () => {
    const { repository } = await populatedRepository();
    const service = new CanvasArchiveService({ repository, now: () => NOW });
    const archive = await service.exportArchive();
    const tampered = structuredClone(archive);
    tampered.files[0].recordCount = 99;
    const verified = await service.verifyArchive(tampered);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.code).toBe("record-count-mismatch");
  });

  it("verifyMedia 校验 COS 引用；缺失对象失败", async () => {
    const { repository } = await populatedRepository();
    const okService = new CanvasArchiveService({ repository, mediaStorage: mediaStorage(), now: () => NOW });
    const archive = await okService.exportArchive();
    expect((await okService.verifyArchive(archive, { verifyMedia: true })).ok).toBe(true);

    const missingService = new CanvasArchiveService({ repository, mediaStorage: mediaStorage([]), now: () => NOW });
    const missing = await missingService.verifyArchive(archive, { verifyMedia: true });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("missing-cos-object");
  });

  it("buildCanvasArchive 计算的 SHA-256 可被 verify 复算", async () => {
    const canvas = { ...createEmptyWoohaa3ServerCanvas("canvas-a", NOW), revision: 2 };
    const archive = await buildCanvasArchive(
      { canvases: [{ canvas, operations: [] }], createdAt: NOW },
      async (text) => `hash:${text.length}`
    );
    const service = new CanvasArchiveService({
      repository: new InMemoryCanvasRepository(),
      now: () => NOW,
      computeSha256: async (text) => `hash:${text.length}`
    });
    expect((await service.verifyArchive(archive)).ok).toBe(true);
  });
});

describe("import：dry-run / no-overwrite / replace（任务 8.3–8.5）", () => {
  it("dry-run 零写入", async () => {
    const source = await populatedRepository();
    const archive = await new CanvasArchiveService({ repository: source.repository, now: () => NOW }).exportArchive();

    const target = new InMemoryCanvasRepository();
    const importer = new CanvasArchiveService({ repository: target, now: () => NOW });
    const result = await importer.importArchive(archive, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.importedCanvasIds).toEqual([]);
    expect(await target.getCanvas("canvas-a")).toBeNull();
  });

  it("默认 no-overwrite：目标已存在时拒绝", async () => {
    const source = await populatedRepository();
    const archive = await new CanvasArchiveService({ repository: source.repository, now: () => NOW }).exportArchive();

    const target = await populatedRepository();
    const importer = new CanvasArchiveService({ repository: target.repository, now: () => NOW });
    await expect(importer.importArchive(archive)).rejects.toThrow(/目标已存在/);
  });

  it("导入空目标成功并保留 revision 语义", async () => {
    const source = await populatedRepository();
    const archive = await new CanvasArchiveService({ repository: source.repository, now: () => NOW }).exportArchive();

    const target = new InMemoryCanvasRepository();
    const importer = new CanvasArchiveService({ repository: target, now: () => NOW });
    const result = await importer.importArchive(archive);
    expect(result.importedCanvasIds.sort()).toEqual(["canvas-a", "canvas-b"]);
    const imported = await target.getCanvas("canvas-a");
    expect(imported?.revision).toBe(1);
    expect(imported?.assets[0].metadata).toMatchObject({ storageKey: STORAGE_KEY });
    // operation 记录不随导入复制（它们是源库的幂等记录）。
    expect(await target.listOperations("canvas-a")).toEqual([]);
  });

  it("replace 前自动备份，替换成功后目标为新版本", async () => {
    const source = await populatedRepository();
    const archive = await new CanvasArchiveService({ repository: source.repository, now: () => NOW }).exportArchive();

    const target = await populatedRepository();
    // 修改目标标题以区分。
    const targetService = new CanvasApplicationService({ repository: target.repository, now: () => NOW });
    await targetService.commitCommands({
      canvasId: "canvas-a",
      expectedRevision: 2,
      operationId: "op-target",
      actorId: "actor",
      commands: [{ type: "canvas.setTitle", title: "目标独有" }]
    });

    const importer = new CanvasArchiveService({ repository: target.repository, now: () => NOW });
    const result = await importer.importArchive(archive, { replace: true });
    expect(result.replacedCanvasIds.sort()).toEqual(["canvas-a", "canvas-b"]);
    const imported = await target.repository.getCanvas("canvas-a");
    expect(imported?.title).toBe("A");
    expect(imported?.revision).toBe(1);
  });

  it("replace 中途失败时用自动备份恢复原结构化画布（任务 8.5）", async () => {
    const source = await populatedRepository();
    const archive = await new CanvasArchiveService({ repository: source.repository, now: () => NOW }).exportArchive();

    // 目标已有两个画布，且 canvas-a 有独有标题。
    const target = await populatedRepository();
    const targetService = new CanvasApplicationService({ repository: target.repository, now: () => NOW });
    await targetService.commitCommands({
      canvasId: "canvas-a",
      expectedRevision: 2,
      operationId: "op-target",
      actorId: "actor",
      commands: [{ type: "canvas.setTitle", title: "目标独有" }]
    });
    const originalA = await target.repository.getCanvas("canvas-a");
    const originalB = await target.repository.getCanvas("canvas-b");

    // 注入：下一次 createCanvas 失败（模拟替换过程中发布失败）。
    target.repository.failNextCreate(new Error("模拟替换发布失败"));

    const importer = new CanvasArchiveService({ repository: target.repository, now: () => NOW });
    await expect(importer.importArchive(archive, { replace: true })).rejects.toBeInstanceOf(CanvasStorageError);

    // 备份恢复后，两个画布都回到替换前的原结构化状态。
    const restoredA = await target.repository.getCanvas("canvas-a");
    const restoredB = await target.repository.getCanvas("canvas-b");
    expect(restoredA?.title).toBe("目标独有");
    expect(restoredA?.revision).toBe(originalA?.revision);
    expect(restoredB?.revision).toBe(originalB?.revision);
    expect(restoredA?.assets).toEqual(originalA?.assets);
  });

  it("导入校验失败时抛错且目标不出现部分画布", async () => {
    const source = await populatedRepository();
    const archive = await new CanvasArchiveService({ repository: source.repository, now: () => NOW }).exportArchive();
    const tampered: CanvasArchive = structuredClone(archive);
    tampered.canvases[0].canvas.title = "篡改";

    const target = new InMemoryCanvasRepository();
    const importer = new CanvasArchiveService({ repository: target, now: () => NOW });
    await expect(importer.importArchive(tampered)).rejects.toBeInstanceOf(CanvasStorageError);
    expect(await target.getCanvas("canvas-a")).toBeNull();
    expect(await target.getCanvas("canvas-b")).toBeNull();
  });

  it("COS 引用缺失时导入在发布前失败", async () => {
    const source = await populatedRepository();
    const archive = await new CanvasArchiveService({ repository: source.repository, now: () => NOW }).exportArchive();

    const target = new InMemoryCanvasRepository();
    const importer = new CanvasArchiveService({
      repository: target,
      mediaStorage: mediaStorage([]),
      now: () => NOW
    });
    await expect(importer.importArchive(archive, { verifyMedia: true })).rejects.toThrow(/COS 对象/);
    expect(await target.getCanvas("canvas-a")).toBeNull();
  });
});
