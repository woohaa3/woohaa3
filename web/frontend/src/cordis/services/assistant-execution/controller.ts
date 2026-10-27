/** Page-owned input state. A pending request survives layout unmounts and never adopts later edits. */
export type AssistantDraftValue = {
  connection?: import("@woohaa3/contracts").AgentConnectionBinding;
  prompt: string;
  promptScope?: string;
  prompts?: Record<string, string>;
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
    submissions: [] as { requestId: string; input: Input; revision: number; busy: boolean; message?: string }[],
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
  const runIndependent = async (requestId: string, port: AssistantSubmissionPort<Input, Accepted>, query = false) => {
    const pending = state.submissions.find(item => item.requestId === requestId);
    if (!pending || pending.busy) return;
    const patch = (value: Partial<typeof pending>) => update({ submissions: state.submissions.map(item => item.requestId === requestId ? { ...item, ...value } : item) });
    patch({ busy: true, message: undefined });
    let result: AssistantInputResult<Accepted>;
    try { result = await (query ? port.query : port.submit)(pending.input, pending.requestId); }
    catch { result = { kind: "unknown", message: "提交结果尚未确认，请核对原请求。" }; }
    if (result.kind === "unknown") patch({ busy: false, message: result.message });
    else {
      update({ submissions: state.submissions.filter(item => item.requestId !== requestId),
        ...(result.kind === "accepted" ? { accepted: result.value,
          ...(state.revision === pending.revision ? { draft: { ...state.draft, prompt: "" } } : {}) } : { notice: result.message }) });
    }
    return result;
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    edit(patch: Partial<AssistantDraftValue>) { update({ draft: { ...state.draft, ...patch }, revision: state.revision + 1 }); },
    selectPromptScope(key: string) {
      if (state.draft.promptScope === key) return;
      const previous = state.draft.promptScope;
      const prompts = { ...state.draft.prompts, ...(previous ? { [previous]: state.draft.prompt } : {}) };
      update({ draft: { ...state.draft, promptScope: key, prompts, prompt: prompts[key] ?? (previous ? "" : state.draft.prompt) }, revision: state.revision + 1 });
    },
    submit(input: Input, port: AssistantSubmissionPort<Input, Accepted>) {
      // Even if the user edited the draft, retry means the original frozen intent.
      if (!state.pending && !state.busy) update({ pending: {
        requestId: `assistant:${crypto.randomUUID()}`, input: structuredClone(input), revision: state.revision,
      } });
      return run(port, false);
    },
    submitIndependent(input: Input, port: AssistantSubmissionPort<Input, Accepted>) {
      const requestId = `assistant:${crypto.randomUUID()}`;
      update({ notice: null, submissions: [...state.submissions, { requestId, input: structuredClone(input), revision: state.revision, busy: false }] });
      return runIndependent(requestId, port);
    },
    querySubmission(requestId: string, port: AssistantSubmissionPort<Input, Accepted>) { return runIndependent(requestId, port, true); },
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
