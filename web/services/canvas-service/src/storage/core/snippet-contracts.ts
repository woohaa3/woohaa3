/**
 * 提示词片段目录存储契约
 * （change: add-prompt-snippet-library，任务 1.2/1.4 / design D1）。
 *
 * 后端无关：只描述片段/标签/幂等 operation 的目录事务，**不**涉及 Y.Doc、画布 revision、
 * 媒体 bytes 或 HTTP。目录与画布聚合分表存储，目录事务绝不产生 Yjs update。
 */
import type { PromptSnippet, PromptSnippetListQuery, PromptSnippetListResult, PromptSnippetMaterial, PromptSnippetTag } from "@woohaa3/contracts";

export type SnippetTagWithCount = PromptSnippetTag & { snippetCount: number };

export type SnippetOperationKind = "create-snippet" | "create-tag";

/** 幂等 receipt：相同主体 + operationId + 相同 payload 返回首次结果。 */
export type SnippetOperationRecord = {
  operationId: string;
  kind: SnippetOperationKind;
  /** 稳定的 payload 指纹（用于区分相同 operationId 的不同 payload）。 */
  payloadHash: string;
  resultId: string;
  createdAt: string;
};

export type CreateSnippetRecord = {
  id: string;
  name: string;
  /** 大小写无关的唯一键。 */
  nameKey: string;
  body: string;
  materials: PromptSnippetMaterial[];
  tagIds: string[];
  builtIn: boolean;
  now: string;
};

export type UpdateSnippetRecord = {
  id: string;
  expectedRevision: number;
  name: string;
  nameKey: string;
  body: string;
  materials: PromptSnippetMaterial[];
  tagIds: string[];
  now: string;
};

export type CreateTagRecord = {
  id: string;
  name: string;
  nameKey: string;
  builtIn: boolean;
  now: string;
};

export type SnippetRepository = {
  listSnippets(query: PromptSnippetListQuery): Promise<PromptSnippetListResult>;
  getSnippet(id: string): Promise<PromptSnippet | null>;
  createSnippet(record: CreateSnippetRecord, operation: SnippetOperationRecord): Promise<PromptSnippet>;
  updateSnippet(record: UpdateSnippetRecord): Promise<PromptSnippet>;
  deleteSnippet(id: string): Promise<void>;

  listTags(): Promise<SnippetTagWithCount[]>;
  getTag(id: string): Promise<PromptSnippetTag | null>;
  createTag(record: CreateTagRecord, operation: SnippetOperationRecord): Promise<PromptSnippetTag>;
  renameTag(input: { id: string; expectedRevision: number; name: string; nameKey: string; now: string }): Promise<PromptSnippetTag>;
  deleteTag(id: string): Promise<void>;

  getOperation(operationId: string): Promise<SnippetOperationRecord | null>;
  /** 幂等写入内置 seed（重复部署不产生副本）。 */
  seed(input: { snippets: readonly CreateSnippetRecord[]; tags: readonly CreateTagRecord[] }): Promise<void>;

  health(): Promise<{ ok: boolean; backend: string; reason?: string }>;
};
