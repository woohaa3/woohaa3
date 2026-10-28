import type { ConversationTurn } from "../../extension/assistant/conversation.js";
import type { FilmSetConversionStatus } from "../film-set-conversion/types.js";
import type { CanvasOperationRecord } from "./types.js";

export type FilmSetRunPhase = "submitting" | "queued" | "running" | "committing" | "verifying";
export type FilmSetRunFeedback = {
  operationKey: string;
  phase: FilmSetRunPhase;
  source: "conversion" | "agent" | "operation" | "legacy" | "submission";
  labelCode: "submitting" | "queued" | "generating" | "modifying" | "running" | "saving" | "verifying";
};

export const FILM_SET_RUN_LABELS: Record<FilmSetRunFeedback["labelCode"], string> = {
  submitting: "提交中", queued: "排队中", generating: "生成中", modifying: "修改中",
  running: "运行中", saving: "保存中", verifying: "待确认"
};

/** Presentation only. Explicit delivery facts outrank its candidate turn and generic busy. */
export function normalizeFilmSetRunFeedback(input: {
  canvasId: string;
  nodeId: string;
  conversion?: FilmSetConversionStatus | null;
  turns?: readonly ConversationTurn[];
  records?: readonly CanvasOperationRecord[];
  legacyTaskStatus?: unknown;
  pendingRequestId?: string;
}): FilmSetRunFeedback | null {
  const conversion = input.conversion;
  const turnsByRequest = new Map<string, ConversationTurn>();
  const settled = (t: ConversationTurn) => ["succeeded", "failed", "cancelled", "partial"].includes(t.status);
  for (const turn of input.turns ?? []) {
    if (turn.target.canvasId !== input.canvasId || turn.target.nodeId !== input.nodeId
      || turn.target.mode !== "film-set" || turn.action === "discuss") continue;
    const previous = turnsByRequest.get(turn.requestId);
    if (!previous || (!settled(previous) && (settled(turn) || turn.updatedAt >= previous.updatedAt))) {
      turnsByRequest.set(turn.requestId, turn);
    }
  }
  const turns = [...turnsByRequest.values()];
  if (conversion?.status === "running" || conversion?.status === "unknown") {
    const phase = conversion.status === "unknown" ? "verifying"
      : conversion.step === "validate-and-save" ? "committing" : "running";
    return {
      operationKey: JSON.stringify(["conversion", conversion.requestId, conversion.execution?.attemptId ?? conversion.execution?.turnRequestId ?? ""]),
      phase, source: "conversion", labelCode: phase === "verifying" ? "verifying" : phase === "committing" ? "saving" : "generating"
    };
  }
  // A settled delivery suppresses only its explicitly linked candidate, never a later independent edit.
  const independent = turns.filter(t => t.requestId !== conversion?.execution?.turnRequestId
    && !(conversion && t.target.delivery?.domainRequestId === conversion.requestId));
  if (input.pendingRequestId && !independent.some(t => t.requestId === input.pendingRequestId)) {
    return { operationKey: JSON.stringify(["submission", input.pendingRequestId]), phase: "submitting", source: "submission", labelCode: "submitting" };
  }
  const turn = independent.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.requestId.localeCompare(a.requestId))[0];
  if (turn) {
    const phase = turn.status === "unknown" ? "verifying" : turn.status === "committing" ? "committing"
      : turn.status === "queued" ? "queued" : turn.status === "running" ? "running" : null;
    if (!phase) return null;
    return { operationKey: JSON.stringify(["agent", turn.conversationId, turn.requestId, turn.turnId]), phase, source: "agent",
      labelCode: phase === "verifying" ? "verifying" : phase === "committing" ? "saving" : phase === "queued" ? "queued"
        : turn.action === "modify" ? "modifying" : "generating" };
  }
  if (conversion || turns.length) return null;
  const records = (input.records ?? []).filter(r => r.canvasId === input.canvasId && r.nodeId === input.nodeId);
  const byId = new Map<string, CanvasOperationRecord>();
  for (const record of records) {
    const previous = byId.get(record.operationId);
    const terminal = (r: CanvasOperationRecord) => ["succeeded", "failed", "cancelled", "partial"].includes(r.state);
    if (!previous || (!terminal(previous) && (terminal(record) || record.updatedAt >= previous.updatedAt))) byId.set(record.operationId, record);
  }
  const record = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.operationId.localeCompare(a.operationId))[0];
  if (record) {
    const phase = record.state === "interrupted" ? "verifying" : record.state === "queued" ? "queued" : record.state === "running" ? "running" : null;
    return phase ? { operationKey: JSON.stringify([record.owner, record.operationId]), phase, source: "operation", labelCode: phase } : null;
  }
  if (input.pendingRequestId) return { operationKey: JSON.stringify(["submission", input.pendingRequestId]), phase: "submitting", source: "submission", labelCode: "submitting" };
  return input.legacyTaskStatus === "processing" || input.legacyTaskStatus === "pending"
    ? { operationKey: JSON.stringify(["legacy", input.canvasId, input.nodeId]), phase: input.legacyTaskStatus === "pending" ? "queued" : "running", source: "legacy", labelCode: input.legacyTaskStatus === "pending" ? "queued" : "running" }
    : null;
}
