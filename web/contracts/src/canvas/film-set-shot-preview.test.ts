/**
 * 拍摄镜头预览契约测试（change: 2026-10-15-add-film-set-shooting-shot-previews，任务 1.4）。
 *
 * 覆盖：严格归属 codec、完整 SHA-256 稳定身份、长度/碰撞约束、从源镜头派生目标与确定性初始布局。
 */
import { describe, expect, it } from "vitest";
import {
  FILM_SET_SHOT_PREVIEW_NODE_TYPE,
  SHOT_PREVIEW_CARD_WIDTH,
  SHOT_PREVIEW_HEADER_HEIGHT,
  SHOT_PREVIEW_ID_PREFIX,
  SHOT_PREVIEW_SCHEMA_VERSION,
  canonicalShotPreviewFields,
  decodeShotPreviewData,
  isShotPreviewNodeData,
  isShotPreviewNodeId,
  planShotPreviewLayout,
  shotAspectValue,
  shotPreviewCardSize,
  shotPreviewContentHeight,
  shotPreviewNodeId,
  shotPreviewOwnershipOf,
  shotPreviewSha256Hex,
  shotPreviewTargetsOf
} from "./film-set-shot-preview.js";
import { FILM_SET_ANIMATIONS_VERSION } from "./film-set-animations.js";

describe("预览归属 codec", () => {
  it("接受唯一合法形状并规范化", () => {
    const decoded = decodeShotPreviewData({ shotPreview: { schemaVersion: 1, filmSetNodeId: "film", clipId: "a" } });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.shotPreview).toEqual({ schemaVersion: 1, filmSetNodeId: "film", clipId: "a" });
    expect(canonicalShotPreviewFields(decoded.value)).toEqual({ shotPreview: { schemaVersion: 1, filmSetNodeId: "film", clipId: "a" } });
  });

  it("拒绝错误版本、缺失归属与非法引用", () => {
    expect(decodeShotPreviewData({ shotPreview: { schemaVersion: 2, filmSetNodeId: "f", clipId: "a" } }).ok).toBe(false);
    expect(decodeShotPreviewData({ shotPreview: { schemaVersion: 1, filmSetNodeId: "", clipId: "a" } }).ok).toBe(false);
    expect(decodeShotPreviewData({ shotPreview: { schemaVersion: 1, filmSetNodeId: "f" } }).ok).toBe(false);
    expect(decodeShotPreviewData({}).ok).toBe(false);
    expect(decodeShotPreviewData(null).ok).toBe(false);
    expect(decodeShotPreviewData({ shotPreview: { schemaVersion: 1, filmSetNodeId: "f", clipId: "a" }, outputAssetId: "x" }).ok).toBe(true);
  });

  it("读取归属与守卫", () => {
    expect(shotPreviewOwnershipOf({ shotPreview: { schemaVersion: 1, filmSetNodeId: "f", clipId: "a" } })).toEqual({ schemaVersion: 1, filmSetNodeId: "f", clipId: "a" });
    expect(shotPreviewOwnershipOf({})).toBeNull();
    expect(isShotPreviewNodeData({ shotPreview: { schemaVersion: 1, filmSetNodeId: "f", clipId: "a" } })).toBe(true);
    expect(isShotPreviewNodeData({ title: "x" })).toBe(false);
    expect(FILM_SET_SHOT_PREVIEW_NODE_TYPE).toBe("film-set-shot-preview");
    expect(SHOT_PREVIEW_SCHEMA_VERSION).toBe(1);
  });
});

