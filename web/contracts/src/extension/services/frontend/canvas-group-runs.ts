// 定义处：@woohaa3/contracts —— 前端 Cordis 根的服务契约；web/frontend 只做实现与 re-export。
import type { CanvasCreationView } from "../../assistant/canvas-creation.js";
import type { ConversationTurn } from "../../assistant/conversation.js";

/** Private ledger projection, shared by group chrome and the activity panel; never persisted in nodeData. */
export type CanvasGroupRun = {
  rootGroupId: string;
  conversationId?: string;
  creation?: CanvasCreationView;
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
