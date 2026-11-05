import { describe, expect, it } from "vitest";
import {
  WORLD_CAPTURE_INPUT_VERSION,
  WORLD_CAPTURE_MEDIA_VERSION,
  WORLD_CAPTURE_NON_AUTHORING_CAUSES,
  applyWorldCaptureChange,
  decodeWorldCaptureFrozenInput,
  decodeWorldCaptureMediaMetadata,
  decodeWorldCaptureVersionKey,
  encodeWorldCaptureFrozenInput,
  encodeWorldCaptureMediaMetadata,
  encodeWorldCaptureVersionKey,
  freezeWorldCaptureInput,
  resolveWorldCaptureWait,
  settleWorldCaptureResult,
  toWorldCaptureInput,
  worldCaptureChangeInvalidates,
  worldCaptureVersionKeysEqual,
  worldCaptureVersionSignature,
  type WorldCaptureFrozenInput,
  type WorldCaptureMediaMetadata
} from "./world-capture-contract.js";
import { SharedWorldCodecError } from "./shared-world-codec.js";
import type {
  SharedWorldDecodeResult,
  WorldCaptureInput,
  WorldCaptureVersionKey
} from "./shared-world.js";

const CHECKSUM = "a".repeat(64);
const STORAGE_KEY = `sha256-${CHECKSUM}`;

const KEY: WorldCaptureVersionKey = {
  canvasId: "canvas-world-1",
  cameraId: "camera-shot-1",
  worldContentVersion: "world-content-7",
  cameraSettingsVersion: "camera-settings-3",
  bindingVersion: "binding-2",
  outputVersion: "output-16x9-png-1"
};

const MEDIA: WorldCaptureMediaMetadata = {
  version: WORLD_CAPTURE_MEDIA_VERSION,
  mediaId: "media-capture-1",
  storageKey: STORAGE_KEY,
  checksum: CHECKSUM,
  contentType: "image/png",
  size: 2048,
  width: 1024,
  height: 768
};

const FROZEN_INPUT: WorldCaptureFrozenInput = {
  version: WORLD_CAPTURE_INPUT_VERSION,
  key: KEY,
  media: MEDIA
};

const EXPECTED_SIGNATURE = JSON.stringify([
  "canvas-world-1",
  "camera-shot-1",
  "world-content-7",
  "camera-settings-3",
  "binding-2",
  "output-16x9-png-1"
]);

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function expectDecoded<T>(result: SharedWorldDecodeResult<T>): T {
  if (!result.ok) throw new Error(`expected a decoded value, got ${result.code}`);
  return result.value;
}

function expectRejected(
  result: SharedWorldDecodeResult<unknown>,
  code: "invalid-data" | "unsupported-version",
  input: unknown
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(code);
  expect(result.input).toBe(input);
}

function media(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...MEDIA, ...overrides };
}

describe("世界捕获版本键", () => {
  it("精确解码并原样重编码固定版本键", () => {
    const frozenKey = deepFreeze({ ...KEY });
    const decoded = expectDecoded(decodeWorldCaptureVersionKey(frozenKey));
    expect(decoded).toEqual(KEY);
    expect(encodeWorldCaptureVersionKey(decoded)).toEqual(KEY);
    expect(frozenKey).toEqual(KEY);
  });

  it("同一输入键产生稳定签名，分隔符不造成字段碰撞", () => {
    expect(worldCaptureVersionSignature(KEY)).toBe(EXPECTED_SIGNATURE);
    expect(worldCaptureVersionSignature({ ...KEY })).toBe(EXPECTED_SIGNATURE);

    const left: WorldCaptureVersionKey = { ...KEY, canvasId: "canvas|a", cameraId: "camera" };
    const right: WorldCaptureVersionKey = { ...KEY, canvasId: "canvas", cameraId: "a|camera" };
    expect(worldCaptureVersionSignature(left)).not.toBe(worldCaptureVersionSignature(right));
  });

  it("opaque 版本只比较相等，不提供或推导先后顺序", () => {
    const lower = { ...KEY, worldContentVersion: "a" };
    const upper = { ...KEY, worldContentVersion: "z" };
    expect(worldCaptureVersionKeysEqual(lower, upper)).toBe(false);
    expect(worldCaptureVersionKeysEqual(upper, lower)).toBe(false);
    expect(worldCaptureVersionKeysEqual(lower, { ...KEY, worldContentVersion: "a" })).toBe(true);
    expect(worldCaptureVersionKeysEqual(KEY, { ...KEY, outputVersion: "output-16x9-png-2" })).toBe(false);
  });

  it("拒绝空 id、非字符串版本与额外字段", () => {
    for (const invalid of [
      { ...KEY, canvasId: "" },
      { ...KEY, cameraId: 7 },
      { ...KEY, worldContentVersion: null },
      { ...KEY, extra: "field" },
      null,
      []
    ]) {
      expectRejected(decodeWorldCaptureVersionKey(invalid), "invalid-data", invalid);
    }
  });

  it("无效键永不相等，签名直接拒绝", () => {
    const invalid = { ...KEY, bindingVersion: "" };
    expect(worldCaptureVersionKeysEqual(invalid, invalid)).toBe(false);
    expect(() => worldCaptureVersionSignature(invalid)).toThrow(SharedWorldCodecError);
  });
});

