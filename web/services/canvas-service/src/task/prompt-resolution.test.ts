/**
 * 权威 prompt 解析测试（change: integrate-origin-master-after-web-split）。
 *
 * 覆盖 spec「Canvas Service authoritatively resolves text prompts」四个 scenario：
 * typed prompt 优先、上游 ready 文本资产拼接、上游文本 prompt 回退、空上游文本拒绝；
 * 以及 `text_prompt` 映射不被当作图片参考。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas, type StoredAsset } from "@woohaa3/contracts";
import {
  EMPTY_UPSTREAM_TEXT_CODE,
  EMPTY_UPSTREAM_TEXT_MESSAGE,
  hasUpstreamTextNode,
  resolveImagePrompt
} from "./prompt-resolution.js";
import { resolveNodeReferenceInputs } from "./input-resolution.js";

const NOW = "2026-09-24T00:00:00.000Z";

function textAsset(id: string, text: string, status: StoredAsset["status"] = "ready"): StoredAsset {
  return {
    id,
    title: `文本 ${id}`,
    mediaKind: "text",
    source: "generated",
    status,
    text,
    createdAt: NOW,
    metadata: {}
  };
}

function canvasWith(overrides: {
  textNode?: boolean;
  outputAssetId?: string;
  panelPrompt?: string;
  assets?: StoredAsset[];
}): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas-prompt", NOW);
  canvas.document.nodes.push({ id: "image-1", type: "image", position: { x: 0, y: 0 } });
  if (overrides.textNode) {
    canvas.document.nodes.push({ id: "text-1", type: "text", position: { x: 300, y: 0 } });
    canvas.document.edges.push({ id: "e1", source: "text-1", target: "image-1", data: {} });
    canvas.nodeData["text-1"] = {
      ...(overrides.outputAssetId ? { outputAssetId: overrides.outputAssetId } : {}),
      ...(overrides.panelPrompt !== undefined ? { panelPrompt: overrides.panelPrompt } : {})
    };
  }
  canvas.assets.push(...(overrides.assets ?? []));
  return canvas;
}

const IMAGE_PANEL = "image-generation";

describe("resolveImagePrompt", () => {
  it("typed prompt 去空白后非空时优先使用", () => {
    const canvas = canvasWith({ textNode: true, panelPrompt: "回退" });
    const result = resolveImagePrompt({ canvas, nodeId: "image-1", panelKind: IMAGE_PANEL, typed: "  用户输入  " });
    expect(result).toEqual({ kind: "ok", text: "用户输入" });
  });

  it("prompt 为空且上游有 ready 文本资产时拼接内容", () => {
    const canvas = canvasWith({ textNode: true, outputAssetId: "asset-t", assets: [textAsset("asset-t", "一只猫")] });
    const result = resolveImagePrompt({ canvas, nodeId: "image-1", panelKind: IMAGE_PANEL, typed: "" });
    expect(result).toEqual({ kind: "ok", text: "一只猫" });
  });

  it("上游无生成文本时回退到文字节点自身 prompt/panelPrompt", () => {
    const canvas = canvasWith({ textNode: true, panelPrompt: "上游提示词" });
    const result = resolveImagePrompt({ canvas, nodeId: "image-1", panelKind: IMAGE_PANEL, typed: "" });
    expect(result).toEqual({ kind: "ok", text: "上游提示词" });
  });

  it("存在上游文字节点但所有内容为空 → empty-upstream-text", () => {
    const canvas = canvasWith({ textNode: true, outputAssetId: "asset-empty", assets: [textAsset("asset-empty", "   ")] });
    const result = resolveImagePrompt({ canvas, nodeId: "image-1", panelKind: IMAGE_PANEL, typed: "" });
    expect(result.kind).toBe("empty-upstream-text");
    expect(EMPTY_UPSTREAM_TEXT_CODE).toBe("empty-upstream-text");
    expect(EMPTY_UPSTREAM_TEXT_MESSAGE).toBe("上游文字节点没有内容");
  });

  it("无上游文字节点且 prompt 为空时返回空文本（交由上层判定）", () => {
    const canvas = canvasWith({});
    expect(resolveImagePrompt({ canvas, nodeId: "image-1", panelKind: IMAGE_PANEL, typed: "" }))
      .toEqual({ kind: "ok", text: "" });
    expect(hasUpstreamTextNode(canvas, "image-1")).toBe(false);
  });

  it("hasUpstreamTextNode 在有连入文字节点时为真", () => {
    const canvas = canvasWith({ textNode: true });
    expect(hasUpstreamTextNode(canvas, "image-1")).toBe(true);
  });
});

describe("text_prompt 不是图片参考", () => {
  it("连入的文字节点被跳过，不产生参考图或阻塞原因", () => {
    const canvas = canvasWith({ textNode: true, outputAssetId: "asset-t", assets: [textAsset("asset-t", "一只猫")] });
    const resolution = resolveNodeReferenceInputs({
      canvas,
      nodeId: "image-1",
      bindings: [
        {
          field: "referenceImages",
          semantic: "reference-image",
          roles: ["reference_image"],
          mediaKinds: ["image"],
          mediaTypes: ["image/png"],
          maxItems: 4,
          valueFormat: "url"
        }
      ]
    });
    expect(resolution.references).toEqual([]);
    expect(resolution.inputs).toEqual([]);
    expect(resolution.blockingReasons).toEqual([]);
  });
});
