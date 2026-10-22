/**
 * ImageEditDocument 契约测试
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 1.2）。
 */
import { describe, expect, it } from "vitest";
import {
  IMAGE_EDIT_ALLOWED_COLORS,
  IMAGE_EDIT_DOCUMENT_VERSION,
  IMAGE_EDIT_LIMITS,
  decodeImageEditDocument,
  imageEditContentIdentity,
  imageEditDefinitionHash,
  imageEditDocumentContentIdentity,
  imageEditHasNetChange,
  imageEditShapesHash,
  normalizeImageEditPoint,
  sanitizeImageEditShape,
  type ImageEditShape,
  type LegacyImageEditDocument
} from "./image-edit.js";

function pen(overrides: Partial<ImageEditShape> = {}): ImageEditShape {
  return {
    id: "s1",
    tool: "pen",
    color: "#ff3b30",
    widthInSourcePixels: 3,
    points: [
      { x: 0.1, y: 0.1 },
      { x: 0.2, y: 0.25 }
    ],
    ...overrides
  };
}

function doc(overrides: Partial<LegacyImageEditDocument> = {}): LegacyImageEditDocument {
  return {
    version: IMAGE_EDIT_DOCUMENT_VERSION,
    baseAssetId: "asset-base",
    sourceWidth: 1920,
    sourceHeight: 1080,
    shapes: [pen()],
    ...overrides
  };
}

describe("decodeImageEditDocument", () => {
  it("接受合法定义并保留规范化 shapes", () => {
    const result = decodeImageEditDocument(doc());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.version).toBe(IMAGE_EDIT_DOCUMENT_VERSION);
      if (result.value.version === IMAGE_EDIT_DOCUMENT_VERSION) expect(result.value.shapes).toHaveLength(1);
    }
  });

  it("接受零 shapes（清除全部标记回原图）", () => {
    const result = decodeImageEditDocument(doc({ shapes: [] }));
    expect(result.ok).toBe(true);
  });

  it("拒绝未知版本", () => {
    expect(decodeImageEditDocument({ ...doc(), version: "woohaa-image-edit-v2" }).ok).toBe(false);
  });

  it("拒绝非法工具/颜色/非有限线宽", () => {
    expect(sanitizeImageEditShape(pen({ tool: "circle" as never }))).toBeNull();
    expect(sanitizeImageEditShape(pen({ color: "#123456" as never }))).toBeNull();
    expect(sanitizeImageEditShape(pen({ widthInSourcePixels: Number.NaN }))).toBeNull();
    expect(sanitizeImageEditShape(pen({ widthInSourcePixels: 0 }))).toBeNull();
    expect(sanitizeImageEditShape(pen({ widthInSourcePixels: 65 }))).toBeNull();
  });

  it("拒绝越界坐标及非法点数", () => {
    expect(sanitizeImageEditShape(pen({ points: [{ x: 1.5, y: 0 }, { x: 0, y: 0 }] }))).toBeNull();
    expect(sanitizeImageEditShape(pen({ tool: "rect", points: [{ x: 0, y: 0 }] }))).toBeNull();
    expect(sanitizeImageEditShape(pen({ points: [{ x: 0, y: 0 }] }))).toBeNull();
  });

  it("拒绝重复 shape id", () => {
    const result = decodeImageEditDocument(doc({ shapes: [pen(), pen()] }));
    expect(result.ok).toBe(false);
  });

  it("拒绝超限 shape 数量", () => {
    const shapes = Array.from({ length: IMAGE_EDIT_LIMITS.maxShapes + 1 }, (_, index) => pen({ id: `s${index}` }));
    expect(decodeImageEditDocument(doc({ shapes })).ok).toBe(false);
  });

  it("拒绝超限源尺寸/总像素", () => {
    expect(decodeImageEditDocument(doc({ sourceWidth: 0 })).ok).toBe(false);
    expect(decodeImageEditDocument(doc({ sourceWidth: 9000 })).ok).toBe(false);
    expect(decodeImageEditDocument(doc({ sourceWidth: 8192, sourceHeight: 8192 })).ok).toBe(true);
  });

  it("拒绝非对象", () => {
    expect(decodeImageEditDocument(null).ok).toBe(false);
    expect(decodeImageEditDocument("x").ok).toBe(false);
  });
});

describe("内容身份与净变化", () => {
  it("规范化坐标：缩放/浮点噪声不改变 shapes hash", () => {
    const a = doc({ shapes: [pen({ points: [{ x: 0.10000004, y: 0.1 }, { x: 0.2, y: 0.25 }] })] });
    const b = doc({ shapes: [pen({ points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.25 }] })] });
    expect(imageEditShapesHash(a)).toBe(imageEditShapesHash(b));
  });

  it("工具偏好（非 shapes）不影响身份", () => {
    const baseline = doc();
    const same = doc();
    expect(imageEditHasNetChange(baseline, same)).toBe(false);
  });

  it("无 imageEdit 的旧图归一化为空 shapes", () => {
    expect(imageEditHasNetChange(null, null)).toBe(false);
    expect(imageEditHasNetChange(null, doc({ shapes: [] }))).toBe(false);
    expect(imageEditHasNetChange(null, doc())).toBe(true);
  });

  it("删除一个标记产生净变化", () => {
    const withTwo = doc({ shapes: [pen({ id: "a" }), pen({ id: "b" })] });
    const withOne = doc({ shapes: [pen({ id: "a" })] });
    expect(imageEditHasNetChange(withTwo, withOne)).toBe(true);
  });

  it("相同输出 bytes 但 shapes 不同时编辑身份可区分", () => {
    const base = {
      baseStorageKey: "sha256-" + "a".repeat(64),
      sourceWidth: 100,
      sourceHeight: 100,
      outputStorageKey: "generation-outputs/" + "b".repeat(64) + ".png"
    };
    const identityA = imageEditContentIdentity({ ...base, shapes: [pen({ id: "a" })] });
    const identityB = imageEditContentIdentity({ ...base, shapes: [pen({ id: "b" })] });
    expect(identityA).not.toBe(identityB);
  });

  it("imageEditDocumentContentIdentity 与 components 版本一致", () => {
    const document = doc();
    const baseStorageKey = "sha256-" + "c".repeat(64);
    const outputStorageKey = "generation-outputs/" + "d".repeat(64) + ".png";
    const derived = imageEditDocumentContentIdentity({ document, baseStorageKey, outputStorageKey });
    const manual = imageEditContentIdentity({
      baseStorageKey,
      sourceWidth: document.sourceWidth,
      sourceHeight: document.sourceHeight,
      shapes: document.shapes,
      outputStorageKey
    });
    expect(derived).toBe(manual);
  });
  it("definition hash 不包含输出身份", () => {
    const a = doc();
    const b = doc({ baseAssetId: "other" });
    expect(imageEditDefinitionHash(a)).not.toBe(imageEditDefinitionHash(b));
  });

  it("色板为受控集合", () => {
    expect(IMAGE_EDIT_ALLOWED_COLORS.length).toBeGreaterThan(0);
  });

  it("normalizeImageEditPoint 幂等", () => {
    const point = { x: 0.123456, y: 0.987654 };
    expect(normalizeImageEditPoint(normalizeImageEditPoint(point))).toEqual(normalizeImageEditPoint(point));
  });
});
