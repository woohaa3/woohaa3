import type { CanvasCreationView, ConversationTurn } from "@woohaa3/contracts";

/** Private ledger projection, shared by group chrome and the activity panel; never persisted in nodeData. */
export type CanvasGroupRun = {
  creation: CanvasCreationView;
  turn?: ConversationTurn;
  requestId: string;
  status: string;
  label: string;
  active: boolean;
  error?: string;
  createdAt: string;
};
export type CanvasGroupRunsSnapshot = { rows: readonly CanvasGroupRun[]; error: string };
export type CanvasGroupRunsService = {
  getSnapshot(): CanvasGroupRunsSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  stop(requestId: string): Promise<void>;
  retry(creationRequestId: string): Promise<void>;
};
