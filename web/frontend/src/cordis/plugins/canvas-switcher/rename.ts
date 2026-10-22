/**
 * 画布重命名提交器
 * （change: 2026-09-29-add-multi-canvas-workspace，任务 4.3 / 4.4 / design D5）。
 *
 * 只通过当前 `CanvasSession` 提交单条 `canvas.setTitle`；等待 command lifecycle 判定
 * committed，绝不用固定 timeout 当作成功。rejected/failed 返回安全错误。
 */
import type { CanvasSession } from "../../contract/session.js";

export type CanvasRenameResult =
  | { ok: true; title: string }
  | { ok: false; code: string; error: string };

export type SubmitCanvasRenameInput = {
  session: CanvasSession;
  title: string;
  /** 测试注入确定性 commandId；缺省按时间序生成。 */
  commandId?: string;
};

let renameSequence = 0;

export async function submitCanvasRename(input: SubmitCanvasRenameInput): Promise<CanvasRenameResult> {
  const title = input.title.trim();
  if (!title) return { ok: false, code: "invalid-title", error: "标题不能为空" };
  if (!input.session.isWritable()) {
    return { ok: false, code: "offline-readonly", error: "画布当前只读，无法重命名" };
  }
  const commandId = input.commandId ?? `canvas-rename-${Date.now().toString(36)}-${(renameSequence += 1)}`;
  const submitted = input.session.submitCommands([{ type: "canvas.setTitle", title }], commandId);
  if (!submitted.ok) {
    return { ok: false, code: submitted.code ?? "send-failed", error: submitted.reason };
  }
  const settled = await submitted.handle.settled;
  if (settled.state === "committed") return { ok: true, title };
  return { ok: false, code: "rejected", error: settled.error ?? "重命名未确认" };
}
