/**
 * 画布内「同一模型上一次参数」偏好回归。
 *
 * 锁定的缺陷：草稿只按 `{nodeId, modelKey}` 隔离，换一个节点（或新建节点）就回落到
 * 模型 schema 默认值，同一模型在每张卡片上都要重设画幅/分辨率/时长。
 */
import { describe, expect, it } from "vitest";
import {
  CanvasModelParameterStore,
  canvasModelParametersKey,
  rememberedModelParameters,
} from "./canvas-model-parameters.js";
import { catalogFixture } from "./test-support/fixtures.js";
import type { CanvasTaskCatalogModel } from "@woohaa3/contracts";

const mem = () => {
  const data = new Map<string, string>();
  return {
    data,
    storage: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) },
  };
};

const model = (overrides: Partial<CanvasTaskCatalogModel> & { modelKey: string }): CanvasTaskCatalogModel =>
  catalogFixture([overrides]).models[0]!;

describe("画布内模型参数偏好", () => {
  it("按数据空间与画布分桶，同模型跨节点沿用，其它画布与主体互不影响", () => {
    const { storage } = mem();
    const store = new CanvasModelParameterStore(() => storage);
    const a = canvasModelParametersKey("page", "canvas-a");
    const b = canvasModelParametersKey("page", "canvas-b");
    store.record(a, "model-x", { model: "model-x", aspectRatio: "9:16", durationSeconds: 8 });
    expect(store.get(a, "model-x")).toEqual({ aspectRatio: "9:16", durationSeconds: 8 });
    expect(store.get(b, "model-x")).toBeUndefined();
    expect(store.get(canvasModelParametersKey("other", "canvas-a"), "model-x")).toBeUndefined();
  });

  it("刷新后从存储读回（同一 store 构造在无内存缓存时仍可取）", () => {
    const { storage } = mem();
    const key = canvasModelParametersKey("page", "canvas-a");
    new CanvasModelParameterStore(() => storage).record(key, "model-x", { resolution: "2K" });
    expect(new CanvasModelParameterStore(() => storage).get(key, "model-x")).toEqual({ resolution: "2K" });
  });

  it("存储不可用时退回本页内存，不抛错", () => {
    const store = new CanvasModelParameterStore(() => {
      throw new Error("storage unavailable");
    });
    const key = canvasModelParametersKey("page", "canvas-a");
    store.record(key, "model-x", { resolution: "1080p" });
    expect(store.get(key, "model-x")).toEqual({ resolution: "1080p" });
  });

  it("损坏内容按空桶处理", () => {
    const { data, storage } = mem();
    const key = canvasModelParametersKey("page", "canvas-a");
    data.set(key, "{not json");
    expect(new CanvasModelParameterStore(() => storage).get(key, "model-x")).toBeUndefined();
  });

  it("回放时按当前 schema 过滤：旧枚举、隐藏字段与移除的字段都不套用", () => {
    const current = model({
      modelKey: "video",
      modelType: "video",
      inputSchema: {
        type: "object",
        required: ["resolution"],
        properties: {
          resolution: { type: "string", title: "分辨率", enum: ["720p", "1080p"], default: "720p" },
          durationSeconds: { type: "integer", title: "时长", minimum: 2, maximum: 12, default: 5, unit: "秒" },
          generationMode: { type: "string", title: "模式", enum: ["t2v", "edit_video"], default: "t2v" },
          frameCount: { type: "integer", title: "帧数", default: 24, "x-hidden-when": [{ field: "generationMode", equals: "t2v" }] },
        },
      },
      defaultInput: {},
    });
    const replayed = rememberedModelParameters(current, {
      resolution: "1080p",
      durationSeconds: 9,
      frameCount: 60,
      removedEnum: "hd",
      removedField: 1,
    });
    expect(replayed).toEqual({ resolution: "1080p", durationSeconds: 9, generationMode: "t2v" });
  });

  it("记录里没有任何当前模型认识的字段时不算有偏好", () => {
    const current = model({
      modelKey: "image",
      inputSchema: { type: "object", properties: { ratio: { type: "string", enum: ["1:1", "16:9"], default: "1:1" } } },
      defaultInput: {},
    });
    expect(rememberedModelParameters(current, { legacySize: "1024x1024" })).toBeUndefined();
    expect(rememberedModelParameters(current, undefined)).toBeUndefined();
    expect(rememberedModelParameters(null, { ratio: "16:9" })).toBeUndefined();
  });

  it("选中值带出的结构联动与隐藏联动与模型切换口径一致", () => {
    const current = model({
      modelKey: "image",
      inputSchema: {
        type: "object",
        properties: {
          background: { type: "string", title: "背景", enum: [{ value: "transparent", label: "透明", "x-pptask-requires": { format: "png" } }, "opaque"], default: "opaque" },
          format: { type: "string", title: "格式", enum: ["png", "jpeg"], default: "jpeg" },
        },
      },
      defaultInput: {},
    });
    expect(rememberedModelParameters(current, { background: "transparent", format: "jpeg" }))
      .toEqual({ background: "transparent", format: "png" });
  });

  it("只保留最近使用的有限个模型，超过上限淘汰最旧的", () => {
    const { storage } = mem();
    const store = new CanvasModelParameterStore(() => storage);
    const key = canvasModelParametersKey("page", "canvas-a");
    for (let index = 0; index < 30; index += 1) store.record(key, `model-${index}`, { ratio: "1:1" });
    const bucket = store.read(key);
    expect(Object.keys(bucket)).toHaveLength(24);
    expect(bucket["model-29"]).toEqual({ ratio: "1:1" });
    expect(bucket["model-0"]).toBeUndefined();
  });
});
