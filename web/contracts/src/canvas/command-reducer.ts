/**
 * 浏览器安全的纯画布命令 reducer（change: add-frontend-speculative-canvas-state，任务 1.1；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R12 —— 按命令族拆分为
 *  `command-reducer/` 子模块，本文件保留稳定入口与分派）。
 *
 * 从 Canvas Service 的 storage/core 下沉：`applyCanvasCommands`、拒绝码与工作副本规范化
 * 逻辑。前端 speculative projector 与服务端 command transaction 共用这一份语义，防止
 * 「本地预览接受但服务端领域 reducer 拒绝」的漂移（design D2）。
 *
 * 性质：
 * - 纯函数，不访问数据库、Yjs、MediaStorage、DOM 或 Node API；
 * - 整批原子：任一命令失败不返回部分结果；
 * - 不自行推进业务 revision（服务端 transaction 才是唯一 revision 写入方）。
 *
 * 唯一状态/原子边界不随拆分改变：所有命令作用于同一 `WorkingState`，`finalize` 一次性
 * 规范化写回；输入 mapping reconciliation 与 revision/no-op 判定保持同一原子批次。
 */
import { stableStringify } from "./canvas-script/planner/hash.js";
import type { CanvasCommand } from "./commands.js";
import type { ServerCanvas } from "./domain/index.js";
import { applyEditCommand } from "./command-reducer/edit-command.js";
import {
  addNode,
  patchNodeData,
  removeNodes,
  updateNode
} from "./command-reducer/node-commands.js";
import { addEdge, removeAsset, removeEdge, removeJob, upsertAsset, upsertJob } from "./command-reducer/edge-resource-commands.js";
import { finalize } from "./command-reducer/finalize.js";
import { observeContentResolver, type ContentContributionResolver } from "./content-contribution.js";
import { ManagedNodeLifecycleRegistry, planManagedNodeLifecycles, type ManagedNodeLifecycleResolver } from "./managed-node-lifecycle.js";
import { isCanvasCommandShape, toWorkingState } from "./command-reducer/working-state.js";
import { OK, reject, type ApplyCanvasCommandsResult, type CommandApplyResult, type WorkingState } from "./command-reducer/types.js";

export type {
  ApplyCanvasCommandsResult,
  CanvasCommandRejection,
  CanvasCommandRejectionCode
} from "./command-reducer/types.js";

/**
 * 应用整批命令。空批次视为成功且 `changed: false`。
 *
 * 不在此处解码批次结构：调用方应先经 `decodeCanvasCommandBatch`；这里对未解码的直接输入
 * 也兜底拒绝（`invalid-command`）。
 */
export function applyCanvasCommands(
  canvas: ServerCanvas,
  commands: readonly CanvasCommand[],
  options: { now?: string; lifecycle?: ManagedNodeLifecycleResolver; content?: ContentContributionResolver } = {}
): ApplyCanvasCommandsResult {
  observeContentResolver(options.content);
  const now = options.now ?? new Date().toISOString();
  const work = toWorkingState(canvas);
  work.content = options.content;
  const positionedNodeIds = explicitNodePositions(commands);

  for (const [index, command] of commands.entries()) {
    if (!isCanvasCommandShape(command)) {
      return reject("invalid-command", `第 ${index} 条命令结构非法`);
    }
    const result = applyCommand(work, command, canvas, options.content);
    if (!result.ok) return result;
  }

  // 可信扩展生命周期规划与通用校验：与源写入处于同一批次、
  // 同一 revision 与同一广播；重试不新增副本，失败不保留半张图。
  {
    try {
      const planned = planManagedNodeLifecycles({ before: canvas, canvas: { ...canvas, title: work.title, document: { ...canvas.document, nodes: work.nodes, edges: work.edges }, nodeData: work.nodeData, assets: work.assets, jobs: work.jobs }, positionedNodeIds: [...positionedNodeIds] }, options.lifecycle ?? new ManagedNodeLifecycleRegistry());
      work.nodes = planned.document.nodes.map(node => ({ ...node, data: {} })); work.edges = planned.document.edges; work.nodeData = planned.nodeData;
    } catch (error) { return reject("invalid-command", String(error)); }
  }

  return finalize(canvas, work, now);
}

