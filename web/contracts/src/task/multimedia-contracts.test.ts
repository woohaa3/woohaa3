/**
 * 四媒体任务契约（change: add-audio-video-generation-and-align-model-catalog，任务 1.2–1.5）。
 *
 * 验证 text/image/video/audio 的节点类型、任务 kind、模型类型、稳定输入、结果摘要与
 * catalog bindings 的新旧兼容行为。
 */
import { describe, expect, it } from "vitest";
import {
  CANVAS_TASK_LIMITS,
  DEFAULT_TASK_TIMEOUT_MS,
  NODE_TYPE_TO_TASK_KIND,
  TASK_KIND_TO_MODEL_TYPE,
  catalogModelBindings,
  isCanvasTaskModelType,
  isCanvasTaskNodeType,
  isNodeModelTypeMatch,
  normalizeInputBindings
} from "./dto.js";
import { checkModelCapability, decodeTaskSubmitRequest, inferMediaKindFromType } from "./protocol.js";
import { containsForbiddenHistoryKey } from "./history.js";

describe("四媒体节点/kind/model 类型", () => {
  it("节点类型与任务 kind 一一对应", () => {
    expect(NODE_TYPE_TO_TASK_KIND).toEqual({
      text: "text-generation",
      image: "image-generation",
      video: "video-generation",
      audio: "audio-generation"
    });
    expect(TASK_KIND_TO_MODEL_TYPE).toEqual({
      "text-generation": "language",
      "image-generation": "image",
      "video-generation": "video",
      "audio-generation": "audio"
    });
  });

  it("节点/模型类型判定包含四类", () => {
    for (const value of ["text", "image", "video", "audio"]) {
      expect(isCanvasTaskNodeType(value)).toBe(true);
    }
    for (const value of ["language", "image", "video", "audio"]) {
      expect(isCanvasTaskModelType(value)).toBe(true);
    }
    expect(isCanvasTaskNodeType("generate")).toBe(false);
    expect(isCanvasTaskModelType("storyboard")).toBe(false);
  });

  it("节点↔模型配对", () => {
    expect(isNodeModelTypeMatch("video", "video")).toBe(true);
    expect(isNodeModelTypeMatch("audio", "audio")).toBe(true);
    expect(isNodeModelTypeMatch("video", "audio")).toBe(false);
    expect(isNodeModelTypeMatch("image", "language")).toBe(false);
  });

  it("超时默认含音频 8 分钟", () => {
    expect(DEFAULT_TASK_TIMEOUT_MS.audio).toBe(8 * 60_000);
    expect(DEFAULT_TASK_TIMEOUT_MS.video).toBe(20 * 60_000);
  });

  it("二进制上限按媒体类型分档", () => {
    expect(CANVAS_TASK_LIMITS.maxAudioOutputBytes).toBe(64 * 1024 * 1024);
    expect(CANVAS_TASK_LIMITS.maxVideoOutputBytes).toBe(256 * 1024 * 1024);
  });
});

describe("多模态 binding", () => {
  it("规范化去空、夹 maxItems、默认 roles/mediaTypes", () => {
    const bindings = normalizeInputBindings([
      { field: "urls", semantic: "reference-image", maxItems: 999 },
      { field: "videoUrls", semantic: "reference-video", maxItems: 1 },
      { field: "audioUrls", semantic: "reference-audio" },
      { field: "nope", semantic: "unknown" }
    ]);
    expect(bindings).toHaveLength(3);
    expect(bindings[0]).toMatchObject({ semantic: "reference-image", mediaKinds: ["image"], maxItems: CANVAS_TASK_LIMITS.maxReferences });
    expect(bindings[1]).toMatchObject({ semantic: "reference-video", mediaKinds: ["video"], maxItems: 1, roles: ["reference_video"] });
    expect(bindings[2]).toMatchObject({ semantic: "reference-audio", mediaKinds: ["audio"], roles: ["reference_audio"] });
  });

  it("catalog bindings 只读显式 bindings（旧图片字段不再投影）", () => {
    expect(catalogModelBindings({ bindings: [{ field: "urls", semantic: "reference-image", maxItems: 2 }] })).toEqual([
      expect.objectContaining({ field: "urls", semantic: "reference-image", maxItems: 2 })
    ]);
    expect(catalogModelBindings({})).toEqual([]);
  });
});

