/**
 * 模型身份与交互描述契约测试
 * （change: 2026-09-29-add-pluggable-model-interactions，任务 1.1 / 1.2 / 1.4；
 *  change: 2026-10-07-remove-residual-compatibility —— 删除旧 modelId 迁移解析）。
 *
 * 锁定两件事：
 * - `modelKey` 的格式与 opaque 查找；
 * - `interaction` 只接受 `{ id, version }`，任何可执行 UI 字段都被拒绝。
 */
import { describe, expect, it } from "vitest";
import {
  GENERIC_MODEL_INTERACTION_ID,
  GENERIC_MODEL_INTERACTION_VERSION,
  isModelInteractionDescriptor,
  isModelKey,
  normalizeModelInteractionDescriptor,
  sameModelInteraction
} from "./model-identity.js";

describe("modelKey 格式", () => {
  it("接受带命名空间的 opaque key", () => {
    expect(isModelKey("litellm:gpt-image-2")).toBe(true);
    expect(isModelKey("ark:seedance2_0")).toBe(true);
  });

  it("接受含路径段的 opaque key（RunningHub api/<endpoint>）", () => {
    expect(isModelKey("runninghub:api/seedream-v5-pro")).toBe(true);
    expect(isModelKey("runninghub:api/bytedance/seedance-2.0-global")).toBe(true);
  });

  it("拒绝空、超长、以分隔符开头或含空格/控制字符的值", () => {
    expect(isModelKey("")).toBe(false);
    expect(isModelKey(":bad")).toBe(false);
    expect(isModelKey("/bad")).toBe(false);
    expect(isModelKey("bad value")).toBe(false);
    expect(isModelKey("bad\tvalue")).toBe(false);
    expect(isModelKey("x".repeat(201))).toBe(false);
    expect(isModelKey(42)).toBe(false);
  });
});

describe("interaction descriptor 校验", () => {
  it("接受 generic descriptor", () => {
    expect(
      isModelInteractionDescriptor({ id: GENERIC_MODEL_INTERACTION_ID, version: GENERIC_MODEL_INTERACTION_VERSION })
    ).toBe(true);
  });

  it("拒绝可执行 UI / 未知字段 / 非法 version", () => {
    expect(isModelInteractionDescriptor({ id: "seedance-video", version: 1, moduleUrl: "https://evil" })).toBe(false);
    expect(isModelInteractionDescriptor({ id: "seedance-video", version: 1, componentPath: "./x" })).toBe(false);
    expect(isModelInteractionDescriptor({ id: "seedance-video", version: 0 })).toBe(false);
    expect(isModelInteractionDescriptor({ id: "seedance-video", version: 1.5 })).toBe(false);
    expect(isModelInteractionDescriptor({ id: "Seedance Video", version: 1 })).toBe(false);
    expect(isModelInteractionDescriptor({ id: "seedance-video" })).toBe(false);
  });

  it("normalize 缺省时使用受信任 fallback", () => {
    expect(normalizeModelInteractionDescriptor(undefined, { id: "generic-model", version: 1 })).toEqual({
      id: "generic-model",
      version: 1
    });
    expect(normalizeModelInteractionDescriptor({ id: "x", version: 1, url: "y" })).toBeNull();
  });

  it("sameModelInteraction 精确匹配 id+version", () => {
    expect(sameModelInteraction({ id: "a", version: 1 }, { id: "a", version: 1 })).toBe(true);
    expect(sameModelInteraction({ id: "a", version: 1 }, { id: "a", version: 2 })).toBe(false);
    expect(sameModelInteraction(undefined, { id: "a", version: 1 })).toBe(false);
  });
});