describe("创作内容失效边界", () => {
  it("四类规范创作变化分别只推进对应版本并使取景失效", () => {
    const changes = [
      { change: { kind: "world-content" as const, worldContentVersion: "world-content-8" }, field: "worldContentVersion", value: "world-content-8" },
      { change: { kind: "camera-settings" as const, cameraSettingsVersion: "camera-settings-4" }, field: "cameraSettingsVersion", value: "camera-settings-4" },
      { change: { kind: "camera-binding" as const, bindingVersion: "binding-3" }, field: "bindingVersion", value: "binding-3" },
      { change: { kind: "output" as const, outputVersion: "output-16x9-png-2" }, field: "outputVersion", value: "output-16x9-png-2" }
    ] as const;

    for (const { change, field, value } of changes) {
      const next = applyWorldCaptureChange(KEY, change);
      expect(next).toEqual({ ...KEY, [field]: value });
      expect(worldCaptureChangeInvalidates(KEY, change)).toBe(true);
      expect(worldCaptureVersionSignature(next)).not.toBe(worldCaptureVersionSignature(KEY));
    }
  });

  it("同一 opaque 版本回写不算新版本", () => {
    const change = { kind: "world-content" as const, worldContentVersion: KEY.worldContentVersion };
    expect(applyWorldCaptureChange(KEY, change)).toEqual(KEY);
    expect(worldCaptureChangeInvalidates(KEY, change)).toBe(false);
  });

  it("viewport、hover、占用心跳和缓存发布不进入创作版本且可重复应用", () => {
    for (const cause of WORLD_CAPTURE_NON_AUTHORING_CAUSES) {
      const change = { kind: "non-authoring" as const, cause };
      expect(applyWorldCaptureChange(KEY, change)).toEqual(KEY);
      expect(worldCaptureChangeInvalidates(KEY, change)).toBe(false);
      expect(worldCaptureVersionSignature(applyWorldCaptureChange(KEY, change))).toBe(EXPECTED_SIGNATURE);
    }
  });

  it("空创作版本被拒绝", () => {
    expect(() =>
      applyWorldCaptureChange(KEY, { kind: "world-content", worldContentVersion: "" })
    ).toThrow(SharedWorldCodecError);
  });
});

