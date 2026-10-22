/**
 * 视频编辑 intent 契约测试
 * （change: port-video-editing-dialogs，任务 1.1–1.4 / design D4/D5/D6/D8）。
 *
 * 验证：
 * - schema round trip 保留时间、prompt、shapes、frame dimensions 与稳定 preview identity；
 * - 危险 preview（data URL / object URL / Blob / 临时签名 URL）与未知二进制字段被拒绝；
 * - 数量、prompt、shape、point、尺寸与序列化大小上限生效；
 * - 稳定排序与 provider 编译只为稳定 preview 生成 image reference。
 */
import { describe, expect, it } from "vitest";
import {
  VIDEO_EDIT_LIMITS,
  compileVideoEditProviderPrompt,
  normalizeVideoEditIntents,
  sanitizeVideoEditIntent,
  sortVideoEditIntents,
  type VideoEditIntent
} from "./video-edit";

const STORAGE_KEY = `sha256-${"a".repeat(64)}`;
const OTHER_KEY = `sha256-${"b".repeat(64)}`;

function rangeIntent(overrides: Partial<VideoEditIntent> = {}): VideoEditIntent {
  return {
    id: "i1",
    startSeconds: 2,
    endSeconds: 2.05,
    prompt: "人物转身面向镜头",
    annotationShapes: [
      {
        id: "s1",
        tool: "rect",
        color: "#ff3b30",
        strokeWidth: 2,
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.4, y: 0.5 }
        ]
      }
    ],
    annotationPreview: { assetId: "asset-1", storageKey: STORAGE_KEY, mediaType: "image/png" },
    frameWidth: 1920,
    frameHeight: 1080,
    ...overrides
  };
}

function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("视频编辑 intent schema 与 round trip", () => {
  it("合法区间 intent 被接受，round trip 保留时间/prompt/shapes/dimensions/preview", () => {
    const intent = rangeIntent();
    const normalized = normalizeVideoEditIntents([intent]);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const serialized = roundTrip(normalized.value);
    expect(serialized).toEqual([intent]);
  });

  it("点 intent 不含 end，往返保留", () => {
    const point: VideoEditIntent = { ...rangeIntent({ endSeconds: undefined }), id: "p1" };
    delete (point as { endSeconds?: number }).endSeconds;
    const normalized = normalizeVideoEditIntents([point]);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value[0]).toEqual(point);
    expect(normalized.value[0]).not.toHaveProperty("endSeconds");
  });
});

describe("危险 preview / URL / 二进制被拒绝", () => {
  it("data URL preview 被拒绝", () => {
    const intent = rangeIntent({
      annotationPreview: { assetId: "", storageKey: "data:image/png;base64,AAAA", mediaType: "image/png" }
    });
    expect(sanitizeVideoEditIntent(intent)).toBeNull();
    expect(normalizeVideoEditIntents([intent]).ok).toBe(false);
  });

  it("object URL / 临时签名 URL / blob preview 被拒绝", () => {
    for (const key of ["blob:http://localhost/abc", "https://cos.example.com/x?sign=abc", "/api/media/other"]) {
      const intent = rangeIntent({ annotationPreview: { assetId: "", storageKey: key, mediaType: "image/png" } });
      expect(normalizeVideoEditIntents([intent]).ok).toBe(false);
    }
  });

  it("annotationImageDataUrl 与未知二进制字段不会进入规范化结果", () => {
    const intent = { ...rangeIntent(), annotationImageDataUrl: "data:image/png;base64,AAAA", bytes: [1, 2, 3] };
    const normalized = normalizeVideoEditIntents([intent]);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value[0]).not.toHaveProperty("annotationImageDataUrl");
    expect(normalized.value[0]).not.toHaveProperty("bytes");
    expect(JSON.stringify(normalized.value)).not.toContain("data:");
  });
});

