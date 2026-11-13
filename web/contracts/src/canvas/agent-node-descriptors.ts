/**
 * Agent 可创建节点描述符（change: add-agent-canvas-authoring-mcp，任务 1.2 / design D1）。
 *
 * 这是**唯一**一份「语义节点种类 ↔ canonical 节点类型 ↔ 默认尺寸 ↔ 默认任务字段 ↔
 * 连线标签/输入角色」映射。Frontend 节点目录与 MCP Agent planner 共同消费它，因此浏览器
 * 与外部 Agent 创建同类节点得到相同的默认语义。
 *
 * 纯描述符：不写 store、不提交命令、不依赖浏览器或 Node API。Canvas reducer 仍是最终领域
 * 校验者。
 */
import { effectiveCanvasNodeSize } from "./node-dimensions.js";
import { NODE_TYPE_TO_TASK_KIND, type CanvasTaskKind } from "../task/dto.js";
import type { CanvasNodeData } from "./domain/types.js";
import type { CanvasNodeTaskStatus } from "../task/dto.js";
import { createModel3DNodeData, model3DNodeDataFields } from "./animation-snapshot.js";
import { MODEL_SCRIPT_V2_VERSION } from "./model-script.js";
import { isModelAuthoringNodeType } from "./domain/core/input-role.js";
import { COMPOSITE_ASSET_NODE_TYPE } from "./domain/core/composite-asset-identity.js";
import { newWorldInstance } from "./creation-scopes-ui.js";

/** 对外暴露的语义节点种类。`model` 是自包含的 3D 内容节点。 */
export type AgentSemanticKind = "text" | "image" | "video" | "audio" | "motion" | "model";

export const AGENT_SEMANTIC_KINDS: readonly AgentSemanticKind[] = [
  "text",
  "image",
  "model",
  "video",
  "audio",
  "motion"
];

export type AgentNodeDescriptor = {
  /** 语义种类（stable，公共契约使用）。 */
  kind: AgentSemanticKind;
  /** 写入画布文档的 canonical 节点类型。 */
  canonicalType: string;
  /** 人类可读标签（与前端菜单一致）。 */
  label: string;
  /** 创建时的规范尺寸（与 Bevy 节点尺寸同源）。 */
  defaultSize: { width: number; height: number };
  /** 任务语义；`model` 节点没有。 */
  taskKind?: CanvasTaskKind;
  /** 任务节点创建时的默认任务状态。 */
  defaultTaskStatus?: CanvasNodeTaskStatus;
  /** 是否支持 prompt 写入。 */
  supportsPrompt: boolean;
  /** 是否可经 run 工具执行。 */
  executable: boolean;
  /** 作为连线来源时承载的内容标签（与旧 `_wire_label` 等价）。 */
  sourceLabel?: string;
};

/**
 * 节点目录；顺序与前端菜单/旧 Godot 菜单一致，并补充复合资产这一自包含 3D 节点。
 *
 * 尺寸来自 `effectiveCanvasNodeSize`，与 Bevy 渲染共用同一数值，避免菜单预览与画布实际尺寸分叉。
 */
export const AGENT_NODE_DESCRIPTORS: readonly AgentNodeDescriptor[] = [
  descriptor("text", "text", "文本", { task: true, prompt: true, executable: true, sourceLabel: "文本" }),
  descriptor("image", "image", "图片", { task: true, prompt: true, executable: true, sourceLabel: "图片" }),
  descriptor("model", "model3d", "模型", { prompt: true, executable: false, sourceLabel: "模型" }),
  descriptor("video", "video", "视频", { task: true, prompt: true, executable: true, sourceLabel: "" }),
  descriptor("audio", "audio", "音频", { task: true, prompt: true, executable: true, sourceLabel: "" }),
  descriptor("motion", "motion", "动作", { task: true, prompt: true, executable: true, sourceLabel: "动作" })
];

function descriptor(
  kind: AgentSemanticKind,
  canonicalType: string,
  label: string,
  options: { task?: boolean; prompt?: boolean; executable?: boolean; sourceLabel?: string }
): AgentNodeDescriptor {
  const taskKind = options.task
    ? (NODE_TYPE_TO_TASK_KIND as Record<string, CanvasTaskKind | undefined>)[canonicalType]
    : undefined;
  return {
    kind,
    canonicalType,
    label,
    defaultSize: effectiveCanvasNodeSize({ type: canonicalType }),
    ...(taskKind ? { taskKind, defaultTaskStatus: "idle" as const } : {}),
    supportsPrompt: options.prompt === true,
    executable: options.executable === true,
    ...(options.sourceLabel ? { sourceLabel: options.sourceLabel } : {})
  };
}

