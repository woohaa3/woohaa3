/**
 * 内存片段目录仓库（仅测试/无后端部署）
 * （change: add-prompt-snippet-library，任务 1.4）。
 *
 * 与 SQLite adapter 共享同一套目录语义（幂等、revision CAS、名称唯一、标签解绑），
 * 便于 contract-suite 在两侧做一致性断言。
 */
import type { PromptSnippet, PromptSnippetListQuery, PromptSnippetListResult, PromptSnippetTag } from "@woohaa3/contracts";
import { promptSnippetNameKey } from "@woohaa3/contracts";
import { CanvasStorageError } from "./errors.js";
import type {
  CreateSnippetRecord,
  CreateTagRecord,
  SnippetOperationRecord,
  SnippetRepository,
  SnippetTagWithCount,
  UpdateSnippetRecord
} from "./snippet-contracts.js";

type StoredSnippet = PromptSnippet;
type StoredTag = PromptSnippetTag;

export class InMemorySnippetRepository implements SnippetRepository {
  private readonly snippets = new Map<string, StoredSnippet>();
  private readonly tags = new Map<string, StoredTag>();
  private readonly operations = new Map<string, SnippetOperationRecord>();
  private readonly injectedFailures = { list: false, write: false };

  /** 测试注入：让下一次读/写失败。 */
  failNext(kind: "list" | "write"): void {
    this.injectedFailures[kind] = true;
  }

