import { describe, expect, it } from "vitest";
import {
  derivableSourceChecksum,
  isDerivableSourceKey,
  mediaDerivativeCacheKey,
  parseMediaDerivativeCacheKey,
  thumbnailDerivativeQuery,
  type MediaDerivativeIdentity
} from "./variants.js";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const UPLOAD_KEY = `sha256-${HASH}`;
const GENERATED_KEY = `generation-outputs/${HASH}.png`;

const identity = (sourceKey: string, patch: Partial<MediaDerivativeIdentity> = {}): MediaDerivativeIdentity => ({
  sourceKey,
  kind: "thumbnail",
  edge: 256,
  format: "png",
  ...patch
});

describe("可派生的原资产键", () => {
  it("接受上传件与生成结果两种内容寻址键", () => {
    expect(isDerivableSourceKey(UPLOAD_KEY)).toBe(true);
    expect(isDerivableSourceKey(GENERATED_KEY)).toBe(true);
    expect(derivableSourceChecksum(UPLOAD_KEY)).toBe(HASH);
    expect(derivableSourceChecksum(GENERATED_KEY)).toBe(HASH);
  });

  it("拒绝任意自由键、带路径的键与非十六进制哈希", () => {
    for (const value of [
      "",
      "random-key",
      "sha256-",
      `sha256-${"a".repeat(63)}`,
      `sha256-${"A".repeat(64)}`,
      `generation-outputs/${HASH}`,
      `generation-outputs/${HASH}.`,
      `generation-outputs/other/${HASH}.png`,
      `generation-outputs/${HASH}.png/extra`,
      `derivatives/${HASH}/thumbnail-256.png`,
      `uploads/${HASH}.png`
    ]) {
      expect(isDerivableSourceKey(value), value).toBe(false);
    }
    expect(isDerivableSourceKey(undefined)).toBe(false);
    expect(isDerivableSourceKey(null)).toBe(false);
    expect(isDerivableSourceKey(42)).toBe(false);
  });
});

describe("派生物缓存键", () => {
  it("同内容的两种键形态归一到同一个缓存项", () => {
    const fromUpload = mediaDerivativeCacheKey(identity(UPLOAD_KEY));
    const fromGenerated = mediaDerivativeCacheKey(identity(GENERATED_KEY));
    expect(fromUpload).toBe(`derivatives/${HASH}/thumbnail-256.png`);
    expect(fromGenerated).toBe(fromUpload);
  });

  it("不同内容 / 档位 / 格式各自成键", () => {
    const base = mediaDerivativeCacheKey(identity(UPLOAD_KEY));
    expect(mediaDerivativeCacheKey(identity(`sha256-${OTHER_HASH}`))).not.toBe(base);
    expect(mediaDerivativeCacheKey(identity(UPLOAD_KEY, { edge: 512 }))).not.toBe(base);
    expect(mediaDerivativeCacheKey(identity(UPLOAD_KEY, { format: "webp" }))).not.toBe(base);
  });

  it("非法身份在访问存储之前就被拒绝", () => {
    for (const bad of [
      identity("free-form-key"),
      identity(`generation-outputs/${HASH}`),
      identity(UPLOAD_KEY, { edge: 300 as never }),
      identity(UPLOAD_KEY, { format: "gif" as never }),
      identity(UPLOAD_KEY, { kind: "sprite" as never })
    ]) {
      expect(mediaDerivativeCacheKey(bad)).toBeNull();
    }
  });

  it("缓存键可以反向解析回身份", () => {
    const parsed = parseMediaDerivativeCacheKey(`derivatives/${HASH}/thumbnail-256.png`);
    expect(parsed).toEqual({ sourceKey: UPLOAD_KEY, kind: "thumbnail", edge: 256, format: "png" });
    expect(parseMediaDerivativeCacheKey(`derivatives/${HASH}/thumbnail-256.gif`)).toBeNull();
  });
});

describe("查询参数解码", () => {
  it("生成结果的键同样能解出身份", () => {
    expect(thumbnailDerivativeQuery({ sourceKey: GENERATED_KEY, edge: "256", format: "png" })).toEqual({
      sourceKey: GENERATED_KEY,
      kind: "thumbnail",
      edge: 256,
      format: "png"
    });
  });

  it("非法键或非法档位返回 undefined（调用方回退原图）", () => {
    expect(thumbnailDerivativeQuery({ sourceKey: "free-form-key", edge: "256" })).toBeUndefined();
    expect(thumbnailDerivativeQuery({ sourceKey: UPLOAD_KEY, edge: "300" })).toBeUndefined();
  });
});
