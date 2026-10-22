/**
 * 运行时 nodeData 可移植契约
 * （change: align-godot-canvas-interactions，任务 1.2 / 1.3；
 *  change: replace-godot-canvas-runtime-with-bevy，任务 3.x/6.x 改为 renderer-neutral）。
 *
 * 验证：
 * - 合法值（prompt/agentId/sceneId/modelPlacement/shotPose）往返保留；
 * - 非有限数值、运行时对象/路径、越权任务字段被拒绝或移除；
 * - 复制清理删除 activeRunId/taskStatus/progress/providerTaskId/outputAssetId/error
 *   与本机路径，同时保留用户配置。
 */
import { describe, expect, it } from "vitest";
import { sanitizeRuntimeNodeConfigPatch, sanitizeNodeDataForClipboard } from "./runtime-node-data";

describe("运行时 nodeData allowlist", () => {
  it("合法字段往返保留", () => {
    const result = sanitizeRuntimeNodeConfigPatch({
      prompt: "一只猫",
      panelPrompt: "面板提示",
      agentId: "004-moonwood-sylph",
      sceneId: "scene-1",
      modelPlacement: { offset: { x: 1, y: 2, z: 3 }, scale: 1.5, yaw: 0.25 },
      shotPose: { azimuth: 1.2, distance: 8.5 }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      prompt: "一只猫",
      panelPrompt: "面板提示",
      agentId: "004-moonwood-sylph",
      sceneId: "scene-1",
      modelPlacement: { offset: { x: 1, y: 2, z: 3 }, scale: 1.5, yaw: 0.25 },
      shotPose: { azimuth: 1.2, distance: 8.5 }
    });
  });

  it("保留 DOM 参数面板提交的向量摆放与机位字段", () => {
    const result = sanitizeRuntimeNodeConfigPatch({
      modelPlacement: { position: [1, 2, 3], rotation: [0, 90, 0], scale3: [1, 1, 2] },
      shotPose: { azimuth: 0.5, distance: 10, target: [0, 2, 0] }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.modelPlacement).toEqual({
      position: [1, 2, 3],
      rotation: [0, 90, 0],
      scale3: [1, 1, 2]
    });
    expect(result.value.shotPose).toEqual({ azimuth: 0.5, distance: 10, target: [0, 2, 0] });
  });

  it("非有限数值被拒绝（NaN / Infinity）", () => {
    expect(sanitizeRuntimeNodeConfigPatch({ modelPlacement: { scale: Number.NaN } }).ok).toBe(false);
    expect(sanitizeRuntimeNodeConfigPatch({ modelPlacement: { scale: Number.POSITIVE_INFINITY } }).ok).toBe(false);
    expect(sanitizeRuntimeNodeConfigPatch({ shotPose: { distance: Number.NEGATIVE_INFINITY } }).ok).toBe(false);
    expect(sanitizeRuntimeNodeConfigPatch({ modelPlacement: { position: [0, Number.NaN, 0] } }).ok).toBe(false);
  });

  it("越权任务字段被移除；只剩越权字段时整条拒绝", () => {
    const mixed = sanitizeRuntimeNodeConfigPatch({
      prompt: "保留",
      taskStatus: "successed",
      activeRunId: "run-1",
      outputAssetId: "asset-1",
      providerTaskId: "p-1",
      error: "boom"
    });
    expect(mixed.ok).toBe(true);
    if (!mixed.ok) return;
    expect(mixed.value).toEqual({ prompt: "保留" });

    expect(sanitizeRuntimeNodeConfigPatch({ activeRunId: "run-1" }).ok).toBe(false);
    expect(sanitizeRuntimeNodeConfigPatch({ jsPath: "res://x.js" }).ok).toBe(false);
  });

  it("运行时对象/未知子字段被移除而不是写入", () => {
    const result = sanitizeRuntimeNodeConfigPatch({
      prompt: "p",
      modelPlacement: { offset: { x: 1 }, basis: { bogus: true }, transform: [1, 2, 3] },
      shotPose: { azimuth: 0.5, basis: { bogus: true } },
      unknown: { whatever: true }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.modelPlacement).toEqual({ offset: { x: 1 } });
    expect(result.value.shotPose).toEqual({ azimuth: 0.5 });
    expect(result.value).not.toHaveProperty("unknown");
  });

  it("非字符串 prompt 被拒绝", () => {
    expect(sanitizeRuntimeNodeConfigPatch({ prompt: { nested: true } }).ok).toBe(false);
  });
});

describe("剪贴板复制清理", () => {
  it("删除运行态/结果/本机路径，保留用户配置", () => {
    const cleaned = sanitizeNodeDataForClipboard({
      title: "保留标题",
      prompt: "保留提示词",
      parameters: { model: "gpt" },
      agentId: "agent-1",
      activeRunId: "run-1",
      taskStatus: "processing",
      progress: 0.4,
      providerTaskId: "provider-1",
      outputAssetId: "asset-1",
      error: "boom",
      errorMessage: "boom2",
      result: { kind: "text", text: "x" },
      jsPath: "res://web/scenes/x.js",
      image_path: "user://uploads/a.png",
      someUrl: "https://example.com/x",
      shotPose: { azimuth: 1, distance: 2 }
    });
    expect(cleaned).toMatchObject({
      title: "保留标题",
      prompt: "保留提示词",
      parameters: { model: "gpt" },
      agentId: "agent-1",
      shotPose: { azimuth: 1, distance: 2 }
    });
    for (const key of [
      "activeRunId",
      "taskStatus",
      "progress",
      "providerTaskId",
      "outputAssetId",
      "error",
      "errorMessage",
      "result",
      "jsPath",
      "image_path",
      "someUrl"
    ]) {
      expect(cleaned).not.toHaveProperty(key);
    }
  });

  it("非有限数值与嵌套对象引用被移除", () => {
    const cleaned = sanitizeNodeDataForClipboard({
      keep: "v",
      bad: Number.NaN,
      fn: () => undefined,
      nested: { ok: 1, bad: Number.POSITIVE_INFINITY },
      list: [1, 2, Number.NaN]
    });
    expect(cleaned).toEqual({ keep: "v" });
  });
});
