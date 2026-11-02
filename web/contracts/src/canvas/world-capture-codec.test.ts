import { describe, expect, it } from "vitest";
import {
  compareWorldCaptureVersionKeys,
  decodeWorldCaptureInputMetadata,
  decodeWorldCaptureVersionKeyText,
  encodeWorldCaptureInputMetadata,
  encodeWorldCaptureVersionKeyText,
  worldCaptureInputMetadataEqual,
  type WorldCaptureVersionComparison
} from "./world-capture-codec.js";
import { SharedWorldCodecError } from "./shared-world-codec.js";
import {
  WORLD_CAPTURE_INPUT_VERSION,
  WORLD_CAPTURE_MEDIA_VERSION,
  type WorldCaptureFrozenInput,
  type WorldCaptureMediaMetadata
} from "./world-capture-contract.js";
import type {
  SharedWorldDecodeResult,
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

const EXPECTED_KEY_TEXT = JSON.stringify([
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

function frozenInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...FROZEN_INPUT, ...overrides };
}

describe("捕获版本键固定文本编码", () => {
  it("固定字段顺序产生稳定键，且不随对象创建方式改变", () => {
    expect(encodeWorldCaptureVersionKeyText(KEY)).toBe(EXPECTED_KEY_TEXT);
    expect(encodeWorldCaptureVersionKeyText({ ...KEY })).toBe(EXPECTED_KEY_TEXT);
    expect(encodeWorldCaptureVersionKeyText(deepFreeze({ ...KEY }))).toBe(EXPECTED_KEY_TEXT);
  });

  it("canvas/camera/world/settings/binding/output 任一变化都可区分", () => {
    const variants: WorldCaptureVersionKey[] = [
      { ...KEY, canvasId: "canvas-world-2" },
      { ...KEY, cameraId: "camera-shot-2" },
      { ...KEY, worldContentVersion: "world-content-8" },
      { ...KEY, cameraSettingsVersion: "camera-settings-4" },
      { ...KEY, bindingVersion: "binding-3" },
      { ...KEY, outputVersion: "output-16x9-png-2" }
    ];
    const texts = new Set([EXPECTED_KEY_TEXT]);
    for (const variant of variants) {
      expect(encodeWorldCaptureVersionKeyText(variant)).not.toBe(EXPECTED_KEY_TEXT);
      expect(compareWorldCaptureVersionKeys(KEY, variant)).toBe("different");
      texts.add(encodeWorldCaptureVersionKeyText(variant));
    }
    expect(texts.size).toBe(variants.length + 1);
  });

  it("分隔符不会造成字段碰撞", () => {
    const left: WorldCaptureVersionKey = { ...KEY, canvasId: "canvas|a", cameraId: "camera" };
    const right: WorldCaptureVersionKey = { ...KEY, canvasId: "canvas", cameraId: "a|camera" };
    expect(encodeWorldCaptureVersionKeyText(left)).not.toBe(encodeWorldCaptureVersionKeyText(right));
    expect(compareWorldCaptureVersionKeys(left, right)).toBe("different");
  });

  it("规范文本解码为全新对象并往返保持全部字段", () => {
    const decoded = expectDecoded(decodeWorldCaptureVersionKeyText(EXPECTED_KEY_TEXT));
    expect(decoded).toEqual(KEY);
    expect(decoded).not.toBe(KEY);
    expect(encodeWorldCaptureVersionKeyText(decoded)).toBe(EXPECTED_KEY_TEXT);

    decoded.canvasId = "mutated-canvas";
    expect(KEY.canvasId).toBe("canvas-world-1");
    expect(expectDecoded(decodeWorldCaptureVersionKeyText(EXPECTED_KEY_TEXT))).toEqual(KEY);
  });

  it("拒绝非规范文本、非字符串与结构错误的输入", () => {
    for (const input of [
      EXPECTED_KEY_TEXT.replace("canvas-world-1", "canvas-world-\\u0031"),
      ` ${EXPECTED_KEY_TEXT}`,
      `${EXPECTED_KEY_TEXT} `,
      JSON.stringify(["canvas-world-1"]),
      JSON.stringify(["canvas-world-1", "camera-shot-1", "world-content-7"]),
      JSON.stringify([...JSON.parse(EXPECTED_KEY_TEXT), "extra"]),
      JSON.stringify({ ...KEY }),
      JSON.stringify(["", "camera-shot-1", "world-content-7", "camera-settings-3", "binding-2", "output-16x9-png-1"]),
      JSON.stringify(["canvas-world-1", 7, "world-content-7", "camera-settings-3", "binding-2", "output-16x9-png-1"]),
      "",
      null,
      42,
      undefined
    ]) {
      expectRejected(decodeWorldCaptureVersionKeyText(input), "invalid-data", input);
    }
  });

  it("opaque 版本只按精确相等比较，不按字符串或数字推断先后", () => {
    const oldest = { ...KEY, worldContentVersion: "v2" };
    const middle = { ...KEY, worldContentVersion: "v9" };
    const newest = { ...KEY, worldContentVersion: "v10" };
    for (const [left, right] of [
      [oldest, middle],
      [middle, oldest],
      [oldest, newest],
      [newest, oldest],
      [middle, newest],
      [newest, middle]
    ] as const) {
      const result: WorldCaptureVersionComparison = compareWorldCaptureVersionKeys(left, right);
      expect(result).toBe("different");
    }
    expect(compareWorldCaptureVersionKeys(newest, { ...newest })).toBe("equal");
    const roundTripped = expectDecoded(
      decodeWorldCaptureVersionKeyText(encodeWorldCaptureVersionKeyText(newest))
    );
    expect(compareWorldCaptureVersionKeys(newest, roundTripped)).toBe("equal");
  });

  it("无效键永不相等，包括自身比较", () => {
    const invalid = { ...KEY, bindingVersion: "" };
    expect(compareWorldCaptureVersionKeys(invalid, invalid)).toBe("different");
    expect(() => encodeWorldCaptureVersionKeyText(invalid)).toThrow(SharedWorldCodecError);
  });

  it("乱序到达的键保持各自身份，不做排序或结果调度", () => {
    const inputs = [
      { ...KEY, worldContentVersion: "v10" },
      { ...KEY, worldContentVersion: "v2" },
      { ...KEY, worldContentVersion: "v9" }
    ];
    const encoded = inputs.map((key) => encodeWorldCaptureVersionKeyText(key));
    const decoded = encoded.map((text) => expectDecoded(decodeWorldCaptureVersionKeyText(text)));
    expect(decoded.map((key) => key.worldContentVersion)).toEqual(["v10", "v2", "v9"]);
    expect(decoded).toEqual(inputs);
    expect(compareWorldCaptureVersionKeys(decoded[0], decoded[1])).toBe("different");
    expect(compareWorldCaptureVersionKeys(decoded[1], decoded[0])).toBe("different");
  });
});

describe("冻结输入元数据 codec", () => {
  it("稳定媒体 ID、存储引用、checksum、类型、字节数、像素宽高与版本完整往返", () => {
    const frozen = deepFreeze({
      version: FROZEN_INPUT.version,
      key: { ...KEY },
      media: { ...MEDIA }
    });
    const decoded = expectDecoded(decodeWorldCaptureInputMetadata(frozen));
    expect(decoded).toEqual(FROZEN_INPUT);
    expect(decoded.media.width).toBe(1024);
    expect(decoded.media.height).toBe(768);
    expect(decoded.media.size).toBe(2048);
    expect(encodeWorldCaptureInputMetadata(decoded)).toEqual(FROZEN_INPUT);
    expect(frozen).toEqual(FROZEN_INPUT);
  });

  it("解码与编码都返回新拷贝，不共享 key/media 引用", () => {
    const source = { version: FROZEN_INPUT.version, key: { ...KEY }, media: { ...MEDIA } };
    const decoded = expectDecoded(decodeWorldCaptureInputMetadata(source));
    expect(decoded).not.toBe(source);
    expect(decoded.key).not.toBe(source.key);
    expect(decoded.media).not.toBe(source.media);

    source.key.canvasId = "mutated-canvas";
    source.media.checksum = "b".repeat(64);
    source.media.width = 1;
    source.media.height = 1;
    expect(decoded.key.canvasId).toBe("canvas-world-1");
    expect(decoded.media.checksum).toBe(CHECKSUM);
    expect(decoded.media.width).toBe(1024);
    expect(decoded.media.height).toBe(768);

    const encoded = encodeWorldCaptureInputMetadata(decoded) as WorldCaptureFrozenInput;
    expect(encoded).not.toBe(decoded);
    expect(encoded.key).not.toBe(decoded.key);
    expect(encoded.media).not.toBe(decoded.media);
    encoded.key.cameraId = "mutated-camera";
    encoded.media.size = 1;
    encoded.media.width = 2;
    encoded.media.height = 2;
    expect(decoded.key.cameraId).toBe("camera-shot-1");
    expect(decoded.media.size).toBe(2048);
    expect(decoded.media.width).toBe(1024);
    expect(decoded.media.height).toBe(768);
  });

  it("非法或未知版本整体拒绝，包括缺少像素尺寸的旧 v1 媒体", () => {
    for (const input of [
      frozenInput({ version: "world-capture-input-v2" }),
      frozenInput({ media: media({ version: "world-capture-media-v3" }) }),
      frozenInput({ media: { ...media(), version: "world-capture-media-v1" } })
    ]) {
      expectRejected(decodeWorldCaptureInputMetadata(input), "unsupported-version", input);
    }
  });

  it("缺失字段与运行态字段整体拒绝", () => {
    const missingFields: Record<string, unknown>[] = [];
    for (const field of ["version", "key", "media"]) {
      const record = frozenInput();
      delete record[field];
      missingFields.push(record);
    }
    for (const field of ["mediaId", "storageKey", "checksum", "contentType", "size", "width", "height", "version"]) {
      const record = media();
      delete record[field];
      missingFields.push(frozenInput({ media: record }));
    }
    for (const field of [
      "canvasId",
      "cameraId",
      "worldContentVersion",
      "cameraSettingsVersion",
      "bindingVersion",
      "outputVersion"
    ]) {
      const record: Record<string, unknown> = { ...KEY };
      delete record[field];
      missingFields.push(frozenInput({ key: record }));
    }

    const runtimeFields = [
      "requestId",
      "runId",
      "status",
      "capturedAt",
      "updatedAt",
      "workerId",
      "pending",
      "progress",
      "url",
      "mediaUrl",
      "storageUrl",
      "scheduler"
    ].map((field) => frozenInput({ [field]: "runtime" }));
    const runtimeMediaFields = ["url", "storageUrl", "requestId", "status"].map((field) =>
      frozenInput({ media: media({ [field]: "runtime" }) })
    );

    for (const input of [...missingFields, ...runtimeFields, ...runtimeMediaFields]) {
      expectRejected(decodeWorldCaptureInputMetadata(input), "invalid-data", input);
    }
  });

  it("键与媒体的非法字段整体拒绝", () => {
    for (const input of [
      frozenInput({ key: { ...KEY, cameraId: "" } }),
      frozenInput({ key: { ...KEY, outputVersion: null } }),
      frozenInput({ key: { ...KEY, extra: "field" } }),
      frozenInput({ media: media({ mediaId: "" }) }),
      frozenInput({ media: media({ storageKey: "https://example.com/capture.png" }) }),
      frozenInput({ media: media({ checksum: CHECKSUM.toUpperCase() }) }),
      frozenInput({ media: media({ checksum: "short" }) }),
      frozenInput({ media: media({ contentType: "text/html" }) }),
      frozenInput({ media: media({ contentType: "image/PNG" }) }),
      frozenInput({ media: media({ size: 0 }) }),
      frozenInput({ media: media({ size: -1 }) }),
      frozenInput({ media: media({ size: 1.5 }) }),
      frozenInput({ media: media({ size: Number.NaN }) }),
      frozenInput({ media: media({ size: Number.POSITIVE_INFINITY }) }),
      frozenInput({ media: media({ size: Number.MAX_SAFE_INTEGER + 1 }) }),
      frozenInput({ media: media({ width: 0 }) }),
      frozenInput({ media: media({ width: -1 }) }),
      frozenInput({ media: media({ width: 1.5 }) }),
      frozenInput({ media: media({ width: Number.NaN }) }),
      frozenInput({ media: media({ width: Number.POSITIVE_INFINITY }) }),
      frozenInput({ media: media({ width: Number.MAX_SAFE_INTEGER + 1 }) }),
      frozenInput({ media: media({ height: 0 }) }),
      frozenInput({ media: media({ height: -1 }) }),
      frozenInput({ media: media({ height: 1.5 }) }),
      frozenInput({ media: media({ height: Number.NaN }) }),
      frozenInput({ media: media({ height: Number.POSITIVE_INFINITY }) }),
      frozenInput({ media: media({ height: Number.MAX_SAFE_INTEGER + 1 }) }),
      frozenInput({ media: media({ extra: true }) })
    ]) {
      expectRejected(decodeWorldCaptureInputMetadata(input), "invalid-data", input);
    }
  });

  it("编码失败抛出契约错误，不产生部分元数据", () => {
    expect(() =>
      encodeWorldCaptureInputMetadata(frozenInput({ media: media({ size: -1 }) }) as unknown as WorldCaptureFrozenInput)
    ).toThrow(SharedWorldCodecError);
  });

  it("元数据只按完整内容精确相等，宽高各自变化及同字节数不同尺寸都能区分", () => {
    const base = frozenInput() as unknown as WorldCaptureFrozenInput;
    expect(worldCaptureInputMetadataEqual(base, { ...FROZEN_INPUT, key: { ...KEY }, media: { ...MEDIA } })).toBe(true);
    expect(worldCaptureInputMetadataEqual(base, {
      ...FROZEN_INPUT,
      media: { ...MEDIA, mediaId: "media-capture-2" }
    })).toBe(false);
    expect(worldCaptureInputMetadataEqual(base, {
      ...FROZEN_INPUT,
      media: { ...MEDIA, size: 2049 }
    })).toBe(false);
    expect(worldCaptureInputMetadataEqual(base, {
      ...FROZEN_INPUT,
      media: { ...MEDIA, width: 1025 }
    })).toBe(false);
    expect(worldCaptureInputMetadataEqual(base, {
      ...FROZEN_INPUT,
      media: { ...MEDIA, height: 769 }
    })).toBe(false);
    expect(worldCaptureInputMetadataEqual(base, {
      ...FROZEN_INPUT,
      media: { ...MEDIA, width: 2048, height: 1 }
    })).toBe(false);
    expect(worldCaptureInputMetadataEqual(
      { ...FROZEN_INPUT, media: { ...MEDIA, width: 2048, height: 1 } },
      { ...FROZEN_INPUT, media: { ...MEDIA, width: 1, height: 2048 } }
    )).toBe(false);
    expect(worldCaptureInputMetadataEqual(base, {
      ...FROZEN_INPUT,
      key: { ...KEY, worldContentVersion: "v10" }
    })).toBe(false);
    expect(worldCaptureInputMetadataEqual(base, {
      ...FROZEN_INPUT,
      key: { ...KEY, worldContentVersion: "v2" }
    })).toBe(false);
    expect(worldCaptureInputMetadataEqual(
      frozenInput({ media: media({ size: -1 }) }) as unknown as WorldCaptureFrozenInput,
      base
    )).toBe(false);
    expect(worldCaptureInputMetadataEqual(
      frozenInput({ media: media({ width: 0 }) }) as unknown as WorldCaptureFrozenInput,
      base
    )).toBe(false);
  });
});
