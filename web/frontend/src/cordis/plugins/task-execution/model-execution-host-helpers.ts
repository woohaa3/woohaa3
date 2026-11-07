/**
 * Model Execution Host 的 DOM/命令辅助
 * （change: 2026-09-29-add-pluggable-model-interactions，任务 4.1）。
 */
import type { CanvasSession } from "../../contracts.js";
import {
  SELF_REFERENCE_ASSET_FIELD,
  type CanvasReferencePolicy,
  type CanvasTaskCatalogModel,
  type CanvasTaskModelType,
  type ServerCanvas
} from "@woohaa3/contracts";
import { planConnectEdge, planDeleteEdge, planNodeDataPatch } from "../../../extension-api/command-planner.js";
import type { ModelReferenceItem } from "../../contract/model-interaction.js";

/** 参考必须已就绪，避免把类型未知或上游缺失的槽位写进提示词。 */
export function canMentionReference(
  item: Pick<ModelReferenceItem, "slotId" | "role" | "status">
): boolean {
  return item.slotId !== "" && item.status === "ready";
}

/** 连接一个来源节点作为目标节点的参考输入（受控 Canvas 命令）。 */
export function addReference(session: CanvasSession, target: string, source: string): boolean {
  if (!session.isWritable()) return false;
  return session.submitCommands(
    planConnectEdge({ source, target }),
    `web-ref-add-${Date.now().toString(36)}`
  ).ok;
}

/**
 * 切换节点级身份参考策略（受控 Canvas 命令）。
 *
 * `nodeData.patch` 合并现有字段，不重写 prompt/参数/输入映射。
 */
export function setReferencePolicy(
  session: CanvasSession,
  nodeId: string,
  referencePolicy: CanvasReferencePolicy
): boolean {
  if (!session.isWritable()) return false;
  return session.submitCommands(
    [{ type: "nodeData.patch", nodeId, value: { referencePolicy } }],
    `web-ref-policy-${Date.now().toString(36)}`
  ).ok;
}

/** 删除目标节点与来源节点之间的参考连线（受控 Canvas 命令）。 */
export function removeReference(
  session: CanvasSession,
  canvas: ServerCanvas | null,
  target: string,
  source: string
): void {
  if (!session.isWritable() || !canvas) return;
  // 节点自带主图没有入边：移除就是清掉记录的资产 id（合并语义，空串即没有）。
  if (source === target) {
    session.submitCommands(
      planNodeDataPatch({ nodeId: target, value: { [SELF_REFERENCE_ASSET_FIELD]: "" } }),
      `web-ref-remove-${Date.now().toString(36)}`
    );
    return;
  }
  const edge = canvas.document.edges.find(
    (candidate) => candidate.target === target && candidate.source === source
  );
  if (!edge) return;
  session.submitCommands(planDeleteEdge(edge.id), `web-ref-remove-${Date.now().toString(36)}`);
}

export function mentionTypeFor(
  item: ModelReferenceItem
): "input_text" | "input_image" | "input_video" | "input_audio" {
  if (item.mediaKind === "text") return "input_text";
  if (item.mediaKind === "video") return "input_video";
  if (item.mediaKind === "audio") return "input_audio";
  return "input_image";
}

/** catalog 模型不可用时的占位（仅用于诊断展示，不带任何可执行身份）。 */
export function placeholderModel(modelKey: string, modelType: CanvasTaskModelType): CanvasTaskCatalogModel {
  return {
    modelKey,
    providerId: "",
    providerModelId: modelKey,
    modelType,
    title: modelKey,
    interaction: { id: "generic-model", version: 1 },
    inputSchema: {},
    defaultInput: {},
    bindings: [],
    taskTimeoutMs: 0
  };
}

/** 当前 DOM 中 panel-local 浮层是否打开（Escape 判定）。 */
export function readPanelLocalSurface(): { picker: boolean; overlay: boolean } {
  if (typeof document === "undefined") return { picker: false, overlay: false };
  return {
    picker: document.querySelector('[data-testid="reference-picker"]') !== null,
    overlay: document.querySelector(
      ".mc-panel__model-menu, .mc-panel__settings-menu, .mc-panel__polish-menu, .mc-panel__error-panel, .assistant-model-panel"
    ) !== null
  };
}
