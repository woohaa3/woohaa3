/**
 * 单图替换资格判定
 * （change: add-paste-import-workflows，任务 5.1 / design D5）。
 *
 * 只有「恰好一张支持的图片文件 + selection 恰好一个 canonical、非 processing、可写的
 * 兼容 image 节点」才显示替换确认。纯函数，便于覆盖所有分支。
 */
import type { CanvasNodeData, ServerCanvas } from "@woohaa3/contracts";
import type { ClassifiedFile } from "./datatransfer.js";

export type ReplaceEligibilityInput = {
  files: readonly ClassifiedFile[];
  selectedNodeIds: readonly string[];
  canvas: ServerCanvas | null;
  writable: boolean;
};

export type ReplaceEligibility =
  | { eligible: true; nodeId: string }
  | { eligible: false; reason: string };

const PROCESSING_STATUSES = new Set(["pending", "processing"]);

export function evaluateReplaceEligibility(input: ReplaceEligibilityInput): ReplaceEligibility {
  if (!input.writable) return { eligible: false, reason: "画布只读" };
  if (input.files.length !== 1) return { eligible: false, reason: "仅单张图片可替换" };
  const file = input.files[0]!;
  if (file.kind !== "image") return { eligible: false, reason: "仅图片可替换" };
  const selected = [...new Set(input.selectedNodeIds)];
  if (selected.length !== 1) return { eligible: false, reason: "需要恰好选中一个节点" };
  const nodeId = selected[0]!;
  const canvas = input.canvas;
  if (!canvas) return { eligible: false, reason: "画布尚未加载" };
  const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
  if (!node) return { eligible: false, reason: "节点不存在" };
  if (node.type !== "image") return { eligible: false, reason: "目标节点不是图片节点" };
  const data = canvas.nodeData[nodeId] as CanvasNodeData | undefined;
  const status = data?.taskStatus;
  if (typeof status === "string" && PROCESSING_STATUSES.has(status)) {
    return { eligible: false, reason: "节点正在执行任务" };
  }
  // 未确认删除/替换：nodeData 中没有仍有效的运行态（activeRunId）时才是稳定的 canonical 节点。
  if (typeof data?.activeRunId === "string" && data.activeRunId !== "") {
    return { eligible: false, reason: "节点有未确认的运行态" };
  }
  return { eligible: true, nodeId };
}
