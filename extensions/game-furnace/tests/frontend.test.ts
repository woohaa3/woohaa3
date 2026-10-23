/**
 * 游戏炼丹炉前端容器插件测试
 * （change: 2026-10-10-add-game-furnace-extension，任务 4.6/4.7/4.8）。
 *
 * 纯函数覆盖：多选 group 展开/去重/整批拒绝、文件导入的稳定资产/元数据校验、以及超 inline
 * 预算时的 overBudget 标记（大文本转不可变 source asset 引用，模型/opaque 保留完整原件）。
 * 真实指针拖拽与真实像素不在本层；见 notes/acceptance.md。
 */
import { describe, expect, it } from "vitest";
import { decodeModelDefinition } from "@woohaa3/contracts";
import { createGameFurnaceNodeData } from "../src/geometry.js";
import type { ServerCanvas, StoredAsset, Woohaa3CanvasSerializedNode } from "@woohaa3/contracts";
import {
  deriveResourceName,
  expandGameFurnaceSources,
  planFileCollection,
  planGameFurnaceDrop,
  planUploadedResourceCollection,
  resourceFromUploadedFile,
  resourceKindForUpload,
  stableAssetFromUpload,
  stableUploadMetadata,
  uploadStatusLabel
} from "../src/authoring/browser/collection.js";
import { MAX_INLINE_SNAPSHOT_CHARS, MAX_INLINE_TEXT_CHARS, createGameFurnaceState, reduceGameFurnace, type GameResource } from "../src/shared.js";

const T = "2026-10-10T00:00:00.000Z";

function node(id: string, type: string, parentId?: string): Woohaa3CanvasSerializedNode {
  return { id, type, position: { x: 0, y: 0 }, ...(parentId ? { parentId } : {}) };
}

function readyAsset(id: string, overrides: Partial<StoredAsset> = {}): StoredAsset {
  return { id, title: id, mediaKind: "image", source: "uploaded", status: "ready", createdAt: T, url: `/api/media/${id}`, metadata: { storageKey: `key-${id}` }, ...overrides };
}

function canvas(
  nodes: Woohaa3CanvasSerializedNode[],
  nodeData: Record<string, Record<string, unknown>>,
  assets: StoredAsset[] = []
): ServerCanvas {
  return {
    id: "canvas-1",
    revision: 1,
    document: { schemaVersion: "asset-canvas-v1", nodes, edges: [], updatedAt: T },
    nodeData,
    assets,
    jobs: [],
    updatedAt: T
  } as unknown as ServerCanvas;
}

// ---------------------------------------------------------------------------
// 任务 4.6：多选 group 展开与整批拒绝
// ---------------------------------------------------------------------------

