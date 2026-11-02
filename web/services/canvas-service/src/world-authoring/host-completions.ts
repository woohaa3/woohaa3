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
import type { WorldCameraData } from "@woohaa3/contracts";

export type AssistantHostCompletionStatus = "succeeded" | "partial";

export type AssistantHostCompletionFact = {
  canvasId: string;
  requestId: string;
  runId: string;
  completionId: string;
  cameraId: string;
  settingsVersion: string;
  status: AssistantHostCompletionStatus;
  /**
   * Exact camera settings the run committed. It is frozen with the fact so the
   * history row can still be written after a later legitimate edit, a delete or
   * a restart changed the current camera. Optional only for facts persisted by
   * an older build; those fall back to the current camera and stay fail-closed.
   */
  snapshot?: WorldCameraData;
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

/**
 * A camera write that already committed through the authoritative spatial path
 * but whose run has not reached a trusted successful terminal turn yet.
 *
 * This outbox closes the crash window between the canonical camera commit and
 * the first host settle: the run identity, the stable completionId and the exact
 * committed camera/settingsVersion are durable at the commit boundary, so a
 * reopened backend can promote them to a completion fact after the host turn
 * really succeeds. A committed write alone is *not* a completion fact and can
 * never authorize history on its own.
 */
export type AssistantWorldCommittedWrite = {
  canvasId: string;
  requestId: string;
  runId: string;
  epoch: number;
  executionId: string;
  contextId: string;
  completionId: string;
  cameraId: string;
  settingsVersion: string;
  /** Exact camera data this run committed; required so a later edit cannot overwrite it. */
  snapshot: WorldCameraData;
};

export type AssistantWorldCommittedWriteIdentity = {
  canvasId: string;
  runId: string;
  completionId: string;
  cameraId: string;
};

export type AssistantWorldCommittedWriteListInput = {
  canvasId?: string;
  runId?: string;
};

/** Stable identity key, shared with the completion-fact key. */
export function committedWriteKey(write: AssistantWorldCommittedWriteIdentity): string {
  return JSON.stringify([write.canvasId, write.runId, write.completionId, write.cameraId]);
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
  /**
   * Durable outbox for already-committed camera writes whose run has not yet
   * reached a trusted successful terminal turn. Implementations that persist
   * completion facts must implement these; omitting them keeps an in-process
   * only service (tests/embedded) valid but never claims restart recovery.
   */
  putCommitted?(write: AssistantWorldCommittedWrite): Promise<void>;
  listCommitted?(input?: AssistantWorldCommittedWriteListInput): Promise<AssistantWorldCommittedWrite[]>;
  deleteCommitted?(write: AssistantWorldCommittedWriteIdentity): Promise<void>;
  close?(): void | Promise<void>;
}

function clone(fact: AssistantHostCompletionFact): AssistantHostCompletionFact {
  return { ...fact, ...(fact.snapshot ? { snapshot: structuredClone(fact.snapshot) } : {}) };
}

export class InMemoryAssistantHostCompletionRepository implements AssistantHostCompletionRepository {
  private readonly facts = new Map<string, AssistantHostCompletionFact>();
  private readonly committed = new Map<string, AssistantWorldCommittedWrite>();

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

  async putCommitted(write: AssistantWorldCommittedWrite): Promise<void> {
    this.committed.set(committedWriteKey(write), {
      ...write,
      snapshot: structuredClone(write.snapshot)
    });
  }

  async listCommitted(input: AssistantWorldCommittedWriteListInput = {}): Promise<AssistantWorldCommittedWrite[]> {
    return [...this.committed.values()]
      .filter(write => (input.canvasId === undefined || write.canvasId === input.canvasId)
        && (input.runId === undefined || write.runId === input.runId))
      .map(write => ({ ...write, snapshot: structuredClone(write.snapshot) }));
  }

  async deleteCommitted(write: AssistantWorldCommittedWriteIdentity): Promise<void> {
    this.committed.delete(committedWriteKey(write));
  }
}
