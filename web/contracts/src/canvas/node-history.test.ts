/**
 * 节点生成历史契约测试
 * （change: add-canvas-node-generation-history，任务 1.1）。
 *
 * 覆盖：稳定 entryId / identity 编解码、opaque cursor 稳定性、安全列表派生（不泄露正文、
 * storageKey、完整脚本）、详情派生、反序列化边界，以及「完整历史不进入 Y.Doc」。
 */
import { describe, expect, it } from "vitest";
import {
  NODE_GENERATION_HISTORY_VERSION,
  decodeNodeGenerationHistoryEntry,
  decodeNodeGenerationIdentity,
  decodeNodeHistoryCursor,
  encodeNodeGenerationIdentity,
  encodeNodeHistoryCursor,
  emptyNodeHistoryKindCounts,
  nodeHistoryEntryId,
  nodeHistoryKindForNodeType,
  nodeTypesForHistoryKind,
  normalizeCanvasHistoryQuery,
  normalizeNodeHistoryQuery,
  modelPlacementSnapshotKey,
  nodeHistoryContentIdentity,
  toCanvasHistoryListItem,
  toNodeHistoryDetail,
  toNodeHistoryListItem,
  type NodeGenerationHistoryEntry,
  type NodeHistoryContentPayload
} from "../canvas/node-history.js";
import { serverCanvasToYDoc, yDocToServerCanvas } from "../canvas/yjs/mapping.js";
import { createEmptyWoohaa3ServerCanvas } from "../canvas/domain/aggregate.js";
import { COMPOSITE_ASSET_NODE_TYPE } from "../canvas/domain/core/composite-asset-identity.js";

const CANVAS = "canvas-1";
const NODE = "node-1";

function textEntry(overrides: Partial<NodeGenerationHistoryEntry> = {}): NodeGenerationHistoryEntry {
  const identity = { kind: "task-run" as const, runId: "run-1" };
  const base: NodeGenerationHistoryEntry = {
    version: NODE_GENERATION_HISTORY_VERSION,
    entryId: nodeHistoryEntryId({ canvasId: CANVAS, nodeId: NODE, identity }),
    canvasId: CANVAS,
    nodeId: NODE,
    kind: "text",
    createdAt: "2026-09-27T00:00:00.000Z",
    sourceIdentity: encodeNodeGenerationIdentity(identity),
    currentIdentity: encodeNodeGenerationIdentity(identity),
    recoverable: true,
    previewable: true,
    source: { label: "文本生成", runId: "run-1" },
    payload: { kind: "text", text: "x".repeat(5000) }
  };
  return { ...base, ...overrides };
}

