/**
 * Submit 幂等 key 表（change: split-web-runtime-services，任务 4.3）。
 *
 * worker 的 `PptaskTaskStore.submit` 契约只做 create-if-absent，不比较 payload。协议要求
 * 「相同 key + 相同 payload 复用；相同 key + 不同 payload 稳定拒绝（key-reused）」，因此
 * 在服务层用独立的 durable payload 指纹表来判定，而不是篡改 worker 契约。
 */
import type { DatabaseSync } from "node:sqlite";
import { loadNodeSqlite } from "./sqlite-loader.js";

export type SubmitKeyRecord = {
  workerTaskKey: string;
  payloadHash: string;
  createdAt: string;
};

export class SqliteSubmitKeyRepository {
  private readonly db: DatabaseSync;

  constructor(options: { path: string }) {
    const { DatabaseSync } = loadNodeSqlite();
    this.db = new DatabaseSync(options.path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_submit_keys (
        worker_task_key TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  /**
   * 记录一次 submit。
   *
   * - 首次：写入并返回 `created: true`；
   * - 已有且 hash 相同：`reused: true`（幂等命中）；
   * - 已有且 hash 不同：`conflict: true`（调用方返回 key-reused）。
   */
  claim(workerTaskKey: string, payloadHash: string, now: string): { created: boolean; reused: boolean; conflict: boolean } {
    const existing = this.db
      .prepare("SELECT payload_hash FROM task_submit_keys WHERE worker_task_key = ?")
      .get(workerTaskKey) as { payload_hash: string } | undefined;
    if (existing) {
      if (existing.payload_hash === payloadHash) return { created: false, reused: true, conflict: false };
      return { created: false, reused: false, conflict: true };
    }
    this.db
      .prepare("INSERT INTO task_submit_keys (worker_task_key, payload_hash, created_at) VALUES (?, ?, ?)")
      .run(workerTaskKey, payloadHash, now);
    return { created: true, reused: false, conflict: false };
  }

  get(workerTaskKey: string): SubmitKeyRecord | undefined {
    const row = this.db
      .prepare("SELECT worker_task_key, payload_hash, created_at FROM task_submit_keys WHERE worker_task_key = ?")
      .get(workerTaskKey) as { worker_task_key: string; payload_hash: string; created_at: string } | undefined;
    return row ? { workerTaskKey: row.worker_task_key, payloadHash: row.payload_hash, createdAt: row.created_at } : undefined;
  }

  close(): void {
    this.db.close();
  }
}

export function createSqliteSubmitKeyRepository(options: { path: string }): SqliteSubmitKeyRepository {
  return new SqliteSubmitKeyRepository(options);
}

/**
 * 稳定的 submit payload 指纹（与实现无关的规范化 JSON + 字段顺序无关）。
 *
 * 只包含影响执行的字段：模型、prompt、参数、参考输入、关联 metadata。相同 key 下任一
 * 字段变化都必须判为「不同 payload」。
 */
export function computeSubmitPayloadHash(request: {
  serviceConnection?: { owner: string; serviceConnectionId: string };
  canvasId: string;
  nodeId: string;
  runId: string;
  jobId: string;
  nodeType: string;
  modelType: string;
  modelKey: string;
  prompt: string;
  parameters: Record<string, unknown>;
  inputs: readonly { assetId: string; role: string; storageKey: string; mediaType: string }[];
}): string {
  const canonical = stableStringify({
    ...(request.serviceConnection ? { serviceConnection: request.serviceConnection } : {}),
    canvasId: request.canvasId,
    nodeId: request.nodeId,
    runId: request.runId,
    jobId: request.jobId,
    nodeType: request.nodeType,
    modelType: request.modelType,
    modelKey: request.modelKey,
    prompt: request.prompt,
    parameters: request.parameters,
    inputs: request.inputs
  });
  // 同步确定性的轻量 hash（避免把 Web Crypto 的异步性引入 submit 路径）。
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let index = 0; index < canonical.length; index += 1) {
    const code = canonical.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 16777619) >>> 0;
    h2 = Math.imul(h2 + code, 2246822519) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(",")}}`;
}
