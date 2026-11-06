/**
 * 画布节点目录（change: 补齐右键菜单与拉线创建；
 * change: add-agent-canvas-authoring-mcp 下沉共享描述符）。
 *
 * 映射「菜单标签 ↔ 规范节点类型 ↔ 默认 nodeData ↔ 连线标签」的唯一事实源已下沉到
 * `@woohaa3/contracts` 的 `agent-node-descriptors`，使 Frontend 与 MCP Agent planner
 * 创建同类节点得到相同默认语义（design D1）。本模块只做 Frontend 视图适配，不改 UI 行为。
 *
 * 空白右键「插入节点」与输出端口拉线到空白处**共用同一份目录与同一个菜单组件**，不做两套，
 * 菜单项也完全一致；拉线时唯一的差别是选择后会在同一次 `node.add` 里连一条边。
 *
 * 只描述「新建一个节点」：真正的创建走 `planInsertNode` + 服务端 `node.add`，
 * 这里不做任何 store 写入或命令提交。
 */
import {
  AGENT_NODE_DESCRIPTORS,
  agentConnectLabel,
  defaultAgentNodeData,
  findAgentNodeDescriptor,
  inferWoohaa3CanvasInputRole,
  defaultSelfContained3DNodeData,
  type AgentSemanticKind,
  type CanvasNodeData,
  type CanvasReferencePolicy
} from "@woohaa3/contracts";
export { defaultSelfContained3DNodeData } from "@woohaa3/contracts";

/**
 * 前端菜单项 id：共享语义 kind、扩展注册的自包含 3D 节点，以及身份敏感生成预设。
 *
 * `character-series` / `product-series` 不是新的 canonical 节点类型：它们创建普通 image
 * 节点，只把 `referencePolicy` 预设为 `identity-required`（change:
 * 2026-11-06-require-identity-reference）。配置来源在这里，不在执行面板里硬编码。
 */
export type CanvasNodeTemplateId =
  | AgentSemanticKind
  | "model3d"
  | "composite-asset"
  | "character-series"
  | "product-series";

export type CanvasNodeTemplate = {
  id: CanvasNodeTemplateId;
  /** 菜单文案（与旧 Godot 菜单一致）。 */
  label: string;
  /** 规范节点类型。 */
  nodeType: string;
  /** 是否带任务语义（text/image/video/audio 会写 taskKind）。 */
  taskKind: boolean;
  /** 新建节点时写入 `nodeData.referencePolicy`；缺省沿用模型声明或 optional。 */
  referencePolicy?: CanvasReferencePolicy;
};

/**
 * 节点菜单目录；空白右键与拉线创建共用，顺序与旧 Godot 菜单一致。
 *
 * 目录只包含普通应用节点；扩展节点经 `canvas.node-template` 贡献。
 */
export const NODE_TEMPLATES: readonly CanvasNodeTemplate[] = [
  ...AGENT_NODE_DESCRIPTORS
    .map((descriptor) => ({
      id: (descriptor.kind === "model" ? "model3d" : descriptor.kind) as CanvasNodeTemplateId,
      label: descriptor.kind === "model" ? "3D 模型" : descriptor.label,
      nodeType: descriptor.canonicalType,
      taskKind: descriptor.taskKind !== undefined
    })),
  // 人物/角色与商品系列需要保持同一主体：默认强制 ready 参考，仍可在面板切回可选。
  {
    id: "character-series",
    label: "角色系列",
    nodeType: "image",
    taskKind: true,
    referencePolicy: "identity-required"
  },
  {
    id: "product-series",
    label: "商品系列",
    nodeType: "image",
    taskKind: true,
    referencePolicy: "identity-required"
  }
];

/** model 语义别名与 model3d 菜单项返回同一份模板。 */
export function findNodeTemplate(id: string): CanvasNodeTemplate | null {
  // 优先稳定菜单 id；扩展占位模板共用 composite-asset canonical type，不能让 canonical
  // 查询意外吞掉显式的 composite-asset 模板。
  const fixed = NODE_TEMPLATES.find((template) => template.id === id)
    ?? NODE_TEMPLATES.find((template) => template.nodeType === id);
  if (fixed) return fixed;
  const descriptor = findAgentNodeDescriptor(id);
  if (!descriptor) return null;
  return NODE_TEMPLATES.find((template) => template.nodeType === descriptor.canonicalType) ?? null;
}

/**
 * 拉线创建的边标签（与旧 Godot `_wire_label` 等价）：标签描述来源节点承载的内容。
 * 规则唯一实现在 contracts `agentConnectLabel`。
 */
export function connectLabelFor(sourceNodeType: string, targetNodeType: string): string {
  return agentConnectLabel(sourceNodeType, targetNodeType);
}

/**
 * 新建节点的默认 nodeData（与 MCP planner 共用共享描述符）。
 *
 * text/image/video/audio 是任务节点：带 `taskKind` 与 `taskStatus: "idle"`，执行面板据此
 * 出现（与旧 Godot `_generation_node_data` 等价）。3D 节点携带共享的本地模型定义，
 * 不预填任何任务字段。
 */
export function defaultNodeDataForType(nodeTypeOrTemplate: string): CanvasNodeData | undefined {
  const template = NODE_TEMPLATES.find((entry) => entry.id === nodeTypeOrTemplate);
  const nodeType = template?.nodeType ?? nodeTypeOrTemplate;
  const selfContained = defaultSelfContained3DNodeData(nodeType);
  if (selfContained) return selfContained;
  const descriptor = findAgentNodeDescriptor(nodeType);
  if (!descriptor) return undefined;
  const data = defaultAgentNodeData(descriptor.kind);
  if (data && template?.referencePolicy) data.referencePolicy = template.referencePolicy;
  return data;
}

/** 连线（拉线创建）时新节点的 nodeData：任务字段 + 指向源节点的输入映射。 */
export function connectNodeDataFor(
  from: { id: string; type: string },
  toNodeType: string,
  existingRoles: readonly string[] = [],
  nodeData?: Record<string, CanvasNodeData>
): CanvasNodeData | undefined {
  const base = defaultNodeDataForType(toNodeType);
  if (!base) return undefined;
  const canonicalType = findNodeTemplate(toNodeType)?.nodeType ?? toNodeType;
  // 自包含 3D 节点不从来源节点取得运行数据：连线只作来源说明，不注入任务 inputMapping
  // （change: 2026-10-05-bind-model-animation-to-shots）；复合资产节点同理。
  if (canonicalType === "model3d" || canonicalType === "composite-asset") return { ...base };
  const data: CanvasNodeData = { ...base };
  data.inputMapping = [
    {
      sourceNodeId: from.id,
      role: inferWoohaa3CanvasInputRole({
        sourceNode: { id: from.id, type: from.type },
        targetNode: { id: "pending", type: canonicalType },
        existingRoles
        , sourceData: nodeData?.[from.id], readNodeData: id => nodeData?.[id]
      }),
      sortKey: "0"
    }
  ];
  return data;
}