describe("静态媒体元数据", () => {
  it("解码并重编码稳定引用、checksum、类型、字节数与像素宽高", () => {
    const frozenMedia = deepFreeze({ ...MEDIA });
    const decoded = expectDecoded(decodeWorldCaptureMediaMetadata(frozenMedia));
    expect(decoded).toEqual(MEDIA);
    expect(decoded.width).toBe(1024);
    expect(decoded.height).toBe(768);
    expect(decoded.size).toBe(2048);
    expect(encodeWorldCaptureMediaMetadata(decoded)).toEqual(MEDIA);
    expect(frozenMedia).toEqual(MEDIA);
  });

  it("未知元数据版本与缺少像素尺寸的旧 v1 都返回 unsupported-version", () => {
    for (const input of [
      media({ version: "world-capture-media-v3" }),
      { ...media(), version: "world-capture-media-v1" }
    ]) {
      expectRejected(decodeWorldCaptureMediaMetadata(input), "unsupported-version", input);
    }
  });

  it("拒绝非有限、非正、小数、非安全整数大小", () => {
    for (const size of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const input = media({ size });
      expectRejected(decodeWorldCaptureMediaMetadata(input), "invalid-data", input);
    }
    expect(expectDecoded(decodeWorldCaptureMediaMetadata(media({ size: Number.MAX_SAFE_INTEGER }))).size).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });

  it("宽高必须分别是有限正安全整数像素，缺失、非法或溢出均拒绝", () => {
    const invalidValues = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      "1024",
      null
    ];
    for (const width of invalidValues) {
      const input = media({ width });
      expectRejected(decodeWorldCaptureMediaMetadata(input), "invalid-data", input);
    }
    for (const height of invalidValues) {
      const input = media({ height });
      expectRejected(decodeWorldCaptureMediaMetadata(input), "invalid-data", input);
    }
    for (const field of ["width", "height"]) {
      const input = media();
      delete input[field];
      expectRejected(decodeWorldCaptureMediaMetadata(input), "invalid-data", input);
    }
    const max = media({ width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER });
    expect(expectDecoded(decodeWorldCaptureMediaMetadata(max))).toEqual(max);
  });

  it("字节数相同但像素尺寸不同仍是不同元数据，宽高各自独立校验", () => {
    const base = expectDecoded(decodeWorldCaptureMediaMetadata(media()));
    const wider = expectDecoded(decodeWorldCaptureMediaMetadata(media({ width: 1025 })));
    const taller = expectDecoded(decodeWorldCaptureMediaMetadata(media({ height: 769 })));
    expect(wider.size).toBe(base.size);
    expect(taller.size).toBe(base.size);
    expect({ ...base, width: wider.width }).not.toEqual(base);
    expect({ ...base, height: taller.height }).not.toEqual(base);
    expect(wider).not.toEqual(taller);
  });

  it("拒绝非稳定引用：URL、data/blob 与非法存储键", () => {
    for (const storageKey of [
      "https://example.com/capture.png",
      "data:image/png;base64,AAAA",
      "blob:https://example.com/id",
      `sha256-${"A".repeat(64)}`,
      `sha256-${"a".repeat(63)}`,
      "generation-outputs/not-a-hash.png"
    ]) {
      const input = media({ storageKey });
      expectRejected(decodeWorldCaptureMediaMetadata(input), "invalid-data", input);
    }
  });

  it("拒绝非法 checksum 与内容类型", () => {
    for (const overrides of [
      { checksum: CHECKSUM.toUpperCase() },
      { checksum: "a".repeat(63) },
      { checksum: `${"a".repeat(63)}g` },
      { contentType: "text/html" },
      { contentType: "image/PNG" },
      { contentType: "" }
    ]) {
      const input = media(overrides);
      expectRejected(decodeWorldCaptureMediaMetadata(input), "invalid-data", input);
    }
  });

  it("拒绝空 mediaId 与额外字段", () => {
    for (const input of [media({ mediaId: "" }), media({ extra: true })]) {
      expectRejected(decodeWorldCaptureMediaMetadata(input), "invalid-data", input);
    }
  });
});

describe("冻结捕获输入", () => {
  it("解码、重编码并投影为 T01 WorldCaptureInput", () => {
    const frozen = deepFreeze({ ...FROZEN_INPUT });
    const decoded = expectDecoded(decodeWorldCaptureFrozenInput(frozen));
    expect(decoded).toEqual(FROZEN_INPUT);
    expect(encodeWorldCaptureFrozenInput(decoded)).toEqual(FROZEN_INPUT);

    const t01: WorldCaptureInput = toWorldCaptureInput(decoded);
    expect(t01).toEqual({ key: KEY, mediaId: MEDIA.mediaId, checksum: MEDIA.checksum });
  });

  it("未知输入版本、未知媒体版本与旧 v1 媒体都返回 unsupported-version", () => {
    for (const input of [
      { ...FROZEN_INPUT, version: "world-capture-input-v2" },
      { ...FROZEN_INPUT, media: media({ version: "world-capture-media-v3" }) },
      { ...FROZEN_INPUT, media: { ...media(), version: "world-capture-media-v1" } }
    ]) {
      expectRejected(decodeWorldCaptureFrozenInput(input), "unsupported-version", input);
    }
  });

  it("输入键或媒体非法时整体拒绝", () => {
    for (const input of [
      { ...FROZEN_INPUT, key: { ...KEY, cameraId: "" } },
      { ...FROZEN_INPUT, media: media({ checksum: "short" }) },
      { ...FROZEN_INPUT, media: media({ width: 0 }) },
      { ...FROZEN_INPUT, media: media({ height: -1 }) },
      { ...FROZEN_INPUT, extra: "field" }
    ]) {
      expectRejected(decodeWorldCaptureFrozenInput(input), "invalid-data", input);
    }
  });

  it("只有请求版本仍为当前版本时才冻结指定媒体", () => {
    const frozen = freezeWorldCaptureInput(KEY, { ...KEY }, MEDIA);
    expect(frozen).toEqual({ ok: true, input: FROZEN_INPUT });

    const stale = freezeWorldCaptureInput(KEY, { ...KEY, outputVersion: "output-16x9-png-2" }, MEDIA);
    expect(stale).toEqual({
      ok: false,
      code: "capture-stale",
      currentKey: { ...KEY, outputVersion: "output-16x9-png-2" }
    });

    expect(
      freezeWorldCaptureInput(KEY, KEY, media({ size: -1 }) as unknown as WorldCaptureMediaMetadata)
    ).toEqual({
      ok: false,
      code: "invalid-data"
    });
    expect(
      freezeWorldCaptureInput(KEY, KEY, media({ width: 0 }) as unknown as WorldCaptureMediaMetadata)
    ).toEqual({
      ok: false,
      code: "invalid-data"
    });
  });

  it("冻结结果不受后续输入对象变化影响", () => {
    const mutableKey = { ...KEY };
    const mutableMedia = { ...MEDIA };
    const frozen = freezeWorldCaptureInput(mutableKey, KEY, mutableMedia);
    if (!frozen.ok) throw new Error("expected a frozen input");
    expect(frozen.input.key).not.toBe(mutableKey);
    expect(frozen.input.media).not.toBe(mutableMedia);
    mutableKey.worldContentVersion = "world-content-99";
    mutableMedia.checksum = "b".repeat(64);
    mutableMedia.width = 1;
    mutableMedia.height = 1;
    expect(frozen.input.key.worldContentVersion).toBe("world-content-7");
    expect(frozen.input.media.checksum).toBe(CHECKSUM);
    expect(frozen.input.media.width).toBe(1024);
    expect(frozen.input.media.height).toBe(768);
  });
});

