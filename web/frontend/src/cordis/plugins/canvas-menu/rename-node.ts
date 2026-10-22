/**
 * 作品重命名提交器（change: 2026-10-09-improve-canvas-workflow，任务 2.3 / design D1）。
 *
 * 通过受保护语义命令更新既有名称字段（`nodeData.title`），并纳入页面编辑历史（可撤销）。
 * 只读或未结算时不发起写入；输入为空/超长时保留原值并给出可读原因。
 */
import { validateExplicitName } from "@woohaa3/contracts";
import type { CanvasEditService } from "../../services/canvas-state/index.js";
import { planNodeDataPatch } from "../../../extension-api/command-planner.js";

export type NodeRenameResult =
  | { ok: true; name: string }
  | { ok: false; code: string; error: string };

export type SubmitNodeRenameInput = {
  edit: CanvasEditService;
  nodeId: string;
  name: string;
};

export async function submitNodeRename(input: SubmitNodeRenameInput): Promise<NodeRenameResult> {
  const validation = validateExplicitName(input.name);
  if (!validation.ok) return { ok: false, code: "invalid-name", error: validation.message };
  const result = await input.edit.record(
    planNodeDataPatch({ nodeId: input.nodeId, value: { title: validation.value } }),
    "重命名作品"
  );
  if (!result.ok) return { ok: false, code: "rename-failed", error: result.reason };
  return { ok: true, name: validation.value };
}
