/**
 * 聚焦节点的 3D 业务类别
 * （change: 2026-10-18-simplify-model-focus-panel）。
 *
 * 普通 `model3d` 聚焦只保留 AI 修改与模型规模信息；片场（`composite-asset` +
 * `extensionId="film-set"`）仍由扩展检查器拥有对象/镜头/动画页。两类节点共用同一
 * `canvas.focus-workspace`（kind=model），因此工作区必须按**严格业务身份**区分，不能靠
 * 尺寸、标题或内容推断。
 */
import { useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { isFilmSetNode } from "@woohaa3/contracts";

export type ModelFocusKind = "model3d" | "film-set" | null;

/** 读取聚焦节点类别；非 3D 或节点已失效返回 null。 */
export function focusedModelKind(ctx: Context, nodeId: string | null): ModelFocusKind {
  if (!nodeId) return null;
  const canvas = ctx.compositeAssets.projectCanvas(ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas());
  const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
  if (node?.type === "model3d") return "model3d";
  if (isFilmSetNode(node?.type, canvas?.nodeData?.[nodeId])) return "film-set";
  return null;
}

/** 订阅画布变化后派生当前聚焦节点类别（供工作区决定是否呈现镜头工具）。 */
export function useFocusedModelKind(ctx: Context, nodeId: string | null): ModelFocusKind {
  useSyncExternalStore(ctx.canvasState.subscribe, ctx.canvasState.getWorkingCanvas, ctx.canvasState.getWorkingCanvas);
  return focusedModelKind(ctx, nodeId);
}