export function isAgentSemanticKind(value: unknown): value is AgentSemanticKind {
  return typeof value === "string" && (AGENT_SEMANTIC_KINDS as readonly string[]).includes(value);
}

export function findAgentNodeDescriptor(kind: string): AgentNodeDescriptor | null {
  return AGENT_NODE_DESCRIPTORS.find((entry) => entry.kind === kind) ?? null;
}

export function agentDescriptorForCanonicalType(canonicalType: string, nodeData?: unknown): AgentNodeDescriptor | null {
  void nodeData;
  // composite-asset 承载扩展内容；语义上仍按模型兼容面投影。
  if (canonicalType === COMPOSITE_ASSET_NODE_TYPE) return findAgentNodeDescriptor("model");
  if (isModelAuthoringNodeType(canonicalType)) return findAgentNodeDescriptor("model");
  return AGENT_NODE_DESCRIPTORS.find((entry) => entry.canonicalType === canonicalType) ?? null;
}

/**
 * `model3d` 的世界实例输入：画布点被投影到 h=0 地面，实例身份由调用方预先决定。
 *
 * 模型没有卡片位置；`sharedWorldInstance` 是受支持模型的唯一位置来源
 * （change: 2026-11-10-remove-legacy-model-card-nodes）。
 */
export type AgentModelWorld = { instanceId: string; point: { x: number; y: number } };

/**
 * 语义种类的默认 nodeData。
 *
 * 任务节点（text/image/video/audio）带 `taskKind` 与 `taskStatus: "idle"`；`model`
 * （canonical model3d）携带合法空模型定义与共享世界实例，不预填任务字段。
 */
export function defaultAgentNodeData(kind: string, world?: AgentModelWorld): CanvasNodeData | undefined {
  const descriptor = findAgentNodeDescriptor(kind);
  if (descriptor?.canonicalType === "model3d") return defaultSelfContained3DNodeData(descriptor.canonicalType, world);
  if (descriptor?.canonicalType === COMPOSITE_ASSET_NODE_TYPE) return defaultSelfContained3DNodeData(descriptor.canonicalType);
  if (!descriptor?.taskKind || !descriptor.defaultTaskStatus) return undefined;
  return { taskKind: descriptor.taskKind, taskStatus: descriptor.defaultTaskStatus };
}

/**
 * 浏览器与 MCP 新建 3D 节点共用完整、合法的本地定义。
 *
 * `model3d` 必须给出世界实例（缺少实例的定义只属于旧卡片，不能再被创建）；
 * 复合资产仍使用自身的内容矩形。
 */
export function defaultSelfContained3DNodeData(nodeType: string, world?: AgentModelWorld): CanvasNodeData | undefined {
  const model = { modelScript: "", modelScriptVersion: MODEL_SCRIPT_V2_VERSION };
  if (nodeType === "model3d") {
    if (!world) throw new Error("model3d 需要 sharedWorldInstance：模型不再有卡片，必须提供世界实例输入");
    const fields = model3DNodeDataFields(createModel3DNodeData({ title: "3D 模型", model })) as CanvasNodeData;
    return { ...fields, sharedWorldInstance: newWorldInstance(world.instanceId, world.point) } as CanvasNodeData;
  }
  return undefined;
}

/** 把语义 kind 或 canonical type 归一为 canonical type。 */
export function canonicalTypeFor(value: string): string {
  return findAgentNodeDescriptor(value)?.canonicalType ?? value;
}

/**
 * 拉线创建的边标签（与旧 `_wire_label` 严格等价）：标签描述来源节点承载的内容。
 *
 * 这是唯一一份实现；Frontend 的 `connectLabelFor` 委托给它。规则刻意保留来源+目标
 * 依赖：只有「文本→图片/模型」标为「文本」，文本→视频/音频不带标签。
 */
export function agentConnectLabel(sourceType: string, targetType: string): string {
  const source = canonicalTypeFor(sourceType);
  const target = canonicalTypeFor(targetType);
  if (source === "text" && (target === "image" || isModelAuthoringNodeType(target))) return "文本";
  if (source === "image") return "图片";
  if (isModelAuthoringNodeType(source)) return "模型";
  return "";
}
