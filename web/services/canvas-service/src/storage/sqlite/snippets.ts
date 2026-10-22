/**
 * SQLite 提示词片段目录仓库
 * （change: add-prompt-snippet-library，任务 1.2 / design D1/D2/D7；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R26 —— 抽出迁移/行类型
 *  与 DTO/查询/光标，本文件保留 snippet/tag/operation 原子写 owner）。
 *
 * 独立于画布聚合与 Yjs 表：自己的迁移表 `snippet_schema_migrations` 与
 * `prompt_snippets` / `prompt_snippet_tags` / `prompt_snippet_operations`。目录事务**绝不**
 * 触碰画布表或 Y.Doc，因此不会推进 canvas revision 或广播 room update。
 *
 * 全部写入用 `BEGIN IMMEDIATE` + 主键/唯一约束实现幂等与命名唯一；revision 用条件更新
 * 实现乐观并发。任何失败 `ROLLBACK`，不留部分写入。
 */
import type { DatabaseSync } from "node:sqlite";
import type { PromptSnippet, PromptSnippetListQuery, PromptSnippetListResult, PromptSnippetTag } from "@woohaa3/contracts";
import { promptSnippetNameKey } from "@woohaa3/contracts";
import { loadNodeSqlite } from "./sqlite-loader.js";
import { CanvasStorageError } from "../core/errors.js";
import type {
  CreateSnippetRecord,
  CreateTagRecord,
  SnippetOperationRecord,
  SnippetRepository,
  SnippetTagWithCount,
  UpdateSnippetRecord
} from "../core/snippet-contracts.js";
import {
  SQLITE_SNIPPET_SCHEMA_VERSION,
  ensureMigrationTable,
  migrationV1,
  readMigrationVersion,
  recordMigrationVersion,
  safeMessage,
  safeRollback,
  translateWriteError,
  type OperationRow,
  type SnippetRow,
  type SqliteSnippetRepositoryOptions,
  type TagRow
} from "./snippets-migrations.js";
import { decodeOffset, encodeOffset, matchesQuery, rowToSnippet, rowToTag } from "./snippets-read-model.js";

export { SQLITE_SNIPPET_SCHEMA_VERSION, promptSnippetNameKey };
export type { SqliteSnippetRepositoryOptions } from "./snippets-migrations.js";

export class SqliteSnippetRepository implements SnippetRepository {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly failWrites: () => boolean;
  private closed = false;

  constructor(options: SqliteSnippetRepositoryOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.failWrites = options.failWrites ?? (() => false);
    try {
      const sqlite = loadNodeSqlite();
      this.db = new sqlite.DatabaseSync(options.path, {
        readOnly: options.readOnly ?? false,
        enableForeignKeyConstraints: true
      });
    } catch (error) {
      throw new CanvasStorageError("NOT_READY", `无法打开 SQLite 数据库：${safeMessage(error)}`);
    }
    try {
      if (!options.readOnly) {
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA busy_timeout = " + (options.busyTimeoutMs ?? 5_000));
      }
      this.db.exec("PRAGMA foreign_keys = ON");
      this.migrate();
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // ignore
      }
      if (error instanceof CanvasStorageError) throw error;
      throw new CanvasStorageError("NOT_READY", `片段目录初始化失败：${safeMessage(error)}`);
    }
  }

  private migrate(): void {
    ensureMigrationTable(this.db);
    const current = readMigrationVersion(this.db);
    if (current >= SQLITE_SNIPPET_SCHEMA_VERSION) return;
    this.inImmediateTransaction(() => {
      migrationV1(this.db);
      recordMigrationVersion(this.db, this.now);
    });
  }

  async listSnippets(query: PromptSnippetListQuery): Promise<PromptSnippetListResult> {
    const all = (this.db.prepare("SELECT * FROM prompt_snippets ORDER BY built_in DESC, updated_at DESC, id ASC").all() as SnippetRow[])
      .map(rowToSnippet)
      .filter((snippet) => matchesQuery(snippet, query, this.tagNameMap()));
    const offset = decodeOffset(query.cursor);
    const limit = query.limit ?? 30;
    const page = all.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      items: page,
      nextCursor: nextOffset < all.length ? encodeOffset(nextOffset) : null,
      total: all.length
    };
  }

  async getSnippet(id: string): Promise<PromptSnippet | null> {
    const row = this.db.prepare("SELECT * FROM prompt_snippets WHERE id = ?").get(id) as SnippetRow | undefined;
    return row ? rowToSnippet(row) : null;
  }

  async createSnippet(record: CreateSnippetRecord, operation: SnippetOperationRecord): Promise<PromptSnippet> {
    return this.inImmediateTransaction(() => {
      this.assertUniqueName(record.nameKey, null);
      this.db
        .prepare(
          `INSERT INTO prompt_snippets
             (id, name, name_key, body, materials_json, tag_ids_json, built_in, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.id,
          record.name,
          record.nameKey,
          record.body,
          JSON.stringify(record.materials),
          JSON.stringify(record.tagIds),
          record.builtIn ? 1 : 0,
          1,
          record.now,
          record.now
        );
      this.writeOperation(operation);
      return {
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
    });
  }

  async updateSnippet(record: UpdateSnippetRecord): Promise<PromptSnippet> {
    return this.inImmediateTransaction(() => {
      const current = this.db.prepare("SELECT * FROM prompt_snippets WHERE id = ?").get(record.id) as SnippetRow | undefined;
      if (!current) throw new CanvasStorageError("SNIPPET_NOT_FOUND", `片段 ${record.id} 不存在`);
      const existing = rowToSnippet(current);
      if (existing.builtIn) throw new CanvasStorageError("SNIPPET_READ_ONLY", "内置片段只读");
      if (current.revision !== record.expectedRevision) {
        throw new CanvasStorageError("SNIPPET_REVISION_CONFLICT", "片段 revision 已变化", {
          currentRevision: current.revision
        });
      }
      const conflict = this.db
        .prepare("SELECT id FROM prompt_snippets WHERE name_key = ? AND id != ?")
        .get(record.nameKey, record.id) as { id: string } | undefined;
      if (conflict) throw new CanvasStorageError("SNIPPET_NAME_CONFLICT", "片段名称已存在");
      const nextRevision = current.revision + 1;
      this.db
        .prepare(
          `UPDATE prompt_snippets
             SET name = ?, name_key = ?, body = ?, materials_json = ?, tag_ids_json = ?, revision = ?, updated_at = ?
           WHERE id = ? AND revision = ?`
        )
        .run(
          record.name,
          record.nameKey,
          record.body,
          JSON.stringify(record.materials),
          JSON.stringify(record.tagIds),
          nextRevision,
          record.now,
          record.id,
          record.expectedRevision
        );
      return {
        ...existing,
        name: record.name,
        body: record.body,
        materials: record.materials.map((material) => ({ ...material })),
        tagIds: [...record.tagIds],
        revision: nextRevision,
        updatedAt: record.now
      };
    });
  }

  async deleteSnippet(id: string): Promise<void> {
    this.inImmediateTransaction(() => {
      const current = this.db.prepare("SELECT * FROM prompt_snippets WHERE id = ?").get(id) as SnippetRow | undefined;
      if (!current) throw new CanvasStorageError("SNIPPET_NOT_FOUND", `片段 ${id} 不存在`);
      if (current.built_in) throw new CanvasStorageError("SNIPPET_READ_ONLY", "内置片段只读");
      this.db.prepare("DELETE FROM prompt_snippets WHERE id = ?").run(id);
    });
  }

  async listTags(): Promise<SnippetTagWithCount[]> {
    const rows = this.db.prepare("SELECT * FROM prompt_snippet_tags ORDER BY name ASC").all() as TagRow[];
    const counts = this.tagCountMap();
    return rows.map((row) => ({ ...rowToTag(row), snippetCount: counts.get(row.id) ?? 0 }));
  }

  async getTag(id: string): Promise<PromptSnippetTag | null> {
    const row = this.db.prepare("SELECT * FROM prompt_snippet_tags WHERE id = ?").get(id) as TagRow | undefined;
    return row ? rowToTag(row) : null;
  }

  async createTag(record: CreateTagRecord, operation: SnippetOperationRecord): Promise<PromptSnippetTag> {
    return this.inImmediateTransaction(() => {
      const conflict = this.db
        .prepare("SELECT id FROM prompt_snippet_tags WHERE name_key = ?")
        .get(record.nameKey) as { id: string } | undefined;
      if (conflict) throw new CanvasStorageError("TAG_NAME_CONFLICT", "标签名称已存在");
      this.db
        .prepare(
          `INSERT INTO prompt_snippet_tags (id, name, name_key, built_in, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(record.id, record.name, record.nameKey, record.builtIn ? 1 : 0, 1, record.now, record.now);
      this.writeOperation(operation);
      return {
        id: record.id,
        name: record.name,
        builtIn: record.builtIn,
        revision: 1,
        createdAt: record.now,
        updatedAt: record.now
      };
    });
  }

  async renameTag(input: { id: string; expectedRevision: number; name: string; nameKey: string; now: string }): Promise<PromptSnippetTag> {
    return this.inImmediateTransaction(() => {
      const current = this.db.prepare("SELECT * FROM prompt_snippet_tags WHERE id = ?").get(input.id) as TagRow | undefined;
      if (!current) throw new CanvasStorageError("TAG_NOT_FOUND", `标签 ${input.id} 不存在`);
      if (current.built_in) throw new CanvasStorageError("SNIPPET_READ_ONLY", "内置标签只读");
      if (current.revision !== input.expectedRevision) {
        throw new CanvasStorageError("SNIPPET_REVISION_CONFLICT", "标签 revision 已变化", {
          currentRevision: current.revision
        });
      }
      const conflict = this.db
        .prepare("SELECT id FROM prompt_snippet_tags WHERE name_key = ? AND id != ?")
        .get(input.nameKey, input.id) as { id: string } | undefined;
      if (conflict) throw new CanvasStorageError("TAG_NAME_CONFLICT", "标签名称已存在");
      const nextRevision = current.revision + 1;
      this.db
        .prepare("UPDATE prompt_snippet_tags SET name = ?, name_key = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?")
        .run(input.name, input.nameKey, nextRevision, input.now, input.id, input.expectedRevision);
      // 标签重命名只改 tag 记录；片段按 ID 关联，无需更新片段。
      return {
        id: input.id,
        name: input.name,
        builtIn: false,
        revision: nextRevision,
        createdAt: current.created_at,
        updatedAt: input.now
      };
    });
  }

  async deleteTag(id: string): Promise<void> {
    this.inImmediateTransaction(() => {
      const current = this.db.prepare("SELECT * FROM prompt_snippet_tags WHERE id = ?").get(id) as TagRow | undefined;
      if (!current) throw new CanvasStorageError("TAG_NOT_FOUND", `标签 ${id} 不存在`);
      if (current.built_in) throw new CanvasStorageError("SNIPPET_READ_ONLY", "内置标签只读");
      // 单事务：删除标签并移除所有片段关联，但不删除片段。
      this.db.prepare("DELETE FROM prompt_snippet_tags WHERE id = ?").run(id);
      const rows = this.db.prepare("SELECT id, tag_ids_json FROM prompt_snippets").all() as Array<{ id: string; tag_ids_json: string }>;
      for (const row of rows) {
        const tagIds = JSON.parse(row.tag_ids_json) as string[];
        const next = tagIds.filter((tagId) => tagId !== id);
        if (next.length !== tagIds.length) {
          this.db.prepare("UPDATE prompt_snippets SET tag_ids_json = ? WHERE id = ?").run(JSON.stringify(next), row.id);
        }
      }
    });
  }

  async getOperation(operationId: string): Promise<SnippetOperationRecord | null> {
    const row = this.db.prepare("SELECT * FROM prompt_snippet_operations WHERE operation_id = ?").get(operationId) as
      | OperationRow
      | undefined;
    return row
      ? {
          operationId: row.operation_id,
          kind: row.kind as SnippetOperationRecord["kind"],
          payloadHash: row.payload_hash,
          resultId: row.result_id,
          createdAt: row.created_at
        }
      : null;
  }

  async seed(input: { snippets: readonly CreateSnippetRecord[]; tags: readonly CreateTagRecord[] }): Promise<void> {
    this.inImmediateTransaction(() => {
      for (const tag of input.tags) {
        this.db
          .prepare("INSERT OR IGNORE INTO prompt_snippet_tags (id, name, name_key, built_in, revision, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)")
          .run(tag.id, tag.name, tag.nameKey, tag.now, tag.now);
      }
      for (const snippet of input.snippets) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO prompt_snippets
               (id, name, name_key, body, materials_json, tag_ids_json, built_in, revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`
          )
          .run(
            snippet.id,
            snippet.name,
            snippet.nameKey,
            snippet.body,
            JSON.stringify(snippet.materials),
            JSON.stringify(snippet.tagIds),
            snippet.now,
            snippet.now
          );
      }
    });
  }

  async health(): Promise<{ ok: boolean; backend: string; reason?: string }> {
    try {
      this.db.prepare("SELECT COUNT(*) AS total FROM prompt_snippets").get();
      return { ok: true, backend: "sqlite" };
    } catch (error) {
      return { ok: false, backend: "sqlite", reason: safeMessage(error) };
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  debugQuery<T = unknown>(sql: string): T[] {
    return this.db.prepare(sql).all() as T[];
  }

  // --- internals ----------------------------------------------------------

  private writeOperation(operation: SnippetOperationRecord): void {
    this.db
      .prepare(
        "INSERT INTO prompt_snippet_operations (operation_id, kind, payload_hash, result_id, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(operation.operationId, operation.kind, operation.payloadHash, operation.resultId, operation.createdAt);
  }

  private assertUniqueName(nameKey: string, exceptId: string | null): void {
    const row = exceptId
      ? this.db.prepare("SELECT id FROM prompt_snippets WHERE name_key = ? AND id != ?").get(nameKey, exceptId)
      : this.db.prepare("SELECT id FROM prompt_snippets WHERE name_key = ?").get(nameKey);
    if (row) throw new CanvasStorageError("SNIPPET_NAME_CONFLICT", "片段名称已存在");
  }

  private tagNameMap(): Map<string, string> {
    const rows = this.db.prepare("SELECT id, name FROM prompt_snippet_tags").all() as Array<{ id: string; name: string }>;
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  private tagCountMap(): Map<string, number> {
    const counts = new Map<string, number>();
    const rows = this.db.prepare("SELECT tag_ids_json FROM prompt_snippets").all() as Array<{ tag_ids_json: string }>;
    for (const row of rows) {
      for (const tagId of JSON.parse(row.tag_ids_json) as string[]) {
        counts.set(tagId, (counts.get(tagId) ?? 0) + 1);
      }
    }
    return counts;
  }

  private inImmediateTransaction<T>(run: () => T): T {
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw translateWriteError(error);
    }
    try {
      if (this.failWrites()) throw new CanvasStorageError("REPOSITORY_FAILURE", "注入的写失败");
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      safeRollback(this.db);
      throw translateWriteError(error);
    }
  }
}