  async listSnippets(query: PromptSnippetListQuery): Promise<PromptSnippetListResult> {
    if (this.injectedFailures.list) {
      this.injectedFailures.list = false;
      throw new CanvasStorageError("REPOSITORY_FAILURE", "注入的读失败");
    }
    const all = [...this.snippets.values()].sort(compareSnippets);
    const filtered = all.filter((snippet) => matchesQuery(snippet, query, this.tags));
    const offset = decodeOffset(query.cursor);
    const limit = query.limit ?? 30;
    const page = filtered.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      items: page.map(cloneSnippet),
      nextCursor: nextOffset < filtered.length ? encodeOffset(nextOffset) : null,
      total: filtered.length
    };
  }

  async getSnippet(id: string): Promise<PromptSnippet | null> {
    const snippet = this.snippets.get(id);
    return snippet ? cloneSnippet(snippet) : null;
  }

  async createSnippet(record: CreateSnippetRecord, operation: SnippetOperationRecord): Promise<PromptSnippet> {
    if (this.injectedFailures.write) {
      this.injectedFailures.write = false;
      throw new CanvasStorageError("REPOSITORY_FAILURE", "注入的写失败");
    }
    this.assertUniqueName(record.nameKey, null);
    const snippet: StoredSnippet = {
      id: record.id,
      formatVersion: 1,
      builtIn: record.builtIn,
      name: record.name,
      body: record.body,
      materials: record.materials.map((material) => ({ ...material })),
      tagIds: [...record.tagIds],
      revision: 1,
      createdAt: record.now,
      updatedAt: record.now
    };
    this.snippets.set(snippet.id, snippet);
    this.operations.set(operation.operationId, { ...operation });
    return cloneSnippet(snippet);
  }

  async updateSnippet(record: UpdateSnippetRecord): Promise<PromptSnippet> {
    const current = this.snippets.get(record.id);
    if (!current) throw new CanvasStorageError("SNIPPET_NOT_FOUND", `片段 ${record.id} 不存在`);
    if (current.builtIn) throw new CanvasStorageError("SNIPPET_READ_ONLY", "内置片段只读");
    if (current.revision !== record.expectedRevision) {
      throw new CanvasStorageError("SNIPPET_REVISION_CONFLICT", "片段 revision 已变化", {
        currentRevision: current.revision
      });
    }
    this.assertUniqueName(record.nameKey, record.id);
    const next: StoredSnippet = {
      ...current,
      name: record.name,
      body: record.body,
      materials: record.materials.map((material) => ({ ...material })),
      tagIds: [...record.tagIds],
      revision: current.revision + 1,
      updatedAt: record.now
    };
    this.snippets.set(next.id, next);
    return cloneSnippet(next);
  }

  async deleteSnippet(id: string): Promise<void> {
    const current = this.snippets.get(id);
    if (!current) throw new CanvasStorageError("SNIPPET_NOT_FOUND", `片段 ${id} 不存在`);
    if (current.builtIn) throw new CanvasStorageError("SNIPPET_READ_ONLY", "内置片段只读");
    this.snippets.delete(id);
  }

  async listTags(): Promise<SnippetTagWithCount[]> {
    return [...this.tags.values()]
      .map((tag) => ({ ...tag, snippetCount: this.countTag(tag.id) }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async getTag(id: string): Promise<PromptSnippetTag | null> {
    const tag = this.tags.get(id);
    return tag ? { ...tag } : null;
  }

  async createTag(record: CreateTagRecord, operation: SnippetOperationRecord): Promise<PromptSnippetTag> {
    const existing = [...this.tags.values()].find((tag) => promptSnippetNameKey(tag.name) === record.nameKey);
    if (existing) throw new CanvasStorageError("TAG_NAME_CONFLICT", "标签名称已存在");
    const tag: StoredTag = {
      id: record.id,
      name: record.name,
      builtIn: record.builtIn,
      revision: 1,
      createdAt: record.now,
      updatedAt: record.now
    };
    this.tags.set(tag.id, tag);
    this.operations.set(operation.operationId, { ...operation });
    return { ...tag };
  }

  async renameTag(input: { id: string; expectedRevision: number; name: string; nameKey: string; now: string }): Promise<PromptSnippetTag> {
    const current = this.tags.get(input.id);
    if (!current) throw new CanvasStorageError("TAG_NOT_FOUND", `标签 ${input.id} 不存在`);
    if (current.builtIn) throw new CanvasStorageError("SNIPPET_READ_ONLY", "内置标签只读");
    if (current.revision !== input.expectedRevision) {
      throw new CanvasStorageError("SNIPPET_REVISION_CONFLICT", "标签 revision 已变化", {
        currentRevision: current.revision
      });
    }
    const conflict = [...this.tags.values()].find((tag) => tag.id !== input.id && promptSnippetNameKey(tag.name) === input.nameKey);
    if (conflict) throw new CanvasStorageError("TAG_NAME_CONFLICT", "标签名称已存在");
    const next: StoredTag = { ...current, name: input.name, revision: current.revision + 1, updatedAt: input.now };
    this.tags.set(next.id, next);
    return { ...next };
  }

  async deleteTag(id: string): Promise<void> {
    const current = this.tags.get(id);
    if (!current) throw new CanvasStorageError("TAG_NOT_FOUND", `标签 ${id} 不存在`);
    if (current.builtIn) throw new CanvasStorageError("SNIPPET_READ_ONLY", "内置标签只读");
    // 单事务语义：移除所有片段关联但保留片段本身。
    this.tags.delete(id);
    for (const [snippetId, snippet] of this.snippets) {
      if (snippet.tagIds.includes(id)) {
        this.snippets.set(snippetId, { ...snippet, tagIds: snippet.tagIds.filter((tagId) => tagId !== id) });
      }
    }
  }

  async getOperation(operationId: string): Promise<SnippetOperationRecord | null> {
    const record = this.operations.get(operationId);
    return record ? { ...record } : null;
  }

  async seed(input: { snippets: readonly CreateSnippetRecord[]; tags: readonly CreateTagRecord[] }): Promise<void> {
    for (const tag of input.tags) {
      if (!this.tags.has(tag.id)) {
        this.tags.set(tag.id, {
          id: tag.id,
          name: tag.name,
          builtIn: true,
          revision: 1,
          createdAt: tag.now,
          updatedAt: tag.now
        });
      }
    }
    for (const snippet of input.snippets) {
      if (!this.snippets.has(snippet.id)) {
        this.snippets.set(snippet.id, {
          id: snippet.id,
          formatVersion: 1,
          builtIn: true,
          name: snippet.name,
          body: snippet.body,
          materials: snippet.materials.map((material) => ({ ...material })),
          tagIds: [...snippet.tagIds],
          revision: 1,
          createdAt: snippet.now,
          updatedAt: snippet.now
        });
      }
    }
  }

  async health(): Promise<{ ok: boolean; backend: string }> {
    return { ok: true, backend: "memory" };
  }

  private assertUniqueName(nameKey: string, exceptId: string | null): void {
    for (const snippet of this.snippets.values()) {
      if (snippet.id === exceptId) continue;
      if (promptSnippetNameKey(snippet.name) === nameKey) {
        throw new CanvasStorageError("SNIPPET_NAME_CONFLICT", "片段名称已存在");
      }
    }
  }

  private countTag(tagId: string): number {
    return [...this.snippets.values()].filter((snippet) => snippet.tagIds.includes(tagId)).length;
  }
}

function compareSnippets(a: PromptSnippet, b: PromptSnippet): number {
  // 稳定排序：内置优先，再按 updatedAt 降序，再按 id。
  if (a.builtIn !== b.builtIn) return a.builtIn ? -1 : 1;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function matchesQuery(snippet: PromptSnippet, query: PromptSnippetListQuery, tags: Map<string, PromptSnippetTag>): boolean {
  if (query.filter === "builtIn" && !snippet.builtIn) return false;
  if (query.filter === "untagged" && (snippet.builtIn || snippet.tagIds.length > 0)) return false;
  if (query.filter === "tag") {
    if (!query.tagId || !snippet.tagIds.includes(query.tagId)) return false;
  }
  const text = query.query?.trim().toLocaleLowerCase();
  if (!text) return true;
  if (snippet.name.toLocaleLowerCase().includes(text)) return true;
  if (snippet.body.toLocaleLowerCase().includes(text)) return true;
  return snippet.tagIds.some((tagId) => (tags.get(tagId)?.name ?? "").toLocaleLowerCase().includes(text));
}

function cloneSnippet(snippet: PromptSnippet): PromptSnippet {
  return {
    ...snippet,
    materials: snippet.materials.map((material) => ({ ...material })),
    tagIds: [...snippet.tagIds]
  };
}

function encodeOffset(offset: number): string {
  return `o:${offset}`;
}

function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = /^o:(\d+)$/.exec(cursor);
  return match ? Number(match[1]) : 0;
}
