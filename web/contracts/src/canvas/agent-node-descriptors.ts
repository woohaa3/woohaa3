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
import { canonicalFilmSetFields } from "./film-set-clip-view.js";
import { createFilmSetSnapshot, createModel3DNodeData, model3DNodeDataFields } from "./animation-snapshot.js";
import { MODEL_SCRIPT_V2_VERSION } from "./model-script.js";
import { isModelAuthoringNodeType } from "./domain/core/input-role.js";
import { COMPOSITE_ASSET_NODE_TYPE, FILM_SET_EXTENSION_ID } from "./domain/core/composite-asset-identity.js";

/**
 * 片场（复合资产 + `extensionId="film-set"`）展示名事实源
 * （change: 2026-10-11-extract-film-set-extension，D1/D6/D11）。
 *
 * 重新导出无依赖模块中的常量，避免 `normalization` 侧的模块初始化循环；新建默认标题、
 * UI 分类标签、MCP 可读描述与旧默认标题幂等迁移共用同一值。
 */
export { DIRECTOR_STUDIO_DEFAULT_TITLE, LEGACY_ANIMATION_DEFAULT_TITLE } from "./director-studio-title.js";
import { DIRECTOR_STUDIO_DEFAULT_TITLE } from "./director-studio-title.js";

/** 对外暴露的语义节点种类。`model` 创建自包含的 canonical `model3d`。 */
export type AgentSemanticKind = "text" | "image" | "video" | "audio" | "model";

export const AGENT_SEMANTIC_KINDS: readonly AgentSemanticKind[] = [
  "text",
  "image",
  "model",
  "video",
  "audio"
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
 * 节点目录；顺序与前端菜单/旧 Godot 菜单一致（文本、图片、模型、视频、音频）。
 *
 * 尺寸来自 `effectiveCanvasNodeSize`，与 Bevy 渲染共用同一数值，避免菜单预览与画布实际尺寸分叉。
 */
export const AGENT_NODE_DESCRIPTORS: readonly AgentNodeDescriptor[] = [
  descriptor("text", "text", "文本", { task: true, prompt: true, executable: true, sourceLabel: "文本" }),
  descriptor("image", "image", "图片", { task: true, prompt: true, executable: true, sourceLabel: "图片" }),
  descriptor("model", "model3d", "模型", { prompt: true, executable: false, sourceLabel: "模型" }),
  descriptor("video", "video", "视频", { task: true, prompt: true, executable: true, sourceLabel: "" }),
  descriptor("audio", "audio", "音频", { task: true, prompt: true, executable: true, sourceLabel: "" })
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

export function agentDescriptorForCanonicalType(canonicalType: string): AgentNodeDescriptor | null {
  // 自包含 3D 节点（model3d + 复合资产类别）共享同一 `model` 语义种类。
  if (isModelAuthoringNodeType(canonicalType)) return findAgentNodeDescriptor("model");
  return AGENT_NODE_DESCRIPTORS.find((entry) => entry.canonicalType === canonicalType) ?? null;
}

/**
 * 语义种类的默认 nodeData。
 *
 * 任务节点（text/image/video/audio）带 `taskKind` 与 `taskStatus: "idle"`；`model`
 * （canonical model3d）携带合法占位模型，不预填任务字段。
 */
export function defaultAgentNodeData(kind: string): CanvasNodeData | undefined {
  const descriptor = findAgentNodeDescriptor(kind);
  if (descriptor?.canonicalType === "model3d") return defaultSelfContained3DNodeData("model3d");
  if (!descriptor?.taskKind || !descriptor.defaultTaskStatus) return undefined;
  return { taskKind: descriptor.taskKind, taskStatus: descriptor.defaultTaskStatus };
}

/** 浏览器与 MCP 新建 3D 节点共用完整、合法的本地定义。 */
export const DEFAULT_3D_PLACEHOLDER_SCRIPT = `scene.group({ id: "root" });
scene.box({ id: "body", parent: "root", size: [1, 1, 1] });`;

export function defaultSelfContained3DNodeData(nodeType: string): CanvasNodeData | undefined {
  const model = { modelScript: DEFAULT_3D_PLACEHOLDER_SCRIPT, modelScriptVersion: MODEL_SCRIPT_V2_VERSION };
  if (nodeType === "model3d") {
    return model3DNodeDataFields(createModel3DNodeData({ title: "3D 模型", model })) as CanvasNodeData;
  }
  // 复合资产类别默认落到片场业务（extensionId="film-set"）；炉体有自己的工厂，不经此路径。
  // D8：新建片场默认只有一块可编辑地面，不再有「无法删除的默认中央正方体」。
  if (nodeType === COMPOSITE_ASSET_NODE_TYPE) {
    return { extensionId: FILM_SET_EXTENSION_ID, ...canonicalFilmSetFields(createFilmSetSnapshot({
      title: DIRECTOR_STUDIO_DEFAULT_TITLE, timeline: { duration: 0, loop: false }
    })) } as CanvasNodeData;
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
