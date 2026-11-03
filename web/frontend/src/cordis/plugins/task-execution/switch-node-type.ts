/**
 * 生成面板「图片 / 视频」切换的决策与命令构造（纯函数）。
 *
 * 切换随时可用，做什么取决于当前节点：
 * - 空节点（还没有结果）→ 原地改类型（`retype`，权威命令 `node.update { nodeType }`）；
 * - 已经有图/视频的节点 → 在它旁边**新建**另一种类型的节点，连成它的参考输入（`create`），原节点不动；
 * - 画布只读，或空节点正在生成 → 不可切换（`blocked`，带原因）。
 */
import { createWoohaa3CanvasNodeId, getWoohaa3CanvasNodeRect, type CanvasCommand, type CanvasNodeData } from "@woohaa3/contracts";
import { planInsertNode } from "../../../extension-api/command-planner.js";
import { connectLabelFor, connectNodeDataFor } from "../../domain/node-catalog.js";

export type SwitchableNodeType = "image" | "video";

export type NodeTypeSwitchPlan =
  | { kind: "retype" }
  | { kind: "create" }
  | { kind: "blocked"; reason: string };

/** 在途的任务状态：空节点此时改类型会让回流结果写进错误类型的节点。 */
const IN_FLIGHT = new Set(["pending", "queued", "processing", "running"]);

/** 节点是否已经有结果（输出资产或内容）。 */
export function nodeHasResult(nodeData: CanvasNodeData | undefined): boolean {
  const data = (nodeData ?? {}) as Record<string, unknown>;
  if (typeof data.outputAssetId === "string" && data.outputAssetId !== "") return true;
  return data.mediaContent !== undefined && data.mediaContent !== null;
}

export function planNodeTypeSwitch(nodeData: CanvasNodeData | undefined, writable: boolean): NodeTypeSwitchPlan {
  if (!writable) return { kind: "blocked", reason: "当前会话不可写（画布只读）" };
  if (nodeHasResult(nodeData)) return { kind: "create" };
  const status = (nodeData as Record<string, unknown> | undefined)?.taskStatus;
  if (typeof status === "string" && IN_FLIGHT.has(status)) return { kind: "blocked", reason: "正在生成，暂时不能切换类型" };
  return { kind: "retype" };
}

/** 新节点放在源节点右侧的间距（与连线标签留出位置）。 */
const LINKED_NODE_GAP = 120;

type NodeLike = { id: string; type: string; position: { x: number; y: number }; [key: string]: unknown };

/**
 * 在源节点右侧新建 `nextType` 节点并连线：源节点当前的图/视频作为它的参考输入。
 * 找不到源节点或该类型没有默认数据时返回 `null`。
 */
export function buildLinkedNodeCommands(input: {
  sourceNodeId: string;
  nextType: SwitchableNodeType;
  nodes: readonly NodeLike[];
  nodeData: Record<string, CanvasNodeData | undefined> | undefined;
}): { nodeId: string; commands: CanvasCommand[] } | null {
  const source = input.nodes.find((entry) => entry.id === input.sourceNodeId);
  if (!source) return null;
  const nodeData = connectNodeDataFor(
    { id: source.id, type: source.type },
    input.nextType,
    [],
    input.nodeData as Record<string, CanvasNodeData> | undefined
  );
  if (!nodeData) return null;
  const rect = getWoohaa3CanvasNodeRect(source as never, new Map(input.nodes.map((entry) => [entry.id, entry])) as never);
  const nodeId = createWoohaa3CanvasNodeId(input.nextType);
  const label = connectLabelFor(source.type, input.nextType);
  return {
    nodeId,
    commands: planInsertNode({
      nodeId,
      nodeType: input.nextType,
      position: { x: rect.x + rect.width + LINKED_NODE_GAP, y: rect.y },
      nodeData,
      connectFromNodeId: source.id,
      ...(label ? { connectLabel: label } : {})
    })
  };
}