describe("时间、prompt、shape、尺寸上限", () => {
  it("区间小于 0.05 秒被拒绝", () => {
    expect(sanitizeVideoEditIntent(rangeIntent({ startSeconds: 2, endSeconds: 2.04 }))).toBeNull();
  });

  it("end 早于 start 被拒绝", () => {
    expect(sanitizeVideoEditIntent(rangeIntent({ startSeconds: 2, endSeconds: 1 }))).toBeNull();
  });

  it("时间越界 duration 被拒绝", () => {
    expect(sanitizeVideoEditIntent(rangeIntent({ startSeconds: 5 }), { duration: 4 })).toBeNull();
    expect(sanitizeVideoEditIntent(rangeIntent({ startSeconds: 1, endSeconds: 6 }), { duration: 4 })).toBeNull();
  });

  it("空 prompt 被拒绝，超长 prompt 被拒绝", () => {
    expect(sanitizeVideoEditIntent(rangeIntent({ prompt: "   " }))).toBeNull();
    expect(sanitizeVideoEditIntent(rangeIntent({ prompt: "x".repeat(VIDEO_EDIT_LIMITS.maxPromptChars + 1) }))).toBeNull();
  });

  it("非色板颜色 / 非允许线宽 / 越界坐标被拒绝", () => {
    const badColor = rangeIntent({
      annotationShapes: [{ id: "s", tool: "pen", color: "#123456", strokeWidth: 2, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }]
    });
    expect(sanitizeVideoEditIntent(badColor)).toBeNull();

    const badWidth = rangeIntent({
      annotationShapes: [{ id: "s", tool: "pen", color: "#ffffff", strokeWidth: 5, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }]
    });
    expect(sanitizeVideoEditIntent(badWidth)).toBeNull();

    const badPoint = rangeIntent({
      annotationShapes: [{ id: "s", tool: "pen", color: "#ffffff", strokeWidth: 1, points: [{ x: -0.1, y: 0 }, { x: 1, y: 1 }] }]
    });
    expect(sanitizeVideoEditIntent(badPoint)).toBeNull();
  });

  it("rect 必须恰好两个点", () => {
    const rect = rangeIntent({
      annotationShapes: [{ id: "s", tool: "rect", color: "#ffffff", strokeWidth: 1, points: [{ x: 0, y: 0 }] }]
    });
    expect(sanitizeVideoEditIntent(rect)).toBeNull();
  });

  it("frame dimensions 必须为正有限且不超上限", () => {
    expect(sanitizeVideoEditIntent(rangeIntent({ frameWidth: 0 }))).toBeNull();
    expect(sanitizeVideoEditIntent(rangeIntent({ frameWidth: VIDEO_EDIT_LIMITS.maxFrameDimension + 1 }))).toBeNull();
  });

  it("超过 intent 数量上限被拒绝", () => {
    const many = Array.from({ length: VIDEO_EDIT_LIMITS.maxIntents + 1 }, (_, index) =>
      rangeIntent({ id: `i${index}` })
    );
    expect(normalizeVideoEditIntents(many).ok).toBe(false);
  });

  it("id 重复被拒绝", () => {
    expect(normalizeVideoEditIntents([rangeIntent(), rangeIntent()]).ok).toBe(false);
  });

  it("序列化超限被拒绝", () => {
    const huge = rangeIntent({
      annotationShapes: Array.from({ length: 60 }, (_, shapeIndex) => ({
        id: `s${shapeIndex}`,
        tool: "pen" as const,
        color: "#ffffff",
        strokeWidth: 1,
        points: Array.from({ length: 2000 }, (_, pointIndex) => ({
          x: (pointIndex % 100) / 100,
          y: (pointIndex % 50) / 100
        }))
      }))
    });
    expect(sanitizeVideoEditIntent(huge)).toBeNull();
  });
});

describe("稳定排序", () => {
  it("按 start、end、id 排序且不改动入参", () => {
    const input = [
      rangeIntent({ id: "b", startSeconds: 3 }),
      rangeIntent({ id: "a", startSeconds: 1 }),
      rangeIntent({ id: "c", startSeconds: 3, endSeconds: 4 })
    ];
    const sorted = sortVideoEditIntents(input);
    expect(sorted.map((intent) => intent.id)).toEqual(["a", "b", "c"]);
    expect(input.map((intent) => intent.id)).toEqual(["b", "a", "c"]);
  });

  it("normalize 输出稳定排序", () => {
    const normalized = normalizeVideoEditIntents([
      { ...rangeIntent({ id: "b", startSeconds: 3 }), endSeconds: undefined } as VideoEditIntent,
      { ...rangeIntent({ id: "a", startSeconds: 1 }), endSeconds: undefined } as VideoEditIntent
    ]);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.map((intent) => intent.id)).toEqual(["a", "b"]);
  });
});

describe("provider 编译", () => {
  it("无序 intents 按稳定时间顺序输出，且无 preview 不产生 image reference", () => {
    const result = compileVideoEditProviderPrompt({
      intents: [
        { ...rangeIntent({ id: "later", startSeconds: 9 }), endSeconds: undefined, annotationPreview: undefined },
        { ...rangeIntent({ id: "earlier", startSeconds: 2 }), endSeconds: undefined, annotationPreview: undefined }
      ],
      basePrompt: "保持镜头稳定"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.imageReferences).toEqual([]);
    expect(result.prompt).not.toContain("@image");
    const earlierIndex = result.prompt.indexOf("2.00 秒");
    const laterIndex = result.prompt.indexOf("9.00 秒");
    expect(earlierIndex).toBeGreaterThanOrEqual(0);
    expect(laterIndex).toBeGreaterThan(earlierIndex);
    expect(result.prompt).toContain("补充要求：保持镜头稳定");
  });

  it("稳定 preview 才生成 image reference，且不含临时 URL", () => {
    const result = compileVideoEditProviderPrompt({
      intents: [rangeIntent({ id: "a", startSeconds: 2 })],
      imageReferenceOffset: 0
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.imageReferences).toEqual([
      { intentId: "a", storageKey: STORAGE_KEY, mediaType: "image/png" }
    ]);
    expect(result.prompt).toContain("@image1");
    expect(result.prompt).not.toContain("data:");
    expect(result.prompt).not.toContain("http");
  });

  it("非法 intent 使编译以稳定错误失败", () => {
    const result = compileVideoEditProviderPrompt({ intents: [{ ...rangeIntent(), prompt: "" }] });
    expect(result.ok).toBe(false);
  });

  it("越界时间使编译失败", () => {
    const result = compileVideoEditProviderPrompt({
      intents: [rangeIntent({ startSeconds: 10 })],
      duration: 5
    });
    expect(result.ok).toBe(false);
  });

  it("空 intents 返回 base prompt", () => {
    const result = compileVideoEditProviderPrompt({ intents: [], basePrompt: "基础" });
    expect(result).toEqual({ ok: true, prompt: "基础", imageReferences: [] });
  });

  it("只保留稳定 storageKey（不同 key 且稳定）", () => {
    const result = compileVideoEditProviderPrompt({
      intents: [rangeIntent({ id: "a", annotationPreview: { assetId: "", storageKey: OTHER_KEY, mediaType: "image/webp" } })]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.imageReferences[0]!.storageKey).toBe(OTHER_KEY);
  });
});
