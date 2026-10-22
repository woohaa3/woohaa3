import type { AgentModelView, AgentReasoningEffort } from "@woohaa3/contracts";

export type AssistantPreference = { sourceId: string; connectionId: string; model?: string; reasoningEffort?: AgentReasoningEffort | "" };
const preferences = new Map<string, AssistantPreference>();
const preferenceKey = (scope: string) => `woohaa3.assistant-selection.v1:${scope}`;
/** Only public identities are persisted, isolated by the current data space. */
export function readAssistantPreference(scope: string): AssistantPreference | undefined {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return preferences.get(scope);
    const raw = storage.getItem(preferenceKey(scope));
    if (raw) {
      const value = JSON.parse(raw);
      if (typeof value.sourceId === "string" && typeof value.connectionId === "string" && value.connectionId &&
        (value.model === undefined || typeof value.model === "string") &&
        (value.reasoningEffort === undefined || typeof value.reasoningEffort === "string")) return value;
    }
    return undefined;
  } catch { /* Storage may be unavailable; retain the in-session preference. */ }
  return preferences.get(scope);
}
export function rememberAssistantPreference(scope: string, value: AssistantPreference): void {
  preferences.set(scope, value);
  try { globalThis.localStorage?.setItem(preferenceKey(scope), JSON.stringify(value)); } catch { /* In-session fallback. */ }
}

const selections = new WeakMap<object, Map<string, Map<string, { sourceId: string | null; connectionId: string | null }>>>();
export function assistantSelectionMemory(page: object, dataScopeId: string) {
  let spaces = selections.get(page);
  if (!spaces) { spaces = new Map(); selections.set(page, spaces); }
  let memory = spaces.get(dataScopeId);
  if (!memory) { memory = new Map(); spaces.set(dataScopeId, memory); }
  return memory;
}

/** Shared by node authoring and blank-canvas creation. Never substitutes a model. */
export function agentModelSelection(models: readonly AgentModelView[], model: string, effort: AgentReasoningEffort | "", explicit: boolean) {
  const selected = models.find(option => option.id === model);
  const supportedEfforts = selected?.reasoningEfforts ?? [];
  return { supportedEfforts, invalidModel: model !== "" && !selected, missingRequiredModel: explicit && !model.trim(), invalidEffort: effort !== "" && !supportedEfforts.includes(effort) };
}

/** Preserve connection-specific catalogs; only fall back to the selected adapter. */
export function agentDirectoryModels(connectionModels: readonly AgentModelView[] | undefined, catalogModels: readonly AgentModelView[] | undefined): readonly AgentModelView[] {
  return connectionModels?.length ? connectionModels : catalogModels ?? [];
}

export async function readAgentCatalog(service: Pick<import("../../contract/agent-conversation.js").AgentConversationService, "catalog">, adapterId: string) {
  return service.catalog(adapterId);
}