describe("多选 group 展开（任务 4.6）", () => {
  const nodes = [node("g1", "group"), node("leaf1", "text", "g1"), node("leaf2", "text", "g1"), node("leaf3", "text"), node("g2", "group"), node("leaf4", "text", "g2")];
  const textData = (id: string) => ({ [id]: { prompt: id } });
  const nodeData = { ...textData("leaf1"), ...textData("leaf2"), ...textData("leaf3"), ...textData("leaf4") };

  it("group 按稳定文档顺序递归展开为叶子", () => {
    const c = canvas(nodes, nodeData);
    const expanded = expandGameFurnaceSources(c, ["g1", "leaf3"]);
    expect(expanded!.map((n) => n.id)).toEqual(["leaf1", "leaf2", "leaf3"]);
  });

  it("直接选中叶子与其所属 group 重叠时去重", () => {
    const c = canvas(nodes, nodeData);
    const expanded = expandGameFurnaceSources(c, ["g1", "leaf1"]);
    expect(expanded!.map((n) => n.id)).toEqual(["leaf1", "leaf2"]);
  });

  it("嵌套 group 递归展开为最深叶子", () => {
    const nested = [node("outer", "group"), node("inner", "group", "outer"), node("deep", "text", "inner"), node("top", "text")];
    const c = canvas(nested, { deep: { prompt: "deep" }, top: { prompt: "top" } });
    expect(expandGameFurnaceSources(c, ["outer", "top"])!.map((n) => n.id)).toEqual(["deep", "top"]);
  });

  it("来源 ID 不存在 → 整批返回 null（不静默跳过）", () => {
    const c = canvas(nodes, nodeData);
    expect(expandGameFurnaceSources(c, ["leaf1", "ghost"])).toBeNull();
    expect(planGameFurnaceDrop(c, ["leaf1", "ghost"])).toBeNull();
  });

  it("仅含空结构组 → 无可收集内容，整批 null", () => {
    const c = canvas([node("empty", "group")], {});
    expect(expandGameFurnaceSources(c, ["empty"])).toEqual([]);
    expect(planGameFurnaceDrop(c, ["empty"])).toBeNull();
  });

  it("叶子无法解析为资源 → 整批拒绝，不部分提交", () => {
    // leaf1 是图片但没有 ready 输出资产 → resourceFromNode 返回 null。
    const c = canvas([node("leaf1", "image"), node("leaf2", "text")], { leaf2: { prompt: "ok" } });
    expect(planGameFurnaceDrop(c, ["leaf1", "leaf2"])).toBeNull();
  });

  it("全部可解析：生成单个原子 resources.add 操作与来源快照", () => {
    const c = canvas(nodes, nodeData);
    const plan = planGameFurnaceDrop(c, ["g1", "leaf3"])!;
    expect(plan.operations).toHaveLength(1);
    expect((plan.operations[0] as { type: string }).type).toBe("resources.add");
    expect((plan.operations[0] as { resources: GameResource[] }).resources.map((r) => r.source?.nodeId)).toEqual(["leaf1", "leaf2", "leaf3"]);
    expect(plan.sourceSnapshots!.map((s) => s.nodeId)).toEqual(["leaf1", "leaf2", "leaf3"]);
  });

  it("同次投放重放保持身份，新的投放保留同来源的独立副本", () => {
    const c = canvas([node("source", "text")], { source: { prompt: "original" } });
    const resources = (id: string) => (planGameFurnaceDrop(c, ["source"], id)!.operations[0] as { resources: GameResource[] }).resources;
    expect(resources("drop-a")).toEqual(resources("drop-a"));
    expect(resources("drop-a")[0].resourceId).not.toBe(resources("drop-b")[0].resourceId);
    expect(resources("drop-a")[0].payload).toEqual(resources("drop-b")[0].payload);
  });

  it("默认描述只来自确定性元数据，不猜测语义（任务 4.9）", () => {
    const asset = readyAsset("asset-hero", { mediaKind: "image", metadata: { storageKey: "key-asset-hero", contentType: "image/png", size: 2048 } });
    const c = canvas([node("img", "image")], { img: { outputAssetId: "asset-hero" } }, [asset]);
    const resource = (planGameFurnaceDrop(c, ["img"])!.operations[0] as { resources: GameResource[] }).resources[0]!;
    expect(resource.description).toContain("image/png");
    expect(resource.description).toContain("2048 字节");
    // 无 decoder 的未知文件：明示无自动预览，不虚构内容。
    const opaque = (planGameFurnaceDrop(canvas([node("u", "future-node")], { u: {} }), ["u"])!.operations[0] as { resources: GameResource[] }).resources[0]!;
    expect(opaque.description).toContain("无自动预览");
  });
});

// ---------------------------------------------------------------------------
// 任务 4.8：超 inline 预算 → overBudget 标记
// ---------------------------------------------------------------------------

