/**
 * Durable trusted host-completion facts (T11a).
 *
 * A fact is written by the host only after the durable application turn reached
 * a successful terminal state, and it carries the exact camera/settingsVersion
 * this run actually wrote. The camera history row is written from this fact.
 *
 * The fact is deliberately separate from the history read model: if the history
 * write fails transiently (or the process stops between the two writes), the
 * fact remains and the exact completion can be retried after the lease has been
 * released and after a restart. That is what prevents "stop confirmed" from
 * being mistaken for "history recorded".
 */
export type AssistantHostCompletionStatus = "succeeded" | "partial";

export type AssistantHostCompletionFact = {
  canvasId: string;
  requestId: string;
  runId: string;
  completionId: string;
  cameraId: string;
  settingsVersion: string;
  status: AssistantHostCompletionStatus;
};

export type AssistantHostCompletionIdentity = {
  canvasId: string;
  runId: string;
  completionId: string;
  cameraId: string;
};

/** Stable identity key: a run may complete more than one camera, so cameraId is part of it. */
export function hostCompletionKey(completion: AssistantHostCompletionIdentity): string {
  return JSON.stringify([completion.canvasId, completion.runId, completion.completionId, completion.cameraId]);
}

export type AssistantHostCompletionListInput = {
  canvasId?: string;
  runId?: string;
};

export interface AssistantHostCompletionRepository {
  /** Idempotently persist one trusted fact. */
  put(fact: AssistantHostCompletionFact): Promise<void>;
  get(completion: AssistantHostCompletionIdentity): Promise<AssistantHostCompletionFact | null>;
  /** Omit filters to list every outstanding fact (bounded by caller). */
  list(input?: AssistantHostCompletionListInput): Promise<AssistantHostCompletionFact[]>;
  /** Called only after the trusted history write succeeded. */
  delete(completion: AssistantHostCompletionIdentity): Promise<void>;
  close?(): void | Promise<void>;
}

function clone(fact: AssistantHostCompletionFact): AssistantHostCompletionFact {
  return { ...fact };
}

export class InMemoryAssistantHostCompletionRepository implements AssistantHostCompletionRepository {
  private readonly facts = new Map<string, AssistantHostCompletionFact>();

  async put(fact: AssistantHostCompletionFact): Promise<void> {
    this.facts.set(hostCompletionKey(fact), clone(fact));
  }

  async get(completion: AssistantHostCompletionIdentity): Promise<AssistantHostCompletionFact | null> {
    const fact = this.facts.get(hostCompletionKey(completion));
    return fact ? clone(fact) : null;
  }

  async list(input: AssistantHostCompletionListInput = {}): Promise<AssistantHostCompletionFact[]> {
    return [...this.facts.values()]
      .filter(fact => (input.canvasId === undefined || fact.canvasId === input.canvasId)
        && (input.runId === undefined || fact.runId === input.runId))
      .map(clone);
  }

  async delete(completion: AssistantHostCompletionIdentity): Promise<void> {
    this.facts.delete(hostCompletionKey(completion));
  }
}
