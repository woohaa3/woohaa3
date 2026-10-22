/**
 * 核心存储行为测试（任务 2.2 / 2.4 / 2.5）。
 *
 * 用 in-memory 仓库跑完整 adapter contract suite，再单独覆盖命令应用器的引用完整性、
 * 资产引用校验和依赖边界（2.6）。
 */
import { describe, expect, it } from "vitest";
import type { MediaStorage, MediaObject, MediaStorageScope } from "@woohaa3/contracts";
import { MediaObjectNotFoundError } from "@woohaa3/contracts";
import { applyCanvasCommands,
  CanvasApplicationService,
  collectMutatedAssets,
  InMemoryCanvasRepository,
  registerCanvasRepositoryContract,
  validateAssetReferences,
  type ContractSuiteApi } from "./index.js";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas, type StoredAsset } from "@woohaa3/contracts";
import { canvasStorageErrorCode } from "./errors.js";

const NOW = "2026-09-23T00:00:00.000Z";

/** 用一个固定的内容寻址 key 构造合法图片资产。 */
const CHECKSUM = "a".repeat(64);
const STORAGE_KEY = `sha256-${CHECKSUM}`;

function imageAsset(overrides: Partial<StoredAsset> = {}): StoredAsset {
  return {
    id: "asset-image",
    nodeId: "node-image",
    title: "图",
    mediaKind: "image",
    source: "generated",
    status: "ready",
    createdAt: NOW,
    metadata: {
      storageKey: STORAGE_KEY,
      checksum: CHECKSUM,
      contentType: "image/png",
      size: 4
    },
    ...overrides
  };
}

/** 内存 MediaStorage，用于校验引用。 */
class FakeMediaStorage implements MediaStorage {
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  /** 每次 exists/stat 收到的画布作用域，用于断言调用方是否透传。 */
  readonly seenScopes: Array<MediaStorageScope | undefined> = [];

  putSync(key: string, bytes: Uint8Array, contentType: string): void {
    this.objects.set(key, { bytes, contentType });
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.putSync(key, bytes, contentType);
  }

  async get(key: string): Promise<MediaObject> {
    const object = this.objects.get(key);
    if (!object) throw new MediaObjectNotFoundError(key);
    return object;
  }

  async exists(key: string, scope?: MediaStorageScope): Promise<boolean> {
    this.seenScopes.push(scope);
    return this.objects.has(key);
  }

  async stat(key: string, scope?: MediaStorageScope) {
    this.seenScopes.push(scope);
    const object = this.objects.get(key);
    if (!object) throw new MediaObjectNotFoundError(key);
    return { size: object.bytes.byteLength, contentType: object.contentType };
  }
}

// 用 in-memory 仓库跑完整 contract suite。
registerCanvasRepositoryContract(
  { describe, it, expect } as unknown as ContractSuiteApi,
  { createRepository: () => new InMemoryCanvasRepository() }
);

