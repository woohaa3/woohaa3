/** Page-owned input state. A pending request survives layout unmounts and never adopts later edits. */
export type AssistantDraftValue = {
  connection?: import("@woohaa3/contracts").AgentConnectionBinding;
  prompt: string;
  models: Record<string, string>;
  efforts: Record<string, import("@woohaa3/contracts").AgentReasoningEffort | "">;
};
export type AssistantInputScope = {
  dataScopeId: string;
  canvasId: string;
  purpose: string;
  nodeId?: string;
  cameraId?: string | null;
  clipId?: string | null;
  itemId?: string | null;
};
export type AssistantInputResult<T> =
  | { kind: "accepted"; value: T }
  | { kind: "rejected"; message: string }
  | { kind: "unknown"; message: string };
export type AssistantSubmissionPort<Input, Accepted> = {
  submit(input: Input, requestId: string): Promise<AssistantInputResult<Accepted>>;
  query(input: Input, requestId: string): Promise<AssistantInputResult<Accepted>>;
};
export function assistantInputKey(scope: AssistantInputScope): string {
  return JSON.stringify([scope.dataScopeId, scope.canvasId, scope.purpose, scope.nodeId ?? null, scope.cameraId ?? null, scope.clipId ?? null, scope.itemId ?? null]);
}

export function createAssistantInputController<Input, Accepted>(initial: Partial<AssistantDraftValue> = {}) {
  let state = {
    draft: { prompt: "", models: {}, efforts: {}, ...initial } as AssistantDraftValue,
    revision: 0,
    busy: false,
    notice: null as string | null,
    pending: null as { requestId: string; input: Input; revision: number } | null,
    accepted: null as Accepted | null,
  };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
    listeners.forEach(listener => listener());
  };
  const run = async (port: AssistantSubmissionPort<Input, Accepted>, query: boolean) => {
    const pending = state.pending;
    if (!pending || state.busy) return;
    update({ busy: true, notice: null });
    try {
      const result = await (query ? port.query : port.submit)(pending.input, pending.requestId);
      if (result.kind === "accepted") {
        update({ accepted: result.value, pending: null,
          ...(state.revision === pending.revision ? { draft: { ...state.draft, prompt: "" } } : {}) });
      } else update({ notice: result.message, ...(result.kind === "rejected" ? { pending: null } : {}) });
      return result;
    } catch {
      update({ notice: "提交结果尚未确认，请核对原请求。" });
      return { kind: "unknown" as const, message: state.notice! };
    } finally { update({ busy: false }); }
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    edit(patch: Partial<AssistantDraftValue>) { update({ draft: { ...state.draft, ...patch }, revision: state.revision + 1 }); },
    submit(input: Input, port: AssistantSubmissionPort<Input, Accepted>) {
      // Even if the user edited the draft, retry means the original frozen intent.
      if (!state.pending && !state.busy) update({ pending: {
        requestId: `assistant:${crypto.randomUUID()}`, input: structuredClone(input), revision: state.revision,
      } });
      return run(port, false);
    },
    query(port: AssistantSubmissionPort<Input, Accepted>) { return run(port, true); },
  };
}

const pages = new WeakMap<object, Map<string, unknown>>();
export function assistantInputController<Input, Accepted>(page: object, scope: AssistantInputScope, initial?: Partial<AssistantDraftValue>) {
  let inputs = pages.get(page);
  if (!inputs) { inputs = new Map(); pages.set(page, inputs); }
  const key = assistantInputKey(scope);
  if (!inputs.has(key)) inputs.set(key, createAssistantInputController<Input, Accepted>(initial));
  return inputs.get(key) as ReturnType<typeof createAssistantInputController<Input, Accepted>>;
}
