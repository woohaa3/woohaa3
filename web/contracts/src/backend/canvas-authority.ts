/** Controlled backend command authority. Implementations own permission, serialization and durable receipts. */
import type { ServerCanvas } from "../canvas/domain/index.js";
import type { CanvasCommandBatch } from "../canvas/yjs/index.js";
export type CanvasAuthorityResult =
  | { ok: true; status: "accepted" | "duplicate"; commandId: string; revision: number; noop: boolean }
  | { ok: false; code: string; message: string };
export type CanvasAuthority = {
  exportCanvas(): { ok: true; canvas: ServerCanvas } | { ok: false; message: string };
  submit(batch: CanvasCommandBatch): Promise<CanvasAuthorityResult>;
  submitDerived(input: { commandId: string; derive(canvas: ServerCanvas): { ok: true; batch: CanvasCommandBatch } | { ok: false; code: string; message: string } }): Promise<CanvasAuthorityResult>;
};
