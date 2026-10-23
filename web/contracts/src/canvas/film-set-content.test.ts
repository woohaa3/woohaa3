/**
 * 片场内部内容契约测试
 * （change: 2026-10-08-make-film-set-model-only，任务 1.2/1.4/2.4/6.1）。
 */
import { describe, expect, it } from "vitest";
import {
  appendFilmSetItems,
  decodeFilmSetContent,
  defaultFilmSetContent,
  emptyFilmSetContent,
  extendedTimelineDuration,
  filmSetAssetReferences,
  filmSetContentHash,
  layoutFilmSetImport,
  planFilmSetImportItems,
  readFilmSetContent,
  remapFilmSetItemIds,
  type FilmSetItem
} from "./film-set-content.js";
import { createModelSnapshot } from "./animation-snapshot.js";

function modelItem(id: string): FilmSetItem {
  const model = createModelSnapshot({ modelScript: `scene.box({ id: "${id}" });`, modelScriptVersion: "woohaa-model-js-v2" });
  return {
    id,
    kind: "model",
    name: id,
    localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
    model
  };
}

describe("片场内容 codec（任务 1.2）", () => {
  it("缺失字段解释为空集合", () => {
    expect(decodeFilmSetContent(undefined)).toEqual({ ok: true, value: emptyFilmSetContent() });
    expect(readFilmSetContent({}).items).toEqual([]);
  });

  it("默认片场带一块可编辑地面", () => {
    const content = defaultFilmSetContent();
    expect(content.items).toHaveLength(1);
    expect(content.items[0]?.kind).toBe("ground");
  });

  it("合法集合 round-trip；非法 kind / 重复 id 整条拒绝，对象数量不设额度", () => {
    const content = { schemaVersion: 3, items: [modelItem("a"), { id: "img", kind: "image", name: "图", localTransform: { offset: { x: 1, y: 0, z: 0 }, scale: 1, yaw: 0 }, assetId: "asset-1", aspectRatio: 1.5 }] };
    const decoded = decodeFilmSetContent(content);
    expect(decoded.ok).toBe(true);
    expect(decodeFilmSetContent({ schemaVersion: 3, items: [{ id: "x", kind: "unknown", name: "x" }] }).ok).toBe(false);
    expect(decodeFilmSetContent({ schemaVersion: 3, items: [modelItem("dup"), modelItem("dup")] }).ok).toBe(false);
    // change: 2026-10-22-remove-agent-execution-limits，任务 5.4：原 128 对象额度已删除。
    expect(decodeFilmSetContent({ schemaVersion: 3, items: Array.from({ length: 300 }, (_, i) => modelItem(`m${i}`)) }).ok).toBe(true);
  });

  it("媒体引用参与资产枚举，ground/model 不产生媒体引用", () => {
    const content = {
      schemaVersion: 3 as const,
      items: [
        modelItem("a"),
        { id: "img", kind: "image" as const, name: "图", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, assetId: "asset-1", aspectRatio: 1 },
        { id: "vid", kind: "video" as const, name: "视", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, assetId: "asset-2", aspectRatio: 1 }
      ]
    };
    expect(filmSetAssetReferences(content)).toEqual(["asset-1", "asset-2"]);
  });
});

describe("片场导入规划与重映射（任务 2.4/1.4）", () => {
  it("错开布局不重排已有内容；空内容第一项落在原点", () => {
    const transforms = layoutFilmSetImport({ existing: [], count: 1 });
    expect(transforms[0]?.offset).toEqual({ x: -3.75, y: 0, z: 0 });
  });

  it("批次含不支持来源整批拒绝，不部分追加", () => {
    const planned = planFilmSetImportItems({
      existingItems: [],
      drafts: [
        { id: "ok", source: { kind: "image", name: "图", assetId: "asset-1", aspectRatio: 1 } },
        { id: "ok", source: { kind: "video", name: "视", assetId: "asset-1", aspectRatio: 1 } }
      ],
      importedAt: "2026-10-08T00:00:00Z"
    });
    expect(planned.ok).toBe(false);
  });

  it("追加不改动已有内容；重映射只改内部 id 保留 assetId", () => {
    const existing = defaultFilmSetContent();
    const planned = planFilmSetImportItems({
      existingItems: existing.items,
      drafts: [{ id: "img", source: { kind: "image", name: "图", assetId: "asset-1", aspectRatio: 2 } }],
      importedAt: "2026-10-08T00:00:00Z"
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const appended = appendFilmSetItems(existing, planned.items);
    expect(appended.items[0]).toEqual(existing.items[0]);
    const remapped = remapFilmSetItemIds(appended, (_item, index) => `new-${index}`);
    expect(remapped.items.map((item) => item.id)).toEqual(["new-0", "new-1"]);
    const media = remapped.items[1];
    expect(media?.kind === "image" && media.assetId).toBe("asset-1");
  });

  it("内容 hash 随媒体与模型变化", () => {
    const base = defaultFilmSetContent();
    const withItem = appendFilmSetItems(base, [modelItem("m")]);
    expect(filmSetContentHash(base)).not.toBe(filmSetContentHash(withItem));
  });

  it("视频导入扩展时间线时长但不超出现有最大值", () => {
    expect(extendedTimelineDuration(0, [
      { id: "v", source: { kind: "video", name: "视", assetId: "a", aspectRatio: 1, durationSeconds: 12 } }
    ])).toBe(12);
    expect(extendedTimelineDuration(20, [
      { id: "v", source: { kind: "video", name: "视", assetId: "a", aspectRatio: 1, durationSeconds: 12 } }
    ])).toBe(20);
    expect(extendedTimelineDuration(5, [
      { id: "i", source: { kind: "image", name: "图", assetId: "a", aspectRatio: 1 } }
    ])).toBe(5);
  });
});