describe("节点历史契约", () => {
  it("entryId 由稳定 identity 派生，重复来源得到同一 id", () => {
    const identity = { kind: "task-run" as const, runId: "run-1" };
    const a = nodeHistoryEntryId({ canvasId: CANVAS, nodeId: NODE, identity });
    const b = nodeHistoryEntryId({ canvasId: CANVAS, nodeId: NODE, identity });
    const other = nodeHistoryEntryId({ canvasId: CANVAS, nodeId: NODE, identity: { kind: "task-run", runId: "run-2" } });
    expect(a).toBe(b);
    expect(a).not.toBe(other);
  });

  it("identity 编解码可往返且拒绝畸形输入", () => {
    expect(decodeNodeGenerationIdentity(encodeNodeGenerationIdentity({ kind: "task-run", runId: "r" })))
      .toEqual({ kind: "task-run", runId: "r" });
    expect(decodeNodeGenerationIdentity(encodeNodeGenerationIdentity({ kind: "model-source", sourceHash: "abc" })))
      .toEqual({ kind: "model-source", sourceHash: "abc" });
    expect(
      decodeNodeGenerationIdentity(encodeNodeGenerationIdentity({ kind: "model-edit", sourceHash: "abc", snapshotKey: "k1" }))
    ).toEqual({ kind: "model-edit", sourceHash: "abc", snapshotKey: "k1" });
    expect(decodeNodeGenerationIdentity("unknown:1")).toBeNull();
    expect(decodeNodeGenerationIdentity("task-run:")).toBeNull();
    expect(decodeNodeGenerationIdentity("model-edit:onlyhash")).toBeNull();
    expect(decodeNodeGenerationIdentity(42)).toBeNull();
  });

  it("模型编辑 identity 由 (sourceHash, 摆放快照) 派生且稳定", () => {
    const placement = { offset: { x: 1, y: 2, z: 3 }, scale: 1.5, yaw: 0.4 };
    const key = modelPlacementSnapshotKey(placement);
    expect(modelPlacementSnapshotKey({ ...placement, offset: { ...placement.offset } })).toBe(key);
    expect(modelPlacementSnapshotKey({ ...placement, scale: 2 })).not.toBe(key);
    const identity = { kind: "model-edit" as const, sourceHash: "hash", snapshotKey: key };
    expect(nodeHistoryEntryId({ canvasId: CANVAS, nodeId: NODE, identity }))
      .toBe(nodeHistoryEntryId({ canvasId: CANVAS, nodeId: NODE, identity }));
  });

  it("节点类型映射到历史种类", () => {
    expect(nodeHistoryKindForNodeType("model3d")).toBe("model");
    expect(nodeHistoryKindForNodeType(COMPOSITE_ASSET_NODE_TYPE)).toBe("model");
    expect(nodeHistoryKindForNodeType("audio")).toBe("audio");
    expect(nodeHistoryKindForNodeType("generate")).toBeNull();
    expect(nodeHistoryKindForNodeType("start")).toBeNull();
    expect(nodeTypesForHistoryKind("model")).toContain("model3d");
  });

  it("cursor 编解码可往返且接受 createdAt+entryId", () => {
    const cursor = encodeNodeHistoryCursor({ createdAt: "2026-09-27T00:00:00.000Z", entryId: "ngh-abc" });
    expect(decodeNodeHistoryCursor(cursor)).toEqual({ createdAt: "2026-09-27T00:00:00.000Z", entryId: "ngh-abc" });
    expect(decodeNodeHistoryCursor("not-a-cursor")).toBeNull();
    expect(decodeNodeHistoryCursor("")).toBeNull();
  });

  it("normalizeNodeHistoryQuery 钳制 limit 并保留合法 cursor", () => {
    expect(normalizeNodeHistoryQuery({ limit: 999 }).limit).toBeLessThanOrEqual(100);
    expect(normalizeNodeHistoryQuery({}).limit).toBeGreaterThan(0);
    expect(normalizeNodeHistoryQuery({ cursor: "abc" }).cursor).toBe("abc");
    expect(normalizeNodeHistoryQuery({ cursor: "" }).cursor).toBeUndefined();
  });

  it("normalizeCanvasHistoryQuery 钳制 limit、保留合法 kind 与 cursor", () => {
    expect(normalizeCanvasHistoryQuery({ limit: 999 }).limit).toBeLessThanOrEqual(100);
    expect(normalizeCanvasHistoryQuery({}).limit).toBeGreaterThan(0);
    expect(normalizeCanvasHistoryQuery({ kind: "image" }).kind).toBe("image");
    expect(normalizeCanvasHistoryQuery({ kind: "unknown" }).kind).toBeUndefined();
    expect(normalizeCanvasHistoryQuery({ kind: 42 }).kind).toBeUndefined();
    expect(normalizeCanvasHistoryQuery({ cursor: "abc" }).cursor).toBe("abc");
    expect(normalizeCanvasHistoryQuery({ cursor: "" }).cursor).toBeUndefined();
    expect(emptyNodeHistoryKindCounts()).toEqual({ text: 0, image: 0, video: 0, audio: 0, model: 0 });
  });

  it("列表项不泄露完整正文、storageKey 或完整脚本", () => {
    const entry = textEntry();
    const item = toNodeHistoryListItem(entry, { current: false, previewHref: () => "/api/nope" });
    const json = JSON.stringify(item);
    expect(item.preview).toMatchObject({ kind: "text" });
    expect(json).not.toContain("x".repeat(1000));
    expect(json).not.toContain("storageKey");

    const media: NodeGenerationHistoryEntry = {
      ...entry,
      kind: "image",
      payload: { kind: "image", storageKey: "sha256-" + "a".repeat(64), checksum: "a".repeat(64), contentType: "image/png", size: 10 }
    };
    const mediaItem = toNodeHistoryListItem(media, { current: true, previewHref: (suffix) => `/api/canvas-node-history/x/${suffix}` });
    const mediaJson = JSON.stringify(mediaItem);
    expect(mediaJson).not.toContain("sha256-");
    expect(mediaItem.current).toBe(true);
    expect(mediaItem.preview).toMatchObject({ kind: "image", href: expect.stringContaining("preview") });
  });

  it("画布级列表项补充 nodeId 与安全标题且同样不泄露正文/storageKey", () => {
    const entry = textEntry();
    const item = toCanvasHistoryListItem(entry, {
      current: false,
      previewHref: () => "/api/nope",
      nodeTitle: "标题"
    });
    expect(item).toMatchObject({ nodeId: NODE, nodeTitle: "标题", entryId: entry.entryId, kind: "text" });
    const json = JSON.stringify(item);
    expect(json).not.toContain("x".repeat(1000));
    expect(json).not.toContain("storageKey");

    const media: NodeGenerationHistoryEntry = {
      ...entry,
      kind: "video",
      payload: {
        kind: "video",
        storageKey: "sha256-" + "a".repeat(64),
        checksum: "a".repeat(64),
        contentType: "video/mp4",
        size: 10
      }
    };
    const mediaItem = toCanvasHistoryListItem(media, {
      current: true,
      previewHref: (suffix) => `/api/canvas-node-history/x/${suffix}`,
      nodeTitle: "视频节点"
    });
    expect(JSON.stringify(mediaItem)).not.toContain("sha256-");
    expect(mediaItem.preview).toMatchObject({ kind: "video", href: expect.stringContaining("preview") });
  });

  it("详情按 entryId 返回完整内容", () => {
    const entry = textEntry();
    expect(toNodeHistoryDetail(entry)).toMatchObject({ kind: "text", text: "x".repeat(5000) });
    const model: NodeGenerationHistoryEntry = {
      ...entry,
      kind: "model",
      payload: { kind: "model", modelScript: "build(()=>{})", language: "javascript", version: "woohaa-model-js-v2", sourceHash: "hash" }
    };
    expect(toNodeHistoryDetail(model)).toMatchObject({ kind: "model", modelScript: "build(()=>{})", sourceHash: "hash" });
    // 编辑版本携带摆放：详情派生保留，便于恢复时写回。
    const placement = { offset: { x: 1, y: 2, z: 3 }, scale: 1.5, yaw: 0.4 };
    const edit: NodeGenerationHistoryEntry = {
      ...model,
      payload: {
        kind: "model",
        modelScript: "build(()=>{})",
        language: "javascript",
        version: "woohaa-model-js-v2",
        sourceHash: "hash",
        placement
      }
    };
    expect(toNodeHistoryDetail(edit)).toMatchObject({ kind: "model", placement });
    // 反序列化保留合法摆放、拒绝非法摆放。
    const decoded = decodeNodeGenerationHistoryEntry({ ...edit, sourceIdentity: "model-edit:hash:k1" } as never);
    expect(decoded.ok && decoded.value.payload).toMatchObject({ kind: "model", placement });
    const bad = decodeNodeGenerationHistoryEntry({
      ...edit,
      sourceIdentity: "model-edit:hash:k1",
      payload: { ...(edit.payload as object), placement: { offset: { x: 1, y: 2, z: 3 }, scale: "x", yaw: 0 } }
    } as never);
    expect(bad.ok).toBe(false);
  });

  it("反序列化接受合法条目并拒绝畸形条目", () => {
    const decoded = decodeNodeGenerationHistoryEntry(textEntry());
    expect(decoded.ok).toBe(true);
    expect(decodeNodeGenerationHistoryEntry({ ...textEntry(), version: "bad" }).ok).toBe(false);
    expect(decodeNodeGenerationHistoryEntry({ ...textEntry(), kind: "unknown" }).ok).toBe(false);
    expect(decodeNodeGenerationHistoryEntry({ ...textEntry(), payload: { kind: "text", text: 42 } }).ok).toBe(false);
  });

  it("图片编辑版本 payload 保留原图 metadata 与定义，纯媒体旧条目继续可读", () => {
    const entry = textEntry();
    const baseStorageKey = "sha256-" + "a".repeat(64);
    const outputStorageKey = "generation-outputs/" + "b".repeat(64) + ".png";
    const imageEdit = {
      version: "woohaa-image-edit-v1" as const,
      baseAssetId: "asset-base",
      sourceWidth: 100,
      sourceHeight: 80,
      shapes: [
        { id: "s1", tool: "pen" as const, color: "#ff3b30", widthInSourcePixels: 2, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] }
      ]
    };
    const editEntry: NodeGenerationHistoryEntry = {
      ...entry,
      kind: "image",
      payload: {
        kind: "image",
        storageKey: outputStorageKey,
        checksum: "c".repeat(64),
        contentType: "image/png",
        size: 100,
        base: { baseAssetId: "asset-base", storageKey: baseStorageKey, checksum: "a".repeat(64), contentType: "image/png", size: 50, sourceWidth: 100, sourceHeight: 80 },
        imageEdit
      }
    };
    const decoded = decodeNodeGenerationHistoryEntry(editEntry as never);
    expect(decoded.ok).toBe(true);
    if (decoded.ok && decoded.value.payload.kind === "image") {
      const stored = decoded.value.payload.imageEdit;
      expect(stored?.version).toBe("woohaa-image-edit-v1");
      if (stored && stored.version === "woohaa-image-edit-v1") expect(stored.shapes).toHaveLength(1);
      expect(decoded.value.payload.base?.storageKey).toBe(baseStorageKey);
    }
    const detail = toNodeHistoryDetail(editEntry);
    expect(detail).toMatchObject({ kind: "image", imageEdit: { baseAssetId: "asset-base" } });

    // 纯媒体旧条目（无 base/imageEdit）继续可读。
    const pureMedia: NodeGenerationHistoryEntry = {
      ...entry,
      kind: "image",
      payload: { kind: "image", storageKey: baseStorageKey, checksum: "a".repeat(64), contentType: "image/png", size: 50 }
    };
    expect(decodeNodeGenerationHistoryEntry(pureMedia as never).ok).toBe(true);

    // 携带 shapes 但缺 base metadata 的条目被拒绝（不能猜测原图）。
    const missingBase = { ...editEntry, payload: { ...(editEntry.payload as object), base: undefined } };
    expect(decodeNodeGenerationHistoryEntry(missingBase as never).ok).toBe(false);

    // 非法引用（跨画布伪造 storageKey/尺寸不一致）被拒绝。
    const badBase = {
      ...editEntry,
      payload: { ...(editEntry.payload as object), base: { baseAssetId: "asset-base", storageKey: baseStorageKey, checksum: "a".repeat(64), contentType: "image/png", size: 50, sourceWidth: 200, sourceHeight: 80 } }
    };
    expect(decodeNodeGenerationHistoryEntry(badBase as never).ok).toBe(false);
  });

  it("图片编辑身份区分纯媒体与可编辑定义", () => {
    const entry = textEntry();
    const baseStorageKey = "sha256-" + "a".repeat(64);
    const outputStorageKey = "generation-outputs/" + "b".repeat(64) + ".png";
    const editEntry: NodeGenerationHistoryEntry = {
      ...entry,
      kind: "image",
      payload: {
        kind: "image",
        storageKey: outputStorageKey,
        checksum: "c".repeat(64),
        contentType: "image/png",
        size: 100,
        base: { baseAssetId: "asset-base", storageKey: baseStorageKey, checksum: "a".repeat(64), contentType: "image/png", size: 50, sourceWidth: 100, sourceHeight: 80 },
        imageEdit: { version: "woohaa-image-edit-v1", baseAssetId: "asset-base", sourceWidth: 100, sourceHeight: 80, shapes: [] }
      }
    };
    const pureMedia: NodeGenerationHistoryEntry = {
      ...entry,
      kind: "image",
      payload: { kind: "image", storageKey: outputStorageKey, checksum: "c".repeat(64), contentType: "image/png", size: 100 }
    };
    const editIdentity = decodeNodeGenerationHistoryEntry({ ...editEntry, currentIdentity: nodeHistoryContentIdentity(editEntry.payload as NodeHistoryContentPayload) } as never);
    const mediaIdentity = decodeNodeGenerationHistoryEntry({ ...pureMedia, currentIdentity: nodeHistoryContentIdentity(pureMedia.payload as NodeHistoryContentPayload) } as never);
    expect(editIdentity.ok && editIdentity.value.currentIdentity.startsWith("image-edit:")).toBe(true);
    expect(mediaIdentity.ok && mediaIdentity.value.currentIdentity.startsWith("media:")).toBe(true);
  });

  it("模型历史 payload 可选规范镜头快照且旧条目保留兼容", () => {
    const entry = textEntry();
    const modelBase = { kind: "model" as const, modelScript: "build(()=>{})", language: "javascript", version: "woohaa-model-js-v2", sourceHash: "hash" };
    const withCameras = {
      ...entry,
      kind: "model",
      sourceIdentity: "model-edit:hash:k1",
      payload: {
        ...modelBase,
        placement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
        modelCameras: [{ id: "cam-1", name: "镜头 1", order: 0, azimuth: 0, elevation: 0, distance: 5, aspect: "16:9" }]
      }
    };
    const decoded = decodeNodeGenerationHistoryEntry(withCameras as never);
    expect(decoded.ok).toBe(true);
    if (decoded.ok && decoded.value.payload.kind === "model") {
      expect(decoded.value.payload.modelCameras).toHaveLength(1);
    }
    expect(toNodeHistoryDetail(withCameras as NodeGenerationHistoryEntry)).toMatchObject({ kind: "model", modelCameras: expect.any(Array) });

    // 旧条目无镜头快照继续可读；详情缺省该字段。
    const withoutCameras = { ...entry, kind: "model", payload: modelBase };
    expect(decodeNodeGenerationHistoryEntry(withoutCameras as never).ok).toBe(true);
    expect(toNodeHistoryDetail(withoutCameras as NodeGenerationHistoryEntry)).not.toHaveProperty("modelCameras");

    // 非法镜头集合被拒绝。
    const badCameras = { ...withCameras, payload: { ...withCameras.payload, modelCameras: [{ id: "cam-1" }] } };
    expect(decodeNodeGenerationHistoryEntry(badCameras as never).ok).toBe(false);
  });

  it("失败归档 payload 结构化且与 outcome 一致（change: 2026-10-12）", () => {
    const failure = {
      version: NODE_GENERATION_HISTORY_VERSION,
      entryId: "ngh-failure-1",
      canvasId: CANVAS,
      nodeId: NODE,
      kind: "image",
      createdAt: "2026-10-12T00:00:00.000Z",
      outcome: "failed",
      sourceIdentity: "task-run-failure:run-9",
      currentIdentity: "media:key-1",
      recoverable: false,
      previewable: false,
      source: { label: "图片生成", runId: "run-9" },
      payload: {
        kind: "failure",
        outcome: "failed",
        failureKind: "image",
        message: "provider 超时",
        code: "provider-timeout",
        baseline: { identity: "media:baseline-key", nodeType: "image", outputAssetId: "asset-before" },
        inputSummary: "海边日落"
      }
    };
    const decoded = decodeNodeGenerationHistoryEntry(failure as never);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const entry = decoded.value;
    // 失败记录强制不可恢复（即便外部误传 recoverable:true）。
    const forced = decodeNodeGenerationHistoryEntry({ ...failure, recoverable: true } as never);
    expect(forced.ok && forced.value.recoverable).toBe(false);
    // 列表项把失败记录标为不可恢复且非当前。
    const item = toNodeHistoryListItem(entry, { current: true, previewHref: () => "x" });
    expect(item.outcome).toBe("failed");
    expect(item.current).toBe(false);
    expect(item.recoverable).toBe(false);
    expect(item.preview).toMatchObject({ kind: "failure", outcome: "failed" });
    // 详情暴露失败原因与基线，但不含产物。
    const detail = toNodeHistoryDetail(entry);
    expect(detail).toMatchObject({ kind: "failure", failureKind: "image", message: "provider 超时" });
    // outcome 与 payload 不一致时整条拒绝。
    const mismatched = decodeNodeGenerationHistoryEntry({ ...failure, outcome: "succeeded" } as never);
    expect(mismatched.ok).toBe(false);
    // 失败 payload 缺 outcome 拒绝。
    const noOutcome = decodeNodeGenerationHistoryEntry({
      ...failure,
      payload: { ...failure.payload, outcome: undefined }
    } as never);
    expect(noOutcome.ok).toBe(false);
    // 旧条目缺 outcome：不落字段（保持 round-trip 保真），消费方按缺省=succeeded 处理。
    const legacy = textEntry();
    const legacyDecoded = decodeNodeGenerationHistoryEntry({ ...legacy, outcome: undefined } as never);
    expect(legacyDecoded.ok).toBe(true);
    expect(legacyDecoded.ok && legacyDecoded.value.outcome).toBeUndefined();
    expect(legacyDecoded.ok && legacyDecoded.value.recoverable).toBe(legacy.recoverable);
  });

  it("完整历史不进入 Y.Doc / ServerCanvas", () => {
    const canvas = createEmptyWoohaa3ServerCanvas(CANVAS, "2026-09-27T00:00:00.000Z");
    const doc = serverCanvasToYDoc(canvas);
    const roundtrip = yDocToServerCanvas(doc, { now: "2026-09-27T00:00:00.000Z" });
    expect(roundtrip.ok).toBe(true);
    if (!roundtrip.ok) return;
    const json = JSON.stringify(roundtrip.canvas);
    expect(json).not.toContain("nodeGenerationHistory");
    expect(json).not.toContain("ngh-");
  });
});
