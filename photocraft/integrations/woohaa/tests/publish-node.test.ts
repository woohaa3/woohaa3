/**
 * 添加到画布回归
 * （change: 2026-10-21-add-photocraft-document-workspace，任务 3.4 / design D5）。
 *
 * 覆盖：成对上传后原子发布、稳定 operationId/节点身份、上传失败不留裸节点、回执未知先核对、
 * 只读画布拒绝但允许本地保存。
 */
import { describe, expect, it, vi } from "vitest";
import type { CanvasCommand } from "@woohaa3/contracts";
import type { ProjectExportArtifacts } from "@woohaa3/photocraft-editor";
import { createPublishOperation, planPublishCommands, publishToCanvas, type PublishPorts, type PublishUploadedObject } from "../src/publish-node.js";

const artifacts: ProjectExportArtifacts = {
  revision: 3,
  documentContentHash: "aabbccddeeff0011",
  canvasWidth: 800,
  canvasHeight: 600,
  project: new Uint8Array([1, 2, 3]),
  projectSummary: { role: "project", byteLength: 3, sha256: "a".repeat(64), contentType: "application/vnd.woohaa.photocraft-project" },
  output: new Uint8Array([4, 5, 6, 7]),
  outputSummary: { role: "output", byteLength: 4, sha256: "b".repeat(64), contentType: "image/png" }
};

function uploaded(kind: "project" | "output"): PublishUploadedObject {
  return {
    storageKey: `sha256-${(kind === "project" ? "1" : "2").repeat(64)}`,
    checksum: (kind === "project" ? "1" : "2").repeat(64),
    contentType: kind === "project" ? "application/vnd.woohaa.photocraft-project" : "image/png",
    size: 128,
    url: `/api/media/${kind}`
  };
}

function ports(overrides: Partial<PublishPorts> = {}): PublishPorts {
  return {
    uploadProject: vi.fn(async () => uploaded("project")),
    uploadOutput: vi.fn(async () => uploaded("output")),
    submit: vi.fn(() => ({ ok: true as const })),
    findNode: vi.fn(() => ({ exists: false, outputAssetId: null })),
    isWritable: () => true,
    insertPosition: () => ({ x: 100, y: 200 }),
    canvasId: () => "c1",
    ...overrides
  };
}

describe("发布操作身份", () => {
  it("同一文档重试得到同一 operationId/nodeId（不每次生成新节点）", () => {
    const first = createPublishOperation("c1:file:1:1");
    const second = createPublishOperation("c1:file:1:1");
    expect(second).toEqual(first);
    expect(createPublishOperation("c1:file:2:1").nodeId).not.toBe(first.nodeId);
  });

  it("命令批次包含两个资产与一个带工程的图片节点（整批原子）", () => {
    const operation = createPublishOperation("seed");
    const document = {
      version: "woohaa-image-project-v1" as const,
      engine: "photocraft" as const,
      engineVersion: "e",
      formatVersion: 1,
      baseAssetId: "asset-out",
      sourceWidth: 800, sourceHeight: 600, canvasWidth: 800, canvasHeight: 600,
      documentContentHash: "aabbccddeeff0011",
      project: { storageKey: uploaded("project").storageKey, checksum: uploaded("project").checksum, contentType: "application/vnd.woohaa.photocraft-project", size: 128 },
      sourceAssetIds: ["asset-out"]
    };
    const commands = planPublishCommands({
      operation,
      project: uploaded("project"),
      output: uploaded("output"),
      projectAssetId: "asset-project",
      outputAssetId: "asset-out",
      projectDocument: document,
      canvasId: "c1",
      position: { x: 10, y: 20 },
      title: "作品"
    });
    expect(commands.map((command) => command.type)).toEqual(["asset.upsert", "asset.upsert", "node.add"]);
    const add = commands[2] as Extract<CanvasCommand, { type: "node.add" }>;
    expect(add.node).toMatchObject({ id: operation.nodeId, type: "image", position: { x: 10, y: 20 } });
    expect((add.nodeData as { outputAssetId?: string }).outputAssetId).toBe("asset-out");
    expect((add.nodeData as { imageEdit?: unknown }).imageEdit).toEqual(document);
  });
});

describe("publishToCanvas", () => {
  it("成功时成对上传并提交一次原子批次", async () => {
    const p = ports();
    const operation = createPublishOperation("seed");
    await expect(publishToCanvas(artifacts, operation, p, { title: "作品" })).resolves.toEqual({
      ok: true, nodeId: operation.nodeId, alreadyExisted: false
    });
    expect(p.uploadProject).toHaveBeenCalledOnce();
    expect(p.uploadOutput).toHaveBeenCalledOnce();
    expect(p.submit).toHaveBeenCalledOnce();
  });

  it("上传失败不提交任何命令（不留裸节点）", async () => {
    const p = ports({ uploadOutput: vi.fn(async () => null) });
    const operation = createPublishOperation("seed");
    const result = await publishToCanvas(artifacts, operation, p);
    expect(result).toMatchObject({ ok: false, code: "upload-failed" });
    expect(p.submit).not.toHaveBeenCalled();
  });

  it("重试复用已上传对象，不重复上传", async () => {
    const operation = createPublishOperation("seed");
    const submit = vi.fn().mockReturnValueOnce({ ok: false, reason: "timeout" }).mockReturnValueOnce({ ok: true });
    const p = ports({ submit });
    // 第一次：提交失败但节点不存在 → 失败。
    await expect(publishToCanvas(artifacts, operation, p)).resolves.toMatchObject({ ok: false, code: "submit-failed" });
    // 第二次：复用同一 attempt 的已上传对象。
    await expect(publishToCanvas(artifacts, operation, p)).resolves.toMatchObject({ ok: true, alreadyExisted: false });
    expect(p.uploadProject).toHaveBeenCalledOnce();
    expect(p.uploadOutput).toHaveBeenCalledOnce();
  });

  it("提交结果未知但节点已存在时按核对成功（不重复创建）", async () => {
    const p = ports({
      submit: vi.fn(() => ({ ok: false as const, reason: "timeout" })),
      findNode: vi.fn(() => ({ exists: true, outputAssetId: "asset-out" }))
    });
    const operation = createPublishOperation("seed");
    await expect(publishToCanvas(artifacts, operation, p)).resolves.toEqual({
      ok: true, nodeId: operation.nodeId, alreadyExisted: true
    });
  });

  it("只读画布拒绝添加，不调用上传", async () => {
    const p = ports({ isWritable: () => false });
    const result = await publishToCanvas(artifacts, createPublishOperation("seed"), p);
    expect(result).toMatchObject({ ok: false, code: "readonly" });
    expect(p.uploadProject).not.toHaveBeenCalled();
    expect(p.submit).not.toHaveBeenCalled();
  });

  it("上传后被置为只读时仍拒绝提交", async () => {
    let writable = true;
    const p = ports({
      isWritable: () => writable,
      uploadProject: vi.fn(async () => { writable = false; return uploaded("project"); })
    });
    await expect(publishToCanvas(artifacts, createPublishOperation("seed"), p)).resolves.toMatchObject({ ok: false, code: "readonly" });
    expect(p.submit).not.toHaveBeenCalled();
  });
});