describe("命令应用器：引用完整性（任务 2.2）", () => {
  const base = (): ServerCanvas => createEmptyWoohaa3ServerCanvas("canvas-x", NOW);

  it("一次提交跨 node/nodeData/edge 只产生一个目标聚合", () => {
    const result = applyCanvasCommands(
      base(),
      [
        { type: "node.add", node: { id: "n1", type: "text", position: { x: 0, y: 0 } } },
        { type: "node.add", node: { id: "n2", type: "image", position: { x: 100, y: 0 } }, connect: { fromNodeId: "n1", edgeId: "e-n1-n2" } },
        { type: "nodeData.patch", nodeId: "n2", value: { panelPrompt: "hello" } }
      ],
      { now: NOW }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.canvas.document.nodes.map((node) => node.id)).toEqual(["n1", "n2"]);
    expect(result.canvas.document.edges.length).toBe(1);
    expect(result.canvas.nodeData["n2"]).toMatchObject({ panelPrompt: "hello" });
  });

  it("非法引用不产生部分结果", () => {
    const result = applyCanvasCommands(
      base(),
      [
        { type: "node.add", node: { id: "n1", type: "image", position: { x: 0, y: 0 } } },
        { type: "edge.add", edge: { source: "n1", target: "ghost" } }
      ],
      { now: NOW }
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalid-edge-endpoint");
  });

  it("nodeData 指向不存在节点被拒绝", () => {
    const result = applyCanvasCommands(
      base(),
      [{ type: "nodeData.patch", nodeId: "ghost", value: { title: "x" } }],
      { now: NOW }
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("node-data-orphan");
  });

  it("node.add 低于最小尺寸被拒绝且不产生记录（change: add-node-resize）", () => {
    const result = applyCanvasCommands(
      base(),
      [{ type: "node.add", node: { id: "n1", type: "image", position: { x: 0, y: 0 }, width: 100, height: 40 } }],
      { now: NOW }
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalid-node-size");
  });

  it("node.update 低于最小尺寸被拒绝且不改写既有记录", () => {
    const withNode = applyCanvasCommands(
      base(),
      [{ type: "node.add", node: { id: "n1", type: "image", position: { x: 0, y: 0 }, width: 300, height: 200 } }],
      { now: NOW }
    );
    expect(withNode.ok).toBe(true);
    if (!withNode.ok) return;
    const rejected = applyCanvasCommands(withNode.canvas, [{ type: "node.update", nodeId: "n1", width: 100 }], { now: NOW });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.rejection.code).toBe("invalid-node-size");
    // 既有记录尺寸保持不变（只拒绝，不静默改写）。
    expect(withNode.canvas.document.nodes[0]).toMatchObject({ width: 300, height: 200 });
  });

  it("node.update 合法尺寸被接受", () => {
    const withNode = applyCanvasCommands(
      base(),
      [{ type: "node.add", node: { id: "n1", type: "image", position: { x: 0, y: 0 } } }],
      { now: NOW }
    );
    expect(withNode.ok).toBe(true);
    if (!withNode.ok) return;
    const updated = applyCanvasCommands(withNode.canvas, [{ type: "node.update", nodeId: "n1", width: 320, height: 240 }], { now: NOW });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.canvas.document.nodes[0]).toMatchObject({ width: 320, height: 240 });
  });

  it("删除节点级联清理边与 nodeData，但保留资产", () => {
    const withAsset = applyCanvasCommands(
      base(),
      [
        { type: "node.add", node: { id: "n1", type: "image", position: { x: 0, y: 0 } } },
        { type: "nodeData.patch", nodeId: "n1", value: { title: "x" } },
        { type: "asset.upsert", asset: imageAsset({ nodeId: "n1" }) }
      ],
      { now: NOW }
    );
    expect(withAsset.ok).toBe(true);
    if (!withAsset.ok) return;
    const removed = applyCanvasCommands(withAsset.canvas, [{ type: "node.remove", nodeIds: ["n1"] }], { now: NOW });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.canvas.document.nodes).toEqual([]);
    expect(removed.canvas.nodeData["n1"]).toBeUndefined();
    expect(removed.canvas.assets.length).toBe(1);
  });

  it("无净变化时 changed=false 且聚合不变", () => {
    const canvas = base();
    const result = applyCanvasCommands(
      canvas,
      [{ type: "canvas.setTitle", title: canvas.title as string }],
      { now: NOW }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.canvas).toBe(canvas);
  });

  it("Blob 等非 JSON 值无法从命令进入聚合", () => {
    const result = applyCanvasCommands(
      base(),
      [
        { type: "node.add", node: { id: "n1", type: "image", position: { x: 0, y: 0 } } },
        {
          type: "nodeData.patch",
          nodeId: "n1",
          value: {
            title: "保留",
            // 非 JSON 值在 domain 规范化（sanitize）时被剥离。
            blob: new Blob([new Uint8Array([1, 2, 3])]) as never,
            droppedUndefined: undefined as never,
            droppedNaN: Number.NaN as never,
            nested: { keep: 1, drop: undefined } as never
          }
        }
      ],
      { now: NOW }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const json = JSON.stringify(result.canvas);
    expect(json).not.toContain("[object Blob]");
    expect(json).not.toContain("droppedUndefined");
    expect(json).not.toContain("droppedNaN");
    expect(result.canvas.nodeData["n1"]).toMatchObject({ title: "保留", nested: { keep: 1 } });
  });
});

describe("资产引用校验（任务 2.5）", () => {
  it("合法且 metadata 一致的 COS 对象通过", async () => {
    const storage = new FakeMediaStorage();
    storage.putSync(STORAGE_KEY, new Uint8Array([1, 2, 3, 4]), "image/png");
    await expect(validateAssetReferences([imageAsset()], { mediaStorage: storage })).resolves.toBeUndefined();
  });

  it("已知画布时把 scope 原样透传给存在性校验", async () => {
    const storage = new FakeMediaStorage();
    storage.putSync(STORAGE_KEY, new Uint8Array([1, 2, 3, 4]), "image/png");
    await validateAssetReferences([imageAsset()], {
      mediaStorage: storage,
      scope: { canvasId: "canvas-scoped" }
    });
    // exists + stat 各一次，都必须带画布作用域。
    expect(storage.seenScopes).toEqual([{ canvasId: "canvas-scoped" }, { canvasId: "canvas-scoped" }]);
  });

  it("未提供 scope 时不带作用域（保持旧行为）", async () => {
    const storage = new FakeMediaStorage();
    storage.putSync(STORAGE_KEY, new Uint8Array([1, 2, 3, 4]), "image/png");
    await validateAssetReferences([imageAsset()], { mediaStorage: storage });
    expect(storage.seenScopes).toEqual([undefined, undefined]);
  });

  it("对象不存在被拒绝", async () => {
    const storage = new FakeMediaStorage();
    await expectExportError(
      () => validateAssetReferences([imageAsset()], { mediaStorage: storage }),
      "ASSET_REFERENCE_INVALID"
    );
  });

  it("size 与 COS 不一致被拒绝", async () => {
    const storage = new FakeMediaStorage();
    storage.putSync(STORAGE_KEY, new Uint8Array([1, 2, 3]), "image/png");
    await expectExportError(
      () => validateAssetReferences([imageAsset()], { mediaStorage: storage }),
      "ASSET_REFERENCE_INVALID"
    );
  });

  it("checksum 与 storageKey 内嵌哈希不一致被拒绝", async () => {
    const storage = new FakeMediaStorage();
    storage.putSync(STORAGE_KEY, new Uint8Array([1, 2, 3, 4]), "image/png");
    const bad = imageAsset({
      metadata: { storageKey: STORAGE_KEY, checksum: "b".repeat(64), contentType: "image/png", size: 4 }
    });
    await expectExportError(
      () => validateAssetReferences([bad], { mediaStorage: storage }),
      "ASSET_REFERENCE_INVALID"
    );
  });

  it("任意 https / data / blob URL 不是稳定引用，被拒绝", async () => {
    for (const key of ["https://example.com/a.png", "data:image/png;base64,AAAA", "blob:abc"]) {
      const asset = imageAsset({
        metadata: { storageKey: key, checksum: CHECKSUM, contentType: "image/png", size: 4 }
      });
      await expectExportError(() => validateAssetReferences([asset], {}), "ASSET_REFERENCE_INVALID");
    }
  });

  it("text 资产不需要媒体对象", async () => {
    const text: StoredAsset = {
      id: "asset-text",
      title: "t",
      mediaKind: "text",
      source: "generated",
      status: "ready",
      text: "hello",
      createdAt: NOW
    };
    await expect(validateAssetReferences([text], {})).resolves.toBeUndefined();
  });

  it("collectMutatedAssets 只返回新增或 metadata 变化的资产", () => {
    const before = [imageAsset()];
    const after = [imageAsset(), imageAsset({ id: "asset-new", metadata: { storageKey: `sha256-${"c".repeat(64)}`, checksum: "c".repeat(64), contentType: "image/png", size: 1 } })];
    expect(collectMutatedAssets(before, after).map((asset) => asset.id)).toEqual(["asset-new"]);
    expect(collectMutatedAssets(before, before)).toEqual([]);
  });
});

describe("应用服务在提交前校验资产（任务 2.5）", () => {
  it("引用不存在 COS 对象时拒绝且 revision 不变", async () => {
    const repository = new InMemoryCanvasRepository();
    const storage = new FakeMediaStorage();
    const service = new CanvasApplicationService({ repository, mediaStorage: storage, now: () => NOW });
    await service.createCanvas({ canvasId: "canvas-a" });
    let code: string | undefined;
    try {
      await service.commitCommands({
        canvasId: "canvas-a",
        expectedRevision: 1,
        operationId: "op-bad-asset",
        actorId: "actor",
        commands: [
          { type: "node.add", node: { id: "n1", type: "image", position: { x: 0, y: 0 } } },
          { type: "asset.upsert", asset: imageAsset({ nodeId: "n1" }) }
        ]
      });
    } catch (error) {
      code = canvasStorageErrorCode(error);
    }
    expect(code).toBe("ASSET_REFERENCE_INVALID");
    const loaded = await service.getCanvas("canvas-a");
    expect(loaded.revision).toBe(1);
    // 提交路径已知画布：校验必须带 canvasId（远端画布的字节只在托管存储里）。
    expect(storage.seenScopes).toEqual([{ canvasId: "canvas-a" }]);
  });
});

async function expectExportError(run: () => Promise<unknown>, code: string): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  expect(canvasStorageErrorCode(thrown)).toBe(code);
}
