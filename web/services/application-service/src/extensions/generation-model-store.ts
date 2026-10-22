/**
 * 生成模型运营配置存储
 * （change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 1.3/2.2/3.1 / design D2/D3）。
 *
 * 站点级、版本化的模型运营策略（启用/默认/排序/标题/超时/interaction 覆盖/删除 tombstone）。
 * 语义（design D2）：
 * - **未初始化**：尚未写入过任何策略 → 允许幂等导入旧 `pptask.models.json`（空 models = 全开）；
 * - **已初始化**：集合完全由持久化策略决定；**空集合保持关闭**（不自动全开）；
 * - 删除只加 tombstone（保留 identity，不复用 modelKey）；
 * - 更新校验候选：未知 identity / 默认冲突 / 非法字段 MUST 拒绝且保留旧版本；
 * - 每次提交推进单调 revision；`generation_catalog` 由它派生。
 */
import type { DatabaseSync } from "node:sqlite";
import { loadNodeSqlite } from "../repository/sqlite-loader.js";

export type GenerationModelPolicy = {
  modelKey: string;
  enabled: boolean;
  isDefault?: boolean;
  title?: string;
  order?: number;
  taskTimeoutMs?: number;
  interaction?: { id: string; version: number };
  /** 删除 tombstone：保留 identity，不再出现在 catalog，但历史任务仍可引用。 */
  tombstone?: boolean;
};

export type GenerationModelStoreSnapshot = {
  initialized: boolean;
  revision: number;
  models: GenerationModelPolicy[];
};

export type GenerationModelCommitResult =
  | { ok: true; revision: number; models: GenerationModelPolicy[] }
  | { ok: false; code: "revision-conflict"; currentRevision: number }
  | { ok: false; code: "invalid"; message: string };

type PolicyRow = {
  model_key: string;
  enabled: number;
  is_default: number;
  title: string | null;
  order_index: number | null;
  task_timeout_ms: number | null;
  interaction_id: string | null;
  interaction_version: number | null;
  tombstone: number;
};

export class SqliteGenerationModelStore {
  private readonly db: DatabaseSync;

  constructor(options: { path: string }) {
    const { DatabaseSync } = loadNodeSqlite();
    this.db = new DatabaseSync(options.path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS generation_model_policy (
        model_key TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        is_default INTEGER NOT NULL,
        title TEXT,
        order_index INTEGER,
        task_timeout_ms INTEGER,
        interaction_id TEXT,
        interaction_version INTEGER,
        tombstone INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS generation_model_revision (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL,
        initialized INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO generation_model_revision (id, revision, initialized) VALUES (1, 0, 0);
    `);
  }

  revision(): number {
    const row = this.db.prepare("SELECT revision FROM generation_model_revision WHERE id = 1").get() as { revision: number } | undefined;
    return row?.revision ?? 0;
  }

  initialized(): boolean {
    const row = this.db.prepare("SELECT initialized FROM generation_model_revision WHERE id = 1").get() as { initialized: number } | undefined;
    return (row?.initialized ?? 0) === 1;
  }

  snapshot(): GenerationModelStoreSnapshot {
    const rows = this.db.prepare("SELECT * FROM generation_model_policy").all() as PolicyRow[];
    return { initialized: this.initialized(), revision: this.revision(), models: rows.map(toPolicy) };
  }

  /**
   * 带版本检查的原子提交：先校验候选，再写策略、推进 revision。
   * 冲突/非法时保留旧版本（不修改任何持久化状态）。
   */
  commit(input: {
    expectedRevision: number;
    models: readonly GenerationModelPolicy[];
    knownModelKeys: ReadonlySet<string>;
  }): GenerationModelCommitResult {
    // 候选校验（副作用之前）。
    const errors = validateCandidates(input.models, input.knownModelKeys);
    if (errors) return { ok: false, code: "invalid", message: errors };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.revision();
      if (current !== input.expectedRevision) {
        this.db.exec("ROLLBACK");
        return { ok: false, code: "revision-conflict", currentRevision: current };
      }
      this.db.prepare("DELETE FROM generation_model_policy").run();
      for (const model of input.models) this.upsertRow(model);
      const next = current + 1;
      this.db.prepare("UPDATE generation_model_revision SET revision = ?, initialized = 1 WHERE id = 1").run(next);
      this.db.exec("COMMIT");
      return { ok: true, revision: next, models: [...input.models] };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private upsertRow(model: GenerationModelPolicy): void {
    this.db
      .prepare(
        `INSERT INTO generation_model_policy
           (model_key, enabled, is_default, title, order_index, task_timeout_ms, interaction_id, interaction_version, tombstone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        model.modelKey,
        model.enabled ? 1 : 0,
        model.isDefault ? 1 : 0,
        model.title ?? null,
        model.order ?? null,
        model.taskTimeoutMs ?? null,
        model.interaction?.id ?? null,
        model.interaction?.version ?? null,
        model.tombstone ? 1 : 0
      );
  }

  close(): void {
    this.db.close();
  }
}

/** 候选校验：未知 identity、重复 modelKey、多个默认（每类型由 catalog 侧再定）都拒绝。 */
function validateCandidates(models: readonly GenerationModelPolicy[], known: ReadonlySet<string>): string | null {
  const seen = new Set<string>();
  for (const model of models) {
    if (typeof model.modelKey !== "string" || model.modelKey === "") return "modelKey 必须是非空字符串";
    if (seen.has(model.modelKey)) return `重复 modelKey：${model.modelKey}`;
    seen.add(model.modelKey);
    if (!model.tombstone && !known.has(model.modelKey)) return `未知模型 identity：${model.modelKey}`;
    if (typeof model.enabled !== "boolean") return `modelKey ${model.modelKey} 的 enabled 必须是布尔值`;
    if (model.order !== undefined && (!Number.isInteger(model.order) || model.order < 0)) return `modelKey ${model.modelKey} 的 order 非法`;
  }
  return null;
}

function toPolicy(row: PolicyRow): GenerationModelPolicy {
  return {
    modelKey: row.model_key,
    enabled: row.enabled === 1,
    ...(row.is_default === 1 ? { isDefault: true } : {}),
    ...(row.title !== null ? { title: row.title } : {}),
    ...(row.order_index !== null ? { order: row.order_index } : {}),
    ...(row.task_timeout_ms !== null ? { taskTimeoutMs: row.task_timeout_ms } : {}),
    ...(row.interaction_id !== null && row.interaction_version !== null
      ? { interaction: { id: row.interaction_id, version: row.interaction_version } }
      : {}),
    ...(row.tombstone === 1 ? { tombstone: true } : {})
  };
}

export function createSqliteGenerationModelStore(options: { path: string }): SqliteGenerationModelStore {
  return new SqliteGenerationModelStore(options);
}
