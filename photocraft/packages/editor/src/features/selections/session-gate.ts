import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorHandle, EditorResult } from "../../editor-wasm.js";

/** Preserve the ordering of unavailable-session and active-draft failures. */
export function selectionSessionHandle(context: WorkspaceFeatureContext): EditorResult<EditorHandle> {
  if (!context.handle) return context.unavailable();
  if (context.hasActiveDraft()) return { ok: false, code: "gesture-active", message: "请先结算当前草稿" };
  return { ok: true, value: context.handle };
}
