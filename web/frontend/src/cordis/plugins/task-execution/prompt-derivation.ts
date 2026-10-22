/**
 * 面板提交前的派生辅助（change: integrate-origin-master-after-web-split）。
 *
 * **仅**用于按钮状态、弹窗与草稿恢复：真正的 prompt 解析由 Canvas Service 基于权威
 * published Y.Doc 完成（spec「Canvas Service authoritatively resolves text prompts」）。
 * 这里绝不写权威状态。
 */
import type { CanvasNodeData, ServerCanvas } from "@woohaa3/contracts";

/** 与 Canvas Service 保持同一句稳定提示。 */
export const EMPTY_UPSTREAM_TEXT_MESSAGE = "上游文字节点没有内容";

/** 是否存在连入的上游文字节点（图片节点允许空 prompt 提交的判据）。 */
export function hasUpstreamTextNode(canvas: ServerCanvas | null | undefined, nodeId: string): boolean {
  if (!canvas) return false;
  return canvas.document.edges.some((edge) => {
    if (edge.target !== nodeId) return false;
    const source = canvas.document.nodes.find((node) => node.id === edge.source);
    return source?.type === "text";
  });
}

/**
 * 判断上游文字节点是否**肯定没有**可用内容。
 *
 * 仅当上游文字节点存在、且它既没有 ready 文本资产、自身 prompt/panelPrompt 也为空时返回
 * true。用于在提交前给出即时弹窗；权威判定仍在 Canvas Service。
 */
export function upstreamTextIsEmpty(canvas: ServerCanvas | null | undefined, nodeId: string): boolean {
  if (!canvas) return false;
  const nodeData = canvas.nodeData as Record<string, CanvasNodeData | undefined>;
  const textNodes = canvas.document.edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => canvas.document.nodes.find((node) => node.id === edge.source))
    .filter((node): node is NonNullable<typeof node> => node?.type === "text");
  if (textNodes.length === 0) return false;
  return textNodes.every((node) => {
    const data = nodeData[node.id];
    const assetId = data?.outputAssetId;
    const asset = typeof assetId === "string" ? canvas.assets.find((entry) => entry.id === assetId) : undefined;
    const generated = asset?.mediaKind === "text" ? asset.text?.trim() ?? "" : "";
    if (generated !== "") return false;
    const prompt = data?.prompt ?? data?.panelPrompt ?? "";
    return typeof prompt === "string" ? prompt.trim() === "" : true;
  });
}
