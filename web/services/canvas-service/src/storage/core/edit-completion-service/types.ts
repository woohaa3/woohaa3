/**
 * 编辑完成服务：共享类型与端口
 * （自 `edit-completion-service.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R13）。
 */
import type {
  EditSessionCompleteResponse,
  MediaStorageScope,
  NodeGenerationHistoryEntry
} from "@woohaa3/contracts";
import type { EditCompletionRepository } from "../edit-completion-contracts.js";
import type { NodeHistoryRoomPort } from "../node-history-service.js";

/** 历史条目发布端口（由 NodeHistoryApplicationService 适配）。 */
export type NodeHistoryEntryPublisher = {
  registerEntry(entry: NodeGenerationHistoryEntry): Promise<{ status: "inserted" | "duplicate"; entryId: string }>;
  listEntriesForNode(canvasId: string, nodeId: string): Promise<NodeGenerationHistoryEntry[]>;
};

export type EditCompletionServiceOptions = {
  completions: EditCompletionRepository;
  publisher: NodeHistoryEntryPublisher;
  resolveRoom: (canvasId: string) => Promise<NodeHistoryRoomPort | null>;
  mediaVerifier?: { exists(storageKey: string, scope?: MediaStorageScope): Promise<boolean> };
  logger?: (event: Record<string, unknown>) => void;
  now?: () => string;
};

export type EditCompletionResult = EditSessionCompleteResponse;

/** 编辑完成协作上下文（单一 repository/room/publisher owner）。 */
export type EditCompletionContext = {
  completions: EditCompletionRepository;
  publisher: NodeHistoryEntryPublisher;
  resolveRoom: (canvasId: string) => Promise<NodeHistoryRoomPort | null>;
  mediaVerifier?: { exists(storageKey: string, scope?: MediaStorageScope): Promise<boolean> };
  log: (event: Record<string, unknown>) => void;
  now: () => string;
};
