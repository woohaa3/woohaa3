import type { CanvasCreationRequest, CanvasCreationView, AgentReasoningEffort } from "@woohaa3/contracts";
import { createAssistantInputController } from "../../services/assistant-execution/controller.js";
import { readAssistantPreference } from "../../services/assistant-execution/selection.js";
import type { ApplicationRemoteTransport } from "../../contract/remote.js";

export type CreationDraft = { prompt: string; connectionId: string; model: string; effort: AgentReasoningEffort | ""; version: number; pending?: CanvasCreationRequest; result?: CanvasCreationView; busy: boolean; notice?: string };
const spaces = new WeakMap<ApplicationRemoteTransport, Map<string, CreationDraft>>();
const observers = new WeakMap<CreationDraft, { revision: number; listeners: Set<() => void> }>();
function observation(draft: CreationDraft) {
  let value = observers.get(draft);
  if (!value) { value = { revision: 0, listeners: new Set() }; observers.set(draft, value); }
  return value;
}
export function subscribeCreationDraft(draft: CreationDraft, listener: () => void) {
  observation(draft).listeners.add(listener);
  return () => { observation(draft).listeners.delete(listener); };
}
export const creationDraftRevision = (draft: CreationDraft) => observation(draft).revision;
export function notifyCreationDraft(draft: CreationDraft) {
  const input = creationInputs.get(draft);
  if (input && input.getSnapshot().draft.prompt !== draft.prompt) input.edit({ prompt: draft.prompt });
  publishDraft(draft);
}
function publishDraft(draft: CreationDraft) {
  const value = observation(draft);
  value.revision++;
  for (const listener of value.listeners) listener();
}
export function creationDraft(transport: ApplicationRemoteTransport, namespace: string, canvasId: string): CreationDraft {
  let space = spaces.get(transport);
  if (!space) { space = new Map(); spaces.set(transport, space); }
  const key = JSON.stringify([namespace, canvasId]);
  let draft = space.get(key);
  if (!draft) {
    const preference = readAssistantPreference(namespace);
    draft = { prompt: "", connectionId: preference?.connectionId ?? "", model: preference?.model ?? "", effort: preference?.reasoningEffort ?? "", version: 0, busy: false };
    space.set(key, draft);
  }
  return draft;
}
type CreationInput = Omit<CanvasCreationRequest, "requestId">;
const creationInputs = new WeakMap<CreationDraft, ReturnType<typeof createAssistantInputController<CreationInput, CanvasCreationView>>>();
/** Compatibility draft facade; submission identity/busy/recovery belong to the shared controller. */
export function creationInput(draft: CreationDraft) {
  let input = creationInputs.get(draft);
  if (!input) {
    input = createAssistantInputController<CreationInput, CanvasCreationView>({ prompt: draft.prompt });
    creationInputs.set(draft, input);
    const controller = input;
    controller.subscribe(() => {
      const state = controller.getSnapshot();
      draft.prompt = state.draft.prompt;
      draft.busy = state.busy;
      draft.notice = state.notice ?? undefined;
      draft.pending = state.pending ? { ...state.pending.input, requestId: state.pending.requestId } : undefined;
      publishDraft(draft);
    });
  }
  return input;
}
export const CANVAS_CREATIONS_PATH = "/api/agent-conversations/canvas-creations";
export async function readCreation(transport: ApplicationRemoteTransport, requestId: string): Promise<CanvasCreationView> {
  const response = await transport.request({ path: `${CANVAS_CREATIONS_PATH}/${encodeURIComponent(requestId)}` });
  if (!response.ok) throw new Error(response.error);
  return creationResponse(response.data);
}
export function creationResponse(data: unknown): CanvasCreationView {
  const view = (data as { creation?: CanvasCreationView } | null)?.creation;
  if (!view || typeof view.requestId !== "string" || typeof view.canvasId !== "string" || typeof view.rootGroupId !== "string" || !["preparing", "root-created", "accepted", "failed", "unknown"].includes(view.stage)) throw new Error("创建响应无法核对，请查询原请求");
  return view;
}