describe("submit 四媒体校验", () => {
  const base = {
    workerTaskKey: "w1",
    canvasId: "c1",
    nodeId: "n1",
    runId: "r1",
    jobId: "j1",
    prompt: "hi",
    parameters: {}
  };

  it("video/audio 节点与模型配对通过", () => {
    const video = decodeTaskSubmitRequest({ ...base, nodeType: "video", modelType: "video", modelKey: "ark:seedance2_0" });
    expect(video.ok).toBe(true);
    const audio = decodeTaskSubmitRequest({ ...base, nodeType: "audio", modelType: "audio", modelKey: "litellm:minimax-speech-2.8-hd" });
    expect(audio.ok).toBe(true);
  });

  it("配音跨媒体不匹配被拒绝", () => {
    const mismatch = decodeTaskSubmitRequest({ ...base, nodeType: "audio", modelType: "video", modelKey: "ark:seedance2_0" });
    expect(mismatch.ok).toBe(false);
  });

  it("input mediaKind 合法值通过、非法值拒绝", () => {
    const ok = decodeTaskSubmitRequest({
      ...base,
      nodeType: "video",
      modelType: "video",
      modelKey: "ark:seedance2_0",
      inputs: [{ assetId: "a", role: "reference_video", storageKey: "sha256-" + "a".repeat(64), mediaType: "video/mp4", mediaKind: "video" }]
    });
    expect(ok.ok).toBe(true);
    const bad = decodeTaskSubmitRequest({
      ...base,
      nodeType: "video",
      modelType: "video",
      modelKey: "ark:seedance2_0",
      inputs: [{ assetId: "a", role: "r", storageKey: "sha256-" + "a".repeat(64), mediaType: "video/mp4", mediaKind: "storyboard" }]
    });
    expect(bad.ok).toBe(false);
  });

  it("binding 驱动能力校验：角色/媒体类型/按 field 计数", () => {
    const request = decodeTaskSubmitRequest({
      ...base,
      nodeType: "video",
      modelType: "video",
      modelKey: "ark:seedance2_0",
      inputs: [
        { assetId: "a", role: "first_frame", storageKey: "sha256-" + "a".repeat(64), mediaType: "image/png", mediaKind: "image" },
        { assetId: "b", role: "last_frame", storageKey: "sha256-" + "b".repeat(64), mediaType: "image/png", mediaKind: "image" }
      ]
    });
    if (!request.ok) throw new Error("fixture invalid");
    const model = {
      providerId: "ark",
      modelKey: "ark:seedance2_0",
      providerModelId: "seedance2_0",
      modelType: "video" as const,
      title: "Seedance 2.0",
      interaction: { id: "generic-model", version: 1 },
      inputSchema: {},
      defaultInput: {},
      bindings: [
        { field: "frames", semantic: "reference-image" as const, roles: ["first_frame", "last_frame"], mediaKinds: ["image" as const], mediaTypes: ["image/png"], maxItems: 2, valueFormat: "url" as const }
      ],
      taskTimeoutMs: 1000
    };
    expect(checkModelCapability(request.value, model).ok).toBe(true);

    // 超过该 field 上限
    const over = decodeTaskSubmitRequest({
      ...base,
      nodeType: "video",
      modelType: "video",
      modelKey: "ark:seedance2_0",
      inputs: [
        { assetId: "a", role: "first_frame", storageKey: "sha256-" + "a".repeat(64), mediaType: "image/png", mediaKind: "image" },
        { assetId: "b", role: "first_frame", storageKey: "sha256-" + "b".repeat(64), mediaType: "image/png", mediaKind: "image" },
        { assetId: "c", role: "first_frame", storageKey: "sha256-" + "c".repeat(64), mediaType: "image/png", mediaKind: "image" }
      ]
    });
    if (!over.ok) throw new Error("fixture invalid");
    expect(checkModelCapability(over.value, model).ok).toBe(false);
  });

  it("同一角色有多个字段时按输入自带的 field 计数，不把它们都算到第一个字段", () => {
    // ppserver：主图上限 1 + 参考图上限 9，两条绑定角色/类型完全一样。
    const model = {
      providerId: "ppserver",
      modelKey: "ppserver:tpl",
      providerModelId: "tpl",
      modelType: "image" as const,
      title: "Banana",
      interaction: { id: "generic-model", version: 1 },
      inputSchema: {},
      defaultInput: {},
      bindings: [
        { field: "3_image", semantic: "reference-image" as const, roles: ["reference_image"], mediaKinds: ["image" as const], mediaTypes: ["image/png"], maxItems: 1, valueFormat: "url" as const },
        { field: "1x_image", semantic: "reference-image" as const, roles: ["reference_image"], mediaKinds: ["image" as const], mediaTypes: ["image/png"], maxItems: 9, valueFormat: "url" as const }
      ],
      taskTimeoutMs: 1000
    };
    const image = (seed: string, field?: string) => ({
      assetId: seed,
      role: "reference_image",
      storageKey: "sha256-" + seed.repeat(64),
      mediaType: "image/png",
      mediaKind: "image" as const,
      ...(field ? { field } : {})
    });
    const decode = (inputs: unknown[]) =>
      decodeTaskSubmitRequest({ ...base, nodeType: "image", modelType: "image", modelKey: "ppserver:tpl", inputs });

    // 前端/Canvas 已按容量分配：主图 1 张 + 参考图 1 张，合法。
    const distributed = decode([image("a", "3_image"), image("b", "1x_image")]);
    if (!distributed.ok) throw new Error("fixture invalid");
    expect(checkModelCapability(distributed.value, model).ok).toBe(true);

    // 没有 field 的旧请求保留旧行为：两张都算到第一个字段，超限。
    const legacy = decode([image("a"), image("b")]);
    if (!legacy.ok) throw new Error("fixture invalid");
    expect(checkModelCapability(legacy.value, model).ok).toBe(false);

    // 声称写进主图的两张仍然超限。
    const overMain = decode([image("a", "3_image"), image("b", "3_image")]);
    if (!overMain.ok) throw new Error("fixture invalid");
    expect(checkModelCapability(overMain.value, model).ok).toBe(false);

    // 声称的字段根本不存在 → 拒绝，而不是悄悄换一个字段。
    const unknownField = decode([image("a", "nope")]);
    if (!unknownField.ok) throw new Error("fixture invalid");
    expect(checkModelCapability(unknownField.value, model).ok).toBe(false);
  });

  it("mediaKind 缺失时按 mediaType 推断", () => {
    expect(inferMediaKindFromType("video/webm")).toBe("video");
    expect(inferMediaKindFromType("audio/mpeg")).toBe("audio");
    expect(inferMediaKindFromType("image/png")).toBe("image");
    expect(inferMediaKindFromType("text/plain")).toBeUndefined();
  });
});

describe("结果安全摘要", () => {
  it("禁止 URL/bytes 等敏感键", () => {
    expect(containsForbiddenHistoryKey({ mediaKind: "video", storageKey: "generation-outputs/" + "a".repeat(64) + ".mp4", durationSeconds: 5 })).toBe(false);
    expect(containsForbiddenHistoryKey({ mediaKind: "video", url: "https://x" })).toBe(true);
    expect(containsForbiddenHistoryKey({ poster: { url: "https://x" } })).toBe(true);
  });
});
