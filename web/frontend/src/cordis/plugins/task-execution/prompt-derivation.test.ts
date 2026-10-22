/**
 * 面板派生辅助测试（change: integrate-origin-master-after-web-split）。
 *
 * 只验证按钮/弹窗所需的派生判定；权威 prompt 解析由 Canvas Service 负责。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas, type StoredAsset } from "@woohaa3/contracts";
import { hasUpstreamTextNode, upstreamTextIsEmpty } from "./prompt-derivation.js";

const NOW = "2026-09-24T00:00:00.000Z";

function textAsset(id: string, text: string): StoredAsset {
  return {
    id,
    title: id,
    mediaKind: "text",
    source: "generated",
    status: "ready",
    text,
    createdAt: NOW,
    metadata: {}
  };
}

function canvas(options: { textNode?: boolean; outputAssetId?: string; panelPrompt?: string; assets?: StoredAsset[] } = {}): ServerCanvas {
  const result = createEmptyWoohaa3ServerCanvas("c", NOW);
  result.document.nodes.push({ id: "image-1", type: "image", position: { x: 0, y: 0 } });
  if (options.textNode) {
    result.document.nodes.push({ id: "text-1", type: "text", position: { x: 200, y: 0 } });
    result.document.edges.push({ id: "e1", source: "text-1", target: "image-1", data: {} });
    result.nodeData["text-1"] = {
      ...(options.outputAssetId ? { outputAssetId: options.outputAssetId } : {}),
      ...(options.panelPrompt !== undefined ? { panelPrompt: options.panelPrompt } : {})
    };
  }
  result.assets.push(...(options.assets ?? []));
  return result;
}

describe("prompt-derivation", () => {
  it("hasUpstreamTextNode 只认连入的文字节点", () => {
    expect(hasUpstreamTextNode(canvas({ textNode: true }), "image-1")).toBe(true);
    expect(hasUpstreamTextNode(canvas({}), "image-1")).toBe(false);
    expect(hasUpstreamTextNode(null, "image-1")).toBe(false);
  });

  it("上游文字有 ready 文本资产时不为空", () => {
    const value = canvas({ textNode: true, outputAssetId: "asset-t", assets: [textAsset("asset-t", "一只猫")] });
    expect(upstreamTextIsEmpty(value, "image-1")).toBe(false);
  });

  it("上游文字无资产但有 panelPrompt 时不为空", () => {
    expect(upstreamTextIsEmpty(canvas({ textNode: true, panelPrompt: "提示" }), "image-1")).toBe(false);
  });

  it("上游文字存在但内容全空时为真", () => {
    const value = canvas({ textNode: true, outputAssetId: "asset-t", assets: [textAsset("asset-t", "   ")] });
    expect(upstreamTextIsEmpty(value, "image-1")).toBe(true);
  });

  it("没有上游文字节点时为假（空 prompt 交由服务端判定）", () => {
    expect(upstreamTextIsEmpty(canvas({}), "image-1")).toBe(false);
  });
});
