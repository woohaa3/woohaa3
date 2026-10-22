/**
 * 导入画布目标授权判定（纯函数）
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 4.3、4.7 / design D4）。
 *
 * 与来源扩展的 ACL 标准化对应，但**目标授权独立**：由平台按 `ImportedCanvasAccess` 判定，
 * 不 import 来源扩展。`everyone_view`/`everyone_edit` 在受信部署用户域内解释，不扩大到匿名。
 */
import type { ImportedCanvasAccess } from "@woohaa3/contracts";

export function canReadImported(access: ImportedCanvasAccess, subject: string): boolean {
  if (!subject) return false;
  if (access.ownerSubject === subject) return true;
  if (access.readSubjects.includes(subject)) return true;
  return access.sharingMode === "everyone_view" || access.sharingMode === "everyone_edit";
}

export function canWriteImported(access: ImportedCanvasAccess, subject: string): boolean {
  if (!subject) return false;
  if (access.ownerSubject === subject) return true;
  if (access.writeSubjects.includes(subject)) return true;
  return access.sharingMode === "everyone_edit";
}

/** 导入 ACL 是否把该主体标识为 owner（首访者不得成为 owner 的断言基础）。 */
export function isImportedOwner(access: ImportedCanvasAccess, subject: string): boolean {
  return access.ownerSubject === subject;
}