describe("等待、替换与取消", () => {
  it("版本仍为当前时返回 current", () => {
    expect(resolveWorldCaptureWait({ requestId: "wait-1", key: KEY }, { ...KEY }, false)).toEqual({
      status: "current",
      requestId: "wait-1",
      key: KEY
    });
  });

  it("版本被替换时返回 superseded 与原请求/当前版本", () => {
    const current = { ...KEY, bindingVersion: "binding-3" };
    expect(resolveWorldCaptureWait({ requestId: "wait-1", key: KEY }, current, false)).toEqual({
      status: "superseded",
      requestId: "wait-1",
      requestedKey: KEY,
      currentKey: current
    });
  });

  it("取消优先于版本漂移，不静默消费其他版本构图", () => {
    const current = { ...KEY, bindingVersion: "binding-3" };
    expect(resolveWorldCaptureWait({ requestId: "wait-1", key: KEY }, current, true)).toEqual({
      status: "cancelled",
      requestId: "wait-1",
      key: KEY
    });
  });
});

describe("异步结果合并", () => {
  it("当前版本的 ready 结果被接受并冻结", () => {
    expect(settleWorldCaptureResult({ status: "ready", key: KEY, media: MEDIA }, { ...KEY })).toEqual({
      decision: "apply",
      input: FROZEN_INPUT
    });
  });

  it("旧版本 ready 结果被拒绝，不能覆盖新版本", () => {
    const current = { ...KEY, worldContentVersion: "world-content-8" };
    expect(settleWorldCaptureResult({ status: "ready", key: KEY, media: MEDIA }, current)).toEqual({
      decision: "reject",
      code: "capture-stale",
      currentKey: current
    });
  });

  it("当前版本失败标记 not-ready，旧版本失败仍按 stale 拒绝", () => {
    expect(settleWorldCaptureResult({ status: "failed", key: KEY }, KEY)).toEqual({
      decision: "reject",
      code: "not-ready",
      currentKey: KEY
    });
    const current = { ...KEY, cameraSettingsVersion: "camera-settings-4" };
    expect(settleWorldCaptureResult({ status: "failed", key: KEY }, current)).toEqual({
      decision: "reject",
      code: "capture-stale",
      currentKey: current
    });
  });

  it("取消结果始终明确返回 cancelled，即使版本已漂移", () => {
    expect(
      settleWorldCaptureResult(
        { status: "cancelled", key: KEY },
        { ...KEY, worldContentVersion: "world-content-8" }
      )
    ).toEqual({ decision: "reject", code: "cancelled" });
  });

  it("当前版本但媒体非法时拒绝，不用旧图冒充最新输入", () => {
    expect(
      settleWorldCaptureResult(
        {
          status: "ready",
          key: KEY,
          media: media({ checksum: "not-a-checksum" }) as unknown as WorldCaptureMediaMetadata
        },
        KEY
      )
    ).toEqual({ decision: "reject", code: "invalid-data", currentKey: KEY });
  });

  it("无效结果键返回 invalid-data", () => {
    expect(
      settleWorldCaptureResult({ status: "ready", key: { ...KEY, cameraId: "" }, media: MEDIA }, KEY)
    ).toEqual({ decision: "reject", code: "invalid-data" });
  });
});