describe("超 inline 预算处理（任务 4.8）", () => {
  it("大文本规划携带全文，权威转存前不丢失原件", () => {
    const text = "x".repeat(MAX_INLINE_TEXT_CHARS + 1);
    const c = canvas([node("t1", "text")], { t1: { prompt: text } });
    const plan = planGameFurnaceDrop(c, ["t1"])!;
    const resource = (plan.operations[0] as { resources: GameResource[] }).resources[0]!;
    expect(resource.payload.kind).toBe("text");
    expect(resource.payload.snapshot).toMatchObject({ overBudget: true, textChars: text.length });
    expect((resource.payload.snapshot as Record<string, unknown>).text).toBe(text);
  });

  it("大文本但有 ready 输出：引用输出资产 id", () => {
    const text = "y".repeat(MAX_INLINE_TEXT_CHARS + 5);
    const asset = readyAsset("asset-text", { mediaKind: "text", text });
    const c = canvas([node("t1", "text")], { t1: { outputAssetId: "asset-text" } }, [asset]);
    const plan = planGameFurnaceDrop(c, ["t1"])!;
    const resource = (plan.operations[0] as { resources: GameResource[] }).resources[0]!;
    expect(resource.payload.assetIds).toEqual(["asset-text"]);
    expect(resource.payload.snapshot).toMatchObject({ overBudget: true, text });
  });

  it("文本未超限：保留内联快照且无 overBudget", () => {
    const c = canvas([node("t1", "text")], { t1: { prompt: "hello" } });
    const resource = (planGameFurnaceDrop(c, ["t1"])!.operations[0] as { resources: GameResource[] }).resources[0]!;
    expect(resource.payload.snapshot).toEqual({ text: "hello" });
  });

  it("收集模型保留完整可解码定义，包括脚本语言与内容标识", () => {
    const data = createGameFurnaceNodeData();
    const c = canvas([node("m1", "model3d")], { m1: data });
    const resource = (planGameFurnaceDrop(c, ["m1"])!.operations[0] as { resources: GameResource[] }).resources[0]!;
    expect(decodeModelDefinition(resource.payload.snapshot)).toEqual(decodeModelDefinition(data));
    expect(decodeModelDefinition(resource.payload.snapshot).ok).toBe(true);
  });

  it("模型快照超限：保留完整内容并标记 overBudget（绝不截断）", () => {
    const script = "m".repeat(MAX_INLINE_SNAPSHOT_CHARS + 100);
    const c = canvas([node("m1", "model3d")], { m1: { modelScript: script } });
    const resource = (planGameFurnaceDrop(c, ["m1"])!.operations[0] as { resources: GameResource[] }).resources[0]!;
    expect(resource.payload.kind).toBe("model");
    expect((resource.payload.snapshot as Record<string, unknown>).overBudget).toBe(true);
    // 完整原件仍在（未截断）。
    expect((resource.payload.snapshot as { modelScript: string }).modelScript).toBe(script);
  });

  it("未知类型大数据：opaque 快照保留完整内容并标记 overBudget", () => {
    const big = "z".repeat(MAX_INLINE_SNAPSHOT_CHARS + 50);
    const c = canvas([node("u1", "future-node")], { u1: { payload: big } });
    const resource = (planGameFurnaceDrop(c, ["u1"])!.operations[0] as { resources: GameResource[] }).resources[0]!;
    expect(resource.kind).toBe("unknown");
    expect(resource.payload.kind).toBe("opaque");
    expect((resource.payload.snapshot as Record<string, unknown>).overBudget).toBe(true);
    expect(((resource.payload.snapshot as { nodeData: { payload: string } }).nodeData).payload).toBe(big);
  });
});

// ---------------------------------------------------------------------------
// 任务 4.7：操作系统文件 → 稳定资产 → 素材输入
// ---------------------------------------------------------------------------