describe("稳定节点身份", () => {
  it("SHA-256 与规范向量一致", () => {
    expect(shotPreviewSha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(shotPreviewSha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(shotPreviewSha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))
      .toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("使用全部 256 位且长度固定，不受源 ID 长度膨胀影响", () => {
    const short = shotPreviewNodeId("f", "a");
    const long = shotPreviewNodeId("f".repeat(200), "a".repeat(200));
    expect(short.startsWith(SHOT_PREVIEW_ID_PREFIX)).toBe(true);
    // 32 字节 base64url（无填充）固定 43 字符。
    expect(short.slice(SHOT_PREVIEW_ID_PREFIX.length)).toHaveLength(43);
    expect(long.slice(SHOT_PREVIEW_ID_PREFIX.length)).toHaveLength(43);
    expect(isShotPreviewNodeId(short)).toBe(true);
    expect(isShotPreviewNodeId(long)).toBe(true);
    expect(isShotPreviewNodeId("shot-preview:short")).toBe(false);
    expect(isShotPreviewNodeId("other:abc")).toBe(false);
  });

  it("相同元组稳定、字段顺序不同则不同", () => {
    expect(shotPreviewNodeId("f", "a")).toBe(shotPreviewNodeId("f", "a"));
    expect(shotPreviewNodeId("f", "a")).not.toBe(shotPreviewNodeId("fa", ""));
    // 元组边界明确：拼接歧义不会碰撞。
    expect(shotPreviewNodeId("ab", "c")).not.toBe(shotPreviewNodeId("a", "bc"));
    // 前缀版本参与摘要：无歧义且不依赖截短。
    expect(shotPreviewNodeId("f", "a").length).toBeGreaterThan(20);
  });
});

describe("尺寸与画幅", () => {
  it("按 aspect 派生内容高度并加标题区", () => {
    const wide = shotPreviewCardSize(16 / 9);
    expect(wide.width).toBe(SHOT_PREVIEW_CARD_WIDTH);
    expect(wide.height).toBe(185); // 内宽 208 / (16:9) + 顶部 52 + 底部 16。
    expect(wide.height).toBeCloseTo(shotPreviewContentHeight(16 / 9) + SHOT_PREVIEW_HEADER_HEIGHT + 16, 6);
    // 竖画幅更高。
    expect(shotPreviewContentHeight(9 / 16)).toBeGreaterThan(shotPreviewContentHeight(16 / 9));
  });

  it("非法 aspect 退回 16:9", () => {
    expect(shotPreviewContentHeight(Number.NaN)).toBeCloseTo(shotPreviewContentHeight(16 / 9), 6);
    expect(shotPreviewContentHeight(0)).toBeCloseTo(shotPreviewContentHeight(16 / 9), 6);
    expect(shotAspectValue({ initialCamera: { aspect: "bad" } as never })).toBeCloseTo(16 / 9, 6);
    expect(shotAspectValue({ initialCamera: { aspect: "4:3" } as never })).toBeCloseTo(4 / 3, 6);
  });
});

describe("从源镜头派生预览目标", () => {
  const camera = { azimuth: 0, elevation: 0.5, distance: 4, aspect: "16:9" as const, focusOffset: { x: 0, y: 0, z: 0 } };
  const animation = {
    filmSetAnimations: {
      schemaVersion: FILM_SET_ANIMATIONS_VERSION,
      defaultClipId: "a",
      clips: [
        { id: "a", name: "静态", kind: "static" as const, timeline: { duration: 0, loop: false }, initialCamera: camera, cameraMotion: { motionScript: "", motionScriptLanguage: "javascript" as const, motionScriptVersion: "woohaa-motion-js-v1" as const, revision: 1, sourceHash: "", basedOnModelVersion: { revision: 1, contentHash: "camera" } }, bindings: [] },
        { id: "b", name: "动态", kind: "dynamic" as const, timeline: { duration: 5, loop: true }, initialCamera: camera, cameraMotion: { motionScript: "", motionScriptLanguage: "javascript" as const, motionScriptVersion: "woohaa-motion-js-v1" as const, revision: 1, sourceHash: "", basedOnModelVersion: { revision: 1, contentHash: "camera" } }, bindings: [] }
      ]
    }
  };

  it("每个镜头一个稳定目标，空集合无目标", () => {
    const targets = shotPreviewTargetsOf("film", animation);
    expect(targets).toHaveLength(2);
    expect(targets[0]!.clipId).toBe("a");
    expect(targets[0]!.kind).toBe("static");
    expect(targets[0]!.nodeId).toBe(shotPreviewNodeId("film", "a"));
    expect(targets[1]!.nodeId).toBe(shotPreviewNodeId("film", "b"));
    expect(shotPreviewTargetsOf("film", {})).toEqual([]);
  });
});

describe("确定性初始布局", () => {
  const filmSet = { x: 100, y: 200, width: 300, height: 200 };

  it("放在片场右侧留白处、按顺序竖排且带间距", () => {
    const sizes = [{ width: 240, height: 167 }, { width: 240, height: 167 }];
    const placements = planShotPreviewLayout({ filmSetBounds: filmSet, sizes, occupied: [] });
    expect(placements).toHaveLength(2);
    expect(placements[0]!.x).toBe(100 + 300 + 48);
    expect(placements[0]!.y).toBe(200);
    expect(placements[1]!.y).toBe(200 + 167 + 24);
    expect(placements[1]!.x).toBe(placements[0]!.x);
  });

  it("确定性：相同输入重复结果为同一落点", () => {
    const sizes = [{ width: 240, height: 167 }];
    const a = planShotPreviewLayout({ filmSetBounds: filmSet, sizes, occupied: [] });
    const b = planShotPreviewLayout({ filmSetBounds: { ...filmSet }, sizes: sizes.map((s) => ({ ...s })), occupied: [] });
    expect(a).toEqual(b);
  });

  it("遇已有矩形重叠时按固定步长沿同列避让", () => {
    const occupied = [{ x: 448, y: 200, width: 240, height: 167 }];
    const placements = planShotPreviewLayout({ filmSetBounds: filmSet, sizes: [{ width: 240, height: 167 }], occupied });
    expect(placements[0]!.x).toBe(448);
    // 沿固定步长下移，直到不与已占用矩形重叠。
    expect(placements[0]!.y).toBeGreaterThan(200);
    expect((placements[0]!.y - 200) % 32).toBe(0);
    expect(placements[0]!.y).toBeGreaterThanOrEqual(200 + 167);
  });
});
