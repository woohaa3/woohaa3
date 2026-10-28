import { isAgentReasoningEffort, type AgentConnectionBinding, type AgentReasoningEffort } from "../../extension/assistant/conversation.js";
import { isBoundedId } from "../../validation.js";

/** Frozen assistant selection travels with the conversion's existing idempotent model key. */
export type FilmSetConversionAssistant = {
  connection: AgentConnectionBinding;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
};

export function filmSetConversionAssistantKey(selection: FilmSetConversionAssistant): string {
  const c = selection.connection;
  return `assistant:${encodeURIComponent(JSON.stringify([c.connectionId, c.adapterId, c.configRevision, c.credentialEpoch, selection.model ?? "", selection.reasoningEffort ?? ""]))}`;
}

export function readFilmSetConversionAssistant(key: string | undefined): FilmSetConversionAssistant | null {
  if (!key?.startsWith("assistant:") || key.length > 4096) return null;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(key.slice("assistant:".length)));
    if (!Array.isArray(value) || value.length !== 6) return null;
    const [connectionId, adapterId, configRevision, credentialEpoch, model, reasoningEffort] = value;
    if (!isBoundedId(connectionId) || !isBoundedId(adapterId) ||
        !Number.isInteger(configRevision) || configRevision < 0 || !Number.isInteger(credentialEpoch) || credentialEpoch < 0 || typeof model !== "string" || model.length > 1000 || typeof reasoningEffort !== "string" ||
        (reasoningEffort !== "" && !isAgentReasoningEffort(reasoningEffort))) return null;
    return { connection: { connectionId, adapterId, configRevision, credentialEpoch }, ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort: reasoningEffort as AgentReasoningEffort } : {}) };
  } catch { return null; }
}