/**
 * 预扫描本批次中显式携带最终落点的预览节点。
 *
 * D4 要求「显式落点的预览以请求中的最终绝对落点为准，不再叠加片场位移 `d`」。批次中显式写入
 * `position` 的既有预览即视为用户直接给出的落点；拖动提交会同时更新预览与片场，因此这里按
 * 「本批显式更新了 position 的预览节点」识别，避免与 owner 闭包重复位移。
 */
function explicitNodePositions(commands: readonly CanvasCommand[]): Set<string> {
  const positioned = new Set<string>();
  for (const command of commands) {
    if (command.type === "node.update" && command.position) positioned.add(command.nodeId);
    if (command.type === "edit.apply") {
      for (const operation of command.operations) {
        if (operation.kind === "node-update" && operation.position) positioned.add(operation.nodeId);
      }
    }
  }
  return positioned;
}

function snapshot(canvas: ServerCanvas, work: WorkingState): ServerCanvas {
  return {
    ...canvas,
    title: work.title,
    document: { ...canvas.document, nodes: work.nodes, edges: work.edges },
    nodeData: work.nodeData,
    assets: work.assets,
    jobs: work.jobs
  };
}

function applyExtensionCommand(
  work: WorkingState,
  command: Extract<CanvasCommand, { type: "extension.command" }>,
  canvas: ServerCanvas,
  content: ContentContributionResolver | undefined
): CommandApplyResult {
  const owner = content?.resolve(command.extensionId)?.commands;
  if (!owner || !owner.kinds.includes(command.kind)) return reject("content-owner-unavailable", command.extensionId);
  const envelope = { extensionId: command.extensionId, nodeId: command.nodeId, kind: command.kind, payload: command.payload };
  try {
    const decoded = owner.decode(structuredClone(envelope));
    if (!decoded.ok) return reject("content-command-rejected", decoded.code);
    const current = structuredClone(snapshot(canvas, work));
    const applied = owner.apply(decoded.value, current);
    if (!applied.ok) return reject("content-command-rejected", applied.code);
    if (!owner.satisfied(structuredClone(decoded.value), structuredClone(applied.canvas))) return reject("content-command-rejected", "content-command-unsatisfied");
    work.title = applied.canvas.title ?? "";
    work.nodes = applied.canvas.document.nodes.map((node) => ({ ...node, data: {} }));
    work.edges = applied.canvas.document.edges;
    work.nodeData = applied.canvas.nodeData;
    work.assets = applied.canvas.assets;
    work.jobs = applied.canvas.jobs;
    return OK;
  } catch {
    return reject("content-codec-failed", command.extensionId);
  }
}

function applyCommand(work: WorkingState, command: CanvasCommand, canvas: ServerCanvas, content: ContentContributionResolver | undefined): CommandApplyResult {
  switch (command.type) {
    case "edit.apply":
      return applyEditCommand(work, command);
    case "canvas.setTitle":
      work.title = command.title;
      return OK;
    case "node.add":
      return addNode(work, command);
    case "node.update":
      return updateNode(work, command);
    case "node.remove":
      return removeNodes(work, command.nodeIds);
    case "nodeData.patch":
      if (command.expectedNodeData && Object.entries(command.expectedNodeData).some(([id, data]) => !work.nodes.some(n => n.id === id) || stableStringify(work.nodeData[id] ?? null) !== stableStringify(data))) return reject("edit-precondition-failed", "媒体来源或目标已变化，请重新解析");
      if (command.expectedInputMapping !== undefined && JSON.stringify(work.nodeData[command.nodeId]?.inputMapping ?? []) !== JSON.stringify(command.expectedInputMapping)) {
        return reject("invalid-connection", "输入连接已变化，请重新执行");
      }
      return patchNodeData(work, command.nodeId, command.value);
    case "extension.command":
      return applyExtensionCommand(work, command, canvas, content);
    case "edge.add":
      return addEdge(work, command.edge);
    case "edge.remove":
      return removeEdge(work, command.edgeId);
    case "asset.upsert":
      return upsertAsset(work, command.asset);
    case "asset.remove":
      return removeAsset(work, command.assetId);
    case "job.upsert":
      return upsertJob(work, command.job);
    case "job.remove":
      return removeJob(work, command.jobId);
  }
}