describe("文件导入的 MIME 分类与稳定元数据（任务 4.7）", () => {
  it("按 MIME 派生素材类别", () => {
    expect(resourceKindForUpload({ type: "image/png" }).kind).toBe("image");
    expect(resourceKindForUpload({ type: "video/mp4" }).kind).toBe("video");
    expect(resourceKindForUpload({ type: "audio/mpeg" }).kind).toBe("audio");
    expect(resourceKindForUpload({ type: "text/plain" }).kind).toBe("text");
    expect(resourceKindForUpload({ type: "application/json" }).kind).toBe("text");
    // 无 decoder 的通用类型 → unknown，仍可保存原件。
    expect(resourceKindForUpload({ type: "application/octet-stream" }).kind).toBe("unknown");
    expect(resourceKindForUpload({}).kind).toBe("unknown");
  });

  it("稳定上传元数据缺字段返回 null（不写假 ready 项）", () => {
    const base = { storageKey: "k", checksum: "c", contentType: "image/png", size: 3 };
    expect(stableUploadMetadata(base)).toEqual({ storageKey: "k", checksum: "c", contentType: "image/png", size: 3 });
    expect(stableUploadMetadata({ ...base, storageKey: "" })).toBeNull();
    expect(stableUploadMetadata({ ...base, checksum: "" })).toBeNull();
    expect(stableUploadMetadata({ ...base, contentType: "" })).toBeNull();
    expect(stableUploadMetadata({ ...base, size: -1 })).toBeNull();
    expect(stableUploadMetadata({ ...base, size: Number.NaN })).toBeNull();
  });

  it("合法上传 → 素材输入：引用稳定资产 id，图片登记预览", () => {
    const resource = resourceFromUploadedFile({
      resourceId: "res-upload-abc",
      file: { name: "hero.png", type: "image/png", size: 3 },
      media: { storageKey: "k", checksum: "abc", contentType: "image/png", size: 3 },
      assetId: "asset-upload-abc"
    })!;
    expect(resource.kind).toBe("image");
    expect(resource.name).toBe("hero.png");
    expect(resource.payload).toEqual({ kind: "asset", assetIds: ["asset-upload-abc"] });
    expect(resource.metadata).toMatchObject({ mime: "image/png", size: 3, storageKey: "k", previewAssetId: "asset-upload-abc" });
  });

  it("缺稳定引用 / 非法 ID → null（调用方不得写假关联）", () => {
    const good = { resourceId: "res-1", file: { name: "a.txt", type: "text/plain", size: 1 }, media: { storageKey: "k", checksum: "c", contentType: "text/plain", size: 1 }, assetId: "asset-1" };
    expect(resourceFromUploadedFile(good)).not.toBeNull();
    expect(resourceFromUploadedFile({ ...good, media: { ...good.media, checksum: "" } })).toBeNull();
    expect(resourceFromUploadedFile({ ...good, assetId: "" })).toBeNull();
    expect(resourceFromUploadedFile({ ...good, resourceId: "bad id!" })).toBeNull();
  });

  it("planFileCollection 生成单个 resources.add 操作；非法输入返回 null", () => {
    const plan = planFileCollection({
      resourceId: "res-1",
      file: { name: "a.png", type: "image/png", size: 2 },
      media: { storageKey: "k", checksum: "c", contentType: "image/png", size: 2 },
      assetId: "asset-1"
    })!;
    expect((plan.operations[0] as { type: string }).type).toBe("resources.add");
    expect(planFileCollection({
      resourceId: "res-1",
      file: {},
      media: { storageKey: "", checksum: "", contentType: "", size: 0 },
      assetId: "asset-1"
    })).toBeNull();
  });

  it("上传资产按 MIME 映射受控 mediaKind；未知 MIME 保留为 file", () => {
    const image = stableAssetFromUpload({ assetId: "asset-1", file: { name: "a.png", type: "image/png" }, media: { storageKey: "k", checksum: "c", contentType: "image/png", size: 2 }, now: T })!;
    expect(image).toMatchObject({ id: "asset-1", mediaKind: "image", source: "uploaded", status: "ready", url: "/api/media/k" });
    const text = stableAssetFromUpload({ assetId: "asset-2", file: { name: "a.txt", type: "text/plain" }, media: { storageKey: "k2", checksum: "c2", contentType: "text/plain", size: 5 }, now: T })!;
    expect(text.mediaKind).toBe("text");
    const opaque = stableAssetFromUpload({ assetId: "asset-3", file: { name: "a.bin", type: "application/octet-stream" }, media: { storageKey: "k3", checksum: "c3", contentType: "application/octet-stream", size: 5 }, now: T })!;
    expect(opaque.mediaKind).toBe("file");
    // 缺稳定引用/非法 assetId 不产生假资产。
    expect(stableAssetFromUpload({ assetId: "bad id", file: { name: "x" }, media: { storageKey: "k", checksum: "c", contentType: "text/plain", size: 1 } })).toBeNull();
    expect(stableAssetFromUpload({ assetId: "asset-4", file: { name: "x" }, media: { storageKey: "", checksum: "c", contentType: "text/plain", size: 1 } })).toBeNull();
  });

  it("添加文件规划：稳定资产 + 素材在一次批次；确定性名称与描述（任务 4.9）", () => {
    const plan = planUploadedResourceCollection({
      resourceId: "res-upload-c",
      assetId: "asset-upload-c",
      file: { name: "hero.png", type: "image/png", size: 3 },
      media: { storageKey: "k", checksum: "c", contentType: "image/png", size: 3 },
      now: T
    })!;
    expect(plan.operations.map((op) => (op as { type: string }).type)).toEqual(["asset.upsert", "resources.add"]);
    const resource = (plan.operations[1] as { resources: GameResource[] }).resources[0]!;
    expect(resource.name).toBe("hero.png");
    expect(resource.description).toContain("image/png");
    expect(resource.description).toContain("3 字节");
    expect(resource.description).not.toContain("无自动预览");
    // 未命名文件的确定性名称回退默认分类，不猜测语义。
    expect(deriveResourceName({}, "unknown")).toBe("其他素材");
    expect(deriveResourceName({ name: "  " }, "image")).toBe("图片");
    // 缺稳定引用不产生部分批次。
    expect(planUploadedResourceCollection({ resourceId: "r", assetId: "a", file: {}, media: { storageKey: "", checksum: "", contentType: "", size: 0 } })).toBeNull();
  });

  it("长文件名可导入：素材显示名称满足契约，资产保留完整原名", () => {
    const filename = "UNBROKENFILENAME".repeat(16) + ".png";
    const plan = planUploadedResourceCollection({ resourceId: "r-long", assetId: "a-long", file: { name: filename, type: "image/png" },
      media: { storageKey: "sha256-long", checksum: "long", contentType: "image/png", size: 68 } });
    expect(plan).not.toBeNull();
    const asset = (plan!.operations[0] as any).asset;
    const resource = (plan!.operations[1] as any).resources[0];
    expect(asset.title).toBe(filename);
    expect(resource.name.length).toBeLessThanOrEqual(200);
    const next = reduceGameFurnace(createGameFurnaceState("long-name"), [plan!.operations[1]]);
    expect((next as any).resources[0]).toMatchObject({ resourceId: "r-long", name: resource.name });
  });

  it("上传状态文案可见：进行态与失败原因、恢复态（任务 4.9）", () => {
    expect(uploadStatusLabel({ id: "1", name: "hero.png", stage: "pending" })).toBe("待上传：hero.png");
    expect(uploadStatusLabel({ id: "1", name: "hero.png", stage: "uploading", progress: 42 })).toBe("上传中 42%：hero.png");
    expect(uploadStatusLabel({ id: "1", name: "hero.png", stage: "done" })).toBe("已添加：hero.png");
    expect(uploadStatusLabel({ id: "1", name: "hero.png", stage: "failed", error: "HTTP 500" })).toBe("上传失败：hero.png（HTTP 500）");
  });
});

