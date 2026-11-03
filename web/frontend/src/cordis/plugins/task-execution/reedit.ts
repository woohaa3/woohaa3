/**
 * 「重新编辑」：把某个版本生成时的输入载回该节点的底部对话框。
 *
 * - 提示词与参数进**草稿**（`nodeDraftStore`，只在客户端；用户改完点生成才成为规范数据）；
 * - 模型与「自带主图」写进节点数据（和生成时写入的字段一致，主图固定到当时的资产）；
 * - 不动卡片当前显示的结果图；
 * - 选中节点并展开对话框，让用户立刻看到载回的内容。
 *
 * 当时由别的节点连入的参考图不在这里恢复（快照里只有资产，没有来源节点），卡片上以缩略图只读展示。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { RunInputSnapshot } from "@woohaa3/contracts";
import { planNodeDataPatch } from "../../../extension-api/command-planner.js";
import { nodeDraftStore } from "./drafts.js";
import { requestDockExpand } from "./dock-expand-request.js";

export function reeditFromSnapshot(ctx: Context, nodeId: string, snapshot: RunInputSnapshot): boolean {
  if (!ctx.canvasSession.isWritable()) return false;
  // 生成时 run-service 会往参数里补一个 `model`；草稿里本来没有它，去掉免得污染模型表单。
  const { model: _model, ...parameters } = snapshot.parameters ?? {};
  nodeDraftStore.patch(
    nodeId,
    { prompt: snapshot.prompt, ...(snapshot.parameters ? { parameters } : {}) },
    snapshot.modelKey
  );
  const result = ctx.canvasSession.submitCommands(
    planNodeDataPatch({
      nodeId,
      value: {
        ...(snapshot.modelKey ? { modelKey: snapshot.modelKey } : {}),
        // 空串 = 没有自带主图：当时没有，载回后也不该残留现在的。
        selfReferenceAssetId: snapshot.selfReferenceAssetId ?? ""
      }
    }),
    `web-reedit-${Date.now().toString(36)}`
  );
  if (!result.ok) return false;
  requestDockExpand(nodeId);
  ctx.canvasRuntime.controller()?.selectNode(nodeId);
  return true;
}
