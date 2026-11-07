/**
 * 身份参考策略默认值与序列化
 * （change: 2026-11-06-require-identity-reference，任务 1.1）。
 */
import { describe, expect, it } from "vitest";
import {
  CANVAS_REFERENCE_POLICIES,
  effectiveReferencePolicy,
  hasReadyImageReference,
  IDENTITY_REFERENCE_INVALID_REASON,
  IDENTITY_REFERENCE_REQUIRED_REASON,
  normalizeReferencePolicy
} from "./reference-policy.js";
import { decodeTaskSubmitRequest } from "./protocol.js";

describe("reference policy", () => {
  it("缺省/非法值收敛为 optional，合法值往返不变", () => {
    expect(CANVAS_REFERENCE_POLICIES).toEqual(["optional", "identity-required"]);
    expect(normalizeReferencePolicy(undefined)).toBe("optional");
    expect(normalizeReferencePolicy("bogus")).toBe("optional");
    expect(normalizeReferencePolicy("identity-required")).toBe("identity-required");
  });

  it("节点设置优先于模型声明", () => {
    expect(effectiveReferencePolicy(undefined, undefined)).toBe("optional");
    expect(effectiveReferencePolicy(undefined, "identity-required")).toBe("identity-required");
    expect(effectiveReferencePolicy("optional", "identity-required")).toBe("optional");
    expect(effectiveReferencePolicy("identity-required", "optional")).toBe("identity-required");
    expect(effectiveReferencePolicy("bogus", "identity-required")).toBe("identity-required");
  });

  it("ready 图片识别同时接受 mediaKind 与 mediaType", () => {
    expect(hasReadyImageReference([])).toBe(false);
    expect(hasReadyImageReference([{ mediaKind: "video", mediaType: "video/mp4" }])).toBe(false);
    expect(hasReadyImageReference([{ mediaKind: "image", mediaType: "image/png" }])).toBe(true);
    expect(hasReadyImageReference([{ mediaType: "image/webp" }])).toBe(true);
  });

  it("阻止原因文案可行动且稳定", () => {
    expect(IDENTITY_REFERENCE_REQUIRED_REASON).toContain("参考图");
    expect(IDENTITY_REFERENCE_INVALID_REASON).toContain("重新选择");
  });
});

describe("catalog 模型声明", () => {
  it("referencePolicy 可序列化，缺省按 optional 读取", () => {
    const model = {
      modelKey: "m",
      providerId: "p",
      providerModelId: "m",
      modelType: "image" as const,
      title: "M",
      interaction: { id: "generic-model", version: 1 },
      inputSchema: {},
      defaultInput: {},
      bindings: [],
      referencePolicy: "identity-required" as const,
      taskTimeoutMs: 1000
    };
    const restored = JSON.parse(JSON.stringify(model)) as { referencePolicy?: unknown };
    expect(restored.referencePolicy).toBe("identity-required");
    expect(effectiveReferencePolicy(undefined, restored.referencePolicy)).toBe("identity-required");
    const legacy = { ...model, referencePolicy: undefined };
    expect(effectiveReferencePolicy(undefined, legacy.referencePolicy)).toBe("optional");
  });
});

describe("提交快照的参考身份字段", () => {
  const request = {
    workerTaskKey: "task-1",
    canvasId: "canvas-1",
    nodeId: "node-1",
    nodeType: "image" as const,
    modelType: "image" as const,
    modelKey: "m",
    prompt: "同一角色近景",
    parameters: {},
    runId: "run-1",
    jobId: "job-1",
    inputs: [
      {
        assetId: "asset-1",
        role: "reference_image",
        storageKey: "sha256-" + "a".repeat(64),
        mediaType: "image/png",
        mediaKind: "image" as const,
        slotId: "slot-1",
        sourceNodeId: "node-source",
        order: 0
      }
    ]
  };

  it("解码保留 assetId、来源节点、slot 与顺序", () => {
    const decoded = decodeTaskSubmitRequest(request);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.inputs).toEqual(request.inputs);
  });

  it("非法 slot / order 被拒绝", () => {
    const badOrder = decodeTaskSubmitRequest({ ...request, inputs: [{ ...request.inputs[0], order: -1 }] });
    expect(badOrder).toMatchObject({ ok: false, code: "malformed-request" });
    const badSlot = decodeTaskSubmitRequest({ ...request, inputs: [{ ...request.inputs[0], slotId: "" }] });
    expect(badSlot).toMatchObject({ ok: false, code: "malformed-request" });
  });
});
