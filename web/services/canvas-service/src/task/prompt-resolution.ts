/**
 * 图片任务提示词的权威解析（change: integrate-origin-master-after-web-split）。
 *
 * 迁自远端 `web/apps/site/src/task/task-coordinator.ts` 的 `resolveSubmitPrompt` /
 * `upstreamTextContent`，但 owner 改为 Canvas Service（spec「Canvas Service
 * authoritatively resolves text prompts」）：最终 prompt 必须基于**当前 published Y.Doc**
 * 解析，不能信任 Frontend 提交的派生参考资产或过期节点快照。
 *
 * 规则（按优先级）：
 * 1. 用户输入 prompt 去空白后非空 → 用它；
 * 2. prompt 为空且连入文字节点有 ready 文本资产 → 按稳定连线顺序拼接；
 * 3. 上游文字节点没有生成文本资产但自身 prompt / panelPrompt 非空 → 用它；
 * 4. 存在上游文字节点但所有可用文字内容均为空 → `empty-upstream-text`（run 在 begin 前失败）。
 *
 * 关键：文字节点的内容**只**作为 prompt 来源，绝不加入图片 reference inputs。
 */
import type { CanvasNodeData, ServerCanvas, StoredAsset } from "@woohaa3/contracts";

/** 稳定错误码：上游文字节点没有内容。Frontend 据此显示中文提示（spec 用同一字面量）。 */
export const EMPTY_UPSTREAM_TEXT_CODE = "empty-upstream-text";
/** 用户可见提示文案（Frontend 与 Canvas Service 共用同一句）。 */
export const EMPTY_UPSTREAM_TEXT_MESSAGE = "上游文字节点没有内容";

export type PromptResolution =
  | { kind: "ok"; text: string }
  | { kind: "empty-upstream-text" };

/**
 * 解析图片节点的最终 prompt。
 *
 * `typed` 是用户输入框里的原始文本（可能为空）。只有图片节点（`image-generation`）才会
 * 触发上游文字回退；其它节点类型原样返回。
 */
export function resolveImagePrompt(options: {
  canvas: ServerCanvas;
  nodeId: string;
  panelKind: string;
  typed: string;
}): PromptResolution {
  const typed = options.typed.trim();
  if (typed !== "" || options.panelKind !== "image-generation") return { kind: "ok", text: typed };
  const upstream = upstreamTextContent(options.canvas, options.nodeId);
  if (!upstream.connected) return { kind: "ok", text: "" };
  if (upstream.text === "") return { kind: "empty-upstream-text" };
  return { kind: "ok", text: upstream.text };
}

/** 是否存在连入的上游文字节点（供 Frontend 派生按钮状态时参照同一判定）。 */
export function hasUpstreamTextNode(canvas: ServerCanvas, nodeId: string): boolean {
  return upstreamTextContent(canvas, nodeId).connected;
}

/**
 * 按**稳定连线顺序**收集上游文字节点内容。
 *
 * 顺序依据规范边的声明顺序（`canvas.document.edges`），保证同一画布多次解析结果一致。
 */
function upstreamTextContent(canvas: ServerCanvas, nodeId: string): { connected: boolean; text: string } {
  const nodeData = canvas.nodeData as Record<string, CanvasNodeData | undefined>;
  const sources = canvas.document.edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => canvas.document.nodes.find((node) => node.id === edge.source))
    .filter((node): node is NonNullable<typeof node> => node?.type === "text");
  if (sources.length === 0) return { connected: false, text: "" };
  const parts = sources
    .map((node) => textNodeContent(nodeData[node.id], canvas.assets))
    .filter((part) => part !== "");
  return { connected: true, text: parts.join("\n\n") };
}

/**
 * 单个文字节点的可用内容：优先用 ready 文本资产，其次回退到自身 prompt / panelPrompt。
 *
 * 只接受 `mediaKind === "text"` 且状态 ready 的资产的 `text`；空白内容视为无内容。
 */
function textNodeContent(data: CanvasNodeData | undefined, assets: readonly StoredAsset[]): string {
  const assetId = data?.outputAssetId;
  const asset = typeof assetId === "string" ? assets.find((entry) => entry.id === assetId) : undefined;
  const generated = asset?.mediaKind === "text" ? asset.text?.trim() ?? "" : "";
  if (generated !== "") return generated;
  const prompt = data?.prompt ?? data?.panelPrompt ?? "";
  return typeof prompt === "string" ? prompt.trim() : "";
}