it("来源内容身份覆盖完整文本尾部，保持有界且不受位置变化影响", () => {
  const prefix = "x".repeat(5000);
  const c = canvas([node("t", "text")], { t: { prompt: prefix + "a" } });
  const get = (value: ServerCanvas) => ((planGameFurnaceDrop(value, ["t"])!.operations[0] as { resources: GameResource[] }).resources[0]!).source!.sourceContentHash;
  const first = get(c);
  expect(first).toMatch(/^[a-f0-9]{16}$/);
  const moved = structuredClone(c); moved.document.nodes[0]!.position = { x: 200, y: 300 };
  expect(get(moved)).toBe(first);
  const changed = structuredClone(c); changed.nodeData.t = { prompt: prefix + "b" } as never;
  expect(get(changed)).not.toBe(first);
});


it.each(["image", "video", "audio", "model3d", "composite-asset", "future-node"])("%s 的显式依赖被完整冻结，缺稳定引用整批拒绝", (type) => {
  const asset = readyAsset("source-asset", { metadata: { storageKey: "sha256-source", contentType: "image/png", size: 5 } });
  const data = type === "image" || type === "video" || type === "audio" ? { outputAssetId: asset.id } : { assetIds: [asset.id], prompt: "全文", modelScript: "scene.group({id:'root'})" };
  const c = canvas([node("source", type)], { source: data }, [asset]);
  const planned = planGameFurnaceDrop(c, ["source"])!;
  const resource = (planned.operations[0] as { resources: GameResource[] }).resources[0]!;
  expect(resource.payload.assets).toEqual([{ assetId: asset.id, storageKey: "sha256-source", mime: "image/png", size: 5 }]);
  asset.metadata!.storageKey = "sha256-replaced";
  expect(resource.payload.assets![0]!.storageKey).toBe("sha256-source");
  c.assets[0]!.metadata = {};
  expect(planGameFurnaceDrop(c, ["source"])).toBeNull();
});

it("未知扩展的明确媒体引用冻结为依赖，不解析未知私有格式", () => {
  const c = canvas([node("source", "composite-asset")], { source: { extensionId: "future", mediaReferences: ["sha256-original"], privatePayload: { unknown: "complete" } } });
  const resource = (planGameFurnaceDrop(c, ["source"])!.operations[0] as { resources: GameResource[] }).resources[0]!;
  expect(resource.kind).toBe("unknown");
  expect(resource.payload.assets).toEqual([{ assetId: "sha256-original", storageKey: "sha256-original", mime: "application/octet-stream" }]);
  expect(resource.payload.snapshot).toMatchObject({ nodeData: { privatePayload: { unknown: "complete" } } });
});
