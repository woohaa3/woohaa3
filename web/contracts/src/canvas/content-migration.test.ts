import { describe, expect, it } from "vitest";
import { ContentContributionRegistry, migrateContentNodeData, type ContentNodeDataCodec } from "./content-contribution.js";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";
import { normalizeCanvas } from "./domain/normalization.js";
import { filmSetContentContribution, filmSetNodeDataCodec } from "./film-set-content.js";

function codec(schemaVersion: (data: unknown) => number | null): ContentNodeDataCodec {
  return {
    decode: () => ({ ok: true, value: {} }),
    validatePatch: () => null,
    normalize: (data) => data,
    sanitizeRuntime: (data) => data,
    copy: (data) => ({ data, assetRefs: [], remap: {} }),
    diff: () => ({ ok: true, forward: {}, inverse: {} }),
    schemaVersion
  };
}

function registry() {
  const content = new ContentContributionRegistry();
  content.register({
    extensionId: "sample",
    contentVersion: 3,
    nodeData: codec((data) => {
      const version = (data as { schemaVersion?: unknown }).schemaVersion;
      return typeof version === "number" ? version : null;
    }),
    migrations: [
      { extensionId: "sample", from: 1, to: 2, migrate: (data) => ({ ...(data as object), schemaVersion: 2, step: "one" }) },
      { extensionId: "sample", from: 2, to: 3, migrate: (data) => ({ ...(data as object), schemaVersion: 3, step: "two" }) }
    ]
  });
  return content;
}

describe("内容迁移", () => {
  it("按顺序升级，重复执行不再改写", () => {
    const content = registry();
    const first = migrateContentNodeData({ schemaVersion: 1, keep: true }, content);
    expect(first).toEqual({ data: { schemaVersion: 3, keep: true, step: "two" }, readOnly: false, applied: [2, 3] });
    expect(migrateContentNodeData(first.data, content)).toEqual({ data: first.data, readOnly: false, applied: [] });
  });

  it("迁移失败不推进版本，原数据保持不变", () => {
    const content = new ContentContributionRegistry();
    const original = { schemaVersion: 1, keep: true };
    content.register({
      extensionId: "sample",
      contentVersion: 2,
      nodeData: codec((data) => (data as { schemaVersion: number }).schemaVersion),
      migrations: [{ extensionId: "sample", from: 1, to: 2, migrate: () => { throw new Error("secret migration detail"); } }]
    });
    expect(migrateContentNodeData(original, content)).toEqual({ data: original, readOnly: false, applied: [] });
  });

  it("版本过新或缺少中间迁移时只读保留", () => {
    const content = registry();
    const newer = { schemaVersion: 4, keep: true };
    expect(migrateContentNodeData(newer, content)).toEqual({ data: newer, readOnly: true, applied: [] });
    const gapped = new ContentContributionRegistry();
    gapped.register({
      extensionId: "sample",
      contentVersion: 3,
      nodeData: codec((data) => (data as { schemaVersion: number }).schemaVersion),
      migrations: [{ extensionId: "sample", from: 2, to: 3, migrate: (data) => data }]
    });
    const older = { schemaVersion: 1 };
    expect(migrateContentNodeData(older, gapped)).toEqual({ data: older, readOnly: true, applied: [] });
  });

  it("片场组版本过新时读取保留 marker", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("canvas", "2026-11-02T00:00:00.000Z");
    canvas.document.nodes = [{ id: "film", type: "group", position: { x: 0, y: 0 } }];
    canvas.nodeData = { film: { filmSetGroup: { schemaVersion: 99, sceneBindings: [] } } as never };
    const content = new ContentContributionRegistry();
    content.register(filmSetContentContribution);
    expect(normalizeCanvas(canvas, { content }).nodeData.film?.filmSetGroup).toEqual({ schemaVersion: 99, sceneBindings: [] });
    expect(normalizeCanvas(canvas).nodeData.film?.filmSetGroup).toBeUndefined();
  });

  it("传入片场 codec 时，当前版本的非法 marker 保留，非 group 仍删除", () => {
    const content = new ContentContributionRegistry();
    content.register(filmSetContentContribution);
    const canvas = createEmptyWoohaa3ServerCanvas("canvas", "2026-11-02T00:00:00.000Z");
    const marker = { schemaVersion: 1, sceneBindings: "nope" };
    canvas.document.nodes = [
      { id: "film", type: "group", position: { x: 0, y: 0 } },
      { id: "card", type: "model3d", position: { x: 0, y: 0 } }
    ];
    canvas.nodeData = {
      film: { filmSetGroup: marker } as never,
      card: { filmSetGroup: marker } as never
    };
    const normalized = normalizeCanvas(canvas, { content });
    expect(normalized.nodeData.film?.filmSetGroup).toEqual(marker);
    expect(normalized.nodeData.card?.filmSetGroup).toBeUndefined();
    expect(normalizeCanvas(canvas).nodeData.film?.filmSetGroup).toBeUndefined();

    const throwing = new ContentContributionRegistry();
    throwing.register({
      extensionId: "film-set",
      contentVersion: 1,
      nodeData: { ...filmSetNodeDataCodec, normalize: () => { throw new Error("secret normalize detail"); } }
    });
    expect(normalizeCanvas(canvas, { content: throwing }).nodeData.film?.filmSetGroup).toEqual(marker);
  });
});
