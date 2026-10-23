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
import type { CanvasCommand } from "./commands.js";
import type { ServerCanvas } from "./domain/index.js";
import { applyEditCommand } from "./command-reducer/edit-command.js";
import { patchFilmSetClip } from "./command-reducer/film-set-clip-commands.js";
import { patchFilmSetItem } from "./command-reducer/film-set-item-commands.js";
import {
  addNode,
  patchNodeData,
  removeNodes,
  updateNode
} from "./command-reducer/node-commands.js";
import { addEdge, removeAsset, removeEdge, removeJob, upsertAsset, upsertJob } from "./command-reducer/edge-resource-commands.js";
import { finalize } from "./command-reducer/finalize.js";
import {
  reconcileShotPreviews,
  type ShotPreviewBatchContext
} from "./command-reducer/film-set-shot-previews.js";
import { isShotPreviewNodeType } from "./domain/core/shot-preview-node.js";
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
  options: { now?: string } = {}
): ApplyCanvasCommandsResult {
  const now = options.now ?? new Date().toISOString();
  const work = toWorkingState(canvas);
  const shotPreviewContext: ShotPreviewBatchContext = {
    beforeNodes: canvas.document.nodes.map((node) => ({ ...node, position: { ...node.position }, data: {} })),
    explicitPreviewIds: explicitShotPreviewPositions(commands, canvas)
  };

  for (const [index, command] of commands.entries()) {
    if (!isCanvasCommandShape(command)) {
      return reject("invalid-command", `第 ${index} 条命令结构非法`);
    }
    const result = applyCommand(work, command);
    if (!result.ok) return result;
  }

  // 源镜头生命周期 reconciliation 与最终不变式（change D3）：与源写入处于同一批次、
  // 同一 revision 与同一广播；重试不新增副本，失败不保留半张图。
  const previewResult = reconcileShotPreviews(work, shotPreviewContext);
  if (!previewResult.ok) return previewResult;

  return finalize(canvas, work, now);
}

/**
 * 预扫描本批次中显式携带最终落点的预览节点。
 *
 * D4 要求「显式落点的预览以请求中的最终绝对落点为准，不再叠加片场位移 `d`」。批次中显式写入
 * `position` 的既有预览即视为用户直接给出的落点；拖动提交会同时更新预览与片场，因此这里按
 * 「本批显式更新了 position 的预览节点」识别，避免与 owner 闭包重复位移。
 */
function explicitShotPreviewPositions(commands: readonly CanvasCommand[], canvas: ServerCanvas): Set<string> {
  const previewIds = new Set(
    canvas.document.nodes.filter((node) => isShotPreviewNodeType(node.type)).map((node) => node.id)
  );
  const positioned = new Set<string>();
  for (const command of commands) {
    if (command.type === "node.update" && command.position) positioned.add(command.nodeId);
    if (command.type === "edit.apply") {
      for (const operation of command.operations) {
        if (operation.kind === "node-update" && operation.position) positioned.add(operation.nodeId);
      }
    }
  }
  return new Set([...positioned].filter((id) => previewIds.has(id)));
}

function applyCommand(work: WorkingState, command: CanvasCommand): CommandApplyResult {
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
      if (command.expectedInputMapping !== undefined && JSON.stringify(work.nodeData[command.nodeId]?.inputMapping ?? []) !== JSON.stringify(command.expectedInputMapping)) {
        return reject("invalid-connection", "输入连接已变化，请重新执行");
      }
      return patchNodeData(work, command.nodeId, command.value);
    case "filmSet.clipPatch":
      return patchFilmSetClip(work, command);
    case "filmSet.itemPatch":
      return patchFilmSetItem(work, command);
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
