/**
 * 隔离通用扩展数据存储（SQLite 驱动）
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 0.4 / design D5）。
 *
 * 宿主提供的**通用**驱动：owner-scoped 文档、带版本、CAS 与原子 batch、前缀扫描。owner 来自
 * 可信 registration（extensionId），facade 拒绝跨 owner。扩展拥有自己的 schema/迁移/业务索引；
 * 本模块不暴露裸 SQL/数据库句柄，也不访问其它 extension 空间或 Canvas/Task 表。
 */
import type { DatabaseSync } from "node:sqlite";
import type {
  ExtensionDocument,
  ExtensionDocumentBatchResult,
  ExtensionDocumentOperation,
  ExtensionDocumentRead,
  ExtensionDocumentScanPage,
  ExtensionDocumentStore,
  ExtensionDocumentStoreProvider,
  ExtensionDocumentValue
} from "@woohaa3/contracts";
import { isExtensionDocumentValue } from "@woohaa3/contracts";
import { loadNodeSqlite } from "./sqlite-loader.js";

export const EXTENSION_DOCUMENT_SCHEMA_VERSION = 1;

type DocumentRow = {
  doc_key: string;
  value_json: string;
  revision: number;
  updated_at: string;
};

export type SqliteExtensionDocumentStoreOptions = {
  path: string;
  /** 该 provider 允许的 owner（extensionId）集合；未登记 owner 返回 null（fail closed）。 */
  owners: readonly string[];
  now?: () => Date;
};

export type SqliteExtensionDocumentStoreProvider = ExtensionDocumentStoreProvider & {
  close: () => void;
};

export function createSqliteExtensionDocumentStore(
  options: SqliteExtensionDocumentStoreOptions
): SqliteExtensionDocumentStoreProvider {
  const db = new (loadNodeSqlite().DatabaseSync)(options.path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  const now = options.now ?? (() => new Date());
  const allowed = new Set(options.owners);

  return {
    forExtension(extensionId: string): ExtensionDocumentStore | null {
      if (!allowed.has(extensionId)) return null;
      return createOwnerStore(db, extensionId, now);
    },
    close() {
      db.close();
    }
  };
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS extension_documents (
      owner TEXT NOT NULL,
      doc_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (owner, doc_key)
    );
    CREATE INDEX IF NOT EXISTS idx_extension_documents_owner_key
      ON extension_documents(owner, doc_key);
    CREATE TABLE IF NOT EXISTS extension_documents_meta (
      owner TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL
    );
    PRAGMA user_version = ${EXTENSION_DOCUMENT_SCHEMA_VERSION};
  `);
}

function createOwnerStore(
  db: DatabaseSync,
  owner: string,
  now: () => Date
): ExtensionDocumentStore {
  const read = (key: string): DocumentRow | undefined =>
    db.prepare("SELECT doc_key, value_json, revision, updated_at FROM extension_documents WHERE owner = ? AND doc_key = ?")
      .get(owner, key) as DocumentRow | undefined;

  const toDocument = (row: DocumentRow): ExtensionDocument => ({
    key: row.doc_key,
    value: JSON.parse(row.value_json) as ExtensionDocumentValue,
    revision: row.revision,
    updatedAt: row.updated_at
  });

  return {
    owner: () => owner,
    async get<T extends ExtensionDocumentValue = ExtensionDocumentValue>(key: string): Promise<ExtensionDocumentRead<T>> {
      const row = read(key);
      return row ? { found: true, document: toDocument(row) as ExtensionDocument<T> } : { found: false };
    },
    async batch(operations: readonly ExtensionDocumentOperation[]): Promise<ExtensionDocumentBatchResult> {
      const revisions: Record<string, number | null> = {};
      for (const operation of operations) {
        if (typeof operation.key !== "string" || operation.key === "" || operation.key.length > 512) {
          return { ok: false, code: "invalid", message: "文档 key 非法" };
        }
        if (operation.op === "set" && !isExtensionDocumentValue(operation.value)) {
          return { ok: false, code: "invalid", message: "文档值必须是结构性 JSON" };
        }
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const operation of operations) {
          const current = read(operation.key);
          const expected = operation.expectedRevision;
          if (expected !== undefined) {
            const currentRevision = current ? current.revision : null;
            if (currentRevision !== expected) {
              db.exec("ROLLBACK");
              return { ok: false, code: "revision-conflict", key: operation.key, currentRevision };
            }
          }
          if (operation.op === "delete") {
            if (current) {
              db.prepare("DELETE FROM extension_documents WHERE owner = ? AND doc_key = ?").run(owner, operation.key);
            }
            revisions[operation.key] = null;
            continue;
          }
          const nextRevision = (current?.revision ?? 0) + 1;
          const updatedAt = now().toISOString();
          db.prepare(`
            INSERT INTO extension_documents (owner, doc_key, value_json, revision, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(owner, doc_key) DO UPDATE SET
              value_json = excluded.value_json,
              revision = excluded.revision,
              updated_at = excluded.updated_at
          `).run(owner, operation.key, JSON.stringify(operation.value), nextRevision, updatedAt);
          revisions[operation.key] = nextRevision;
        }
        db.exec("COMMIT");
        return { ok: true, revisions };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async scan(prefix: string, scanOptions = {}): Promise<ExtensionDocumentScanPage> {
      const limit = Math.max(1, Math.min(scanOptions.limit ?? 100, 1000));
      const cursor = scanOptions.cursor ?? "";
      const rows = db.prepare(`
        SELECT doc_key, value_json, revision, updated_at FROM extension_documents
        WHERE owner = ? AND doc_key LIKE ? AND doc_key > ?
        ORDER BY doc_key ASC
        LIMIT ?
      `).all(owner, `${escapeLike(prefix)}%`, cursor, limit) as DocumentRow[];
      const entries = rows.map(toDocument);
      const nextCursor = rows.length === limit ? (rows[rows.length - 1]?.doc_key ?? null) : null;
      return { entries, nextCursor };
    },
    async schemaVersion(): Promise<number> {
      const row = db.prepare("SELECT schema_version FROM extension_documents_meta WHERE owner = ?").get(owner) as
        | { schema_version: number }
        | undefined;
      return row?.schema_version ?? 0;
    },
    async setSchemaVersion(version: number): Promise<void> {
      db.prepare(`
        INSERT INTO extension_documents_meta (owner, schema_version) VALUES (?, ?)
        ON CONFLICT(owner) DO UPDATE SET schema_version = excluded.schema_version
      `).run(owner, version);
    }
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
