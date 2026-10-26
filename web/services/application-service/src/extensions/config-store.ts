/**
 * 站点插件配置持久化与审计（change: 2026-10-04-add-backend-plugin-extensions，任务 3.1 / design D3）。
 *
 * 独立于 Canvas Y.Doc / Task history / 前端 localStorage 的配置表：
 * - `extension_site_config`：每插件的目标 enabled、非秘密 values、secret reference、configVersion；
 * - `extension_site_revision`：全局单调 revision（单行）；
 * - `extension_site_actual`：提交后的实际状态与安全诊断（重启 reconcile 依据）；
 * - `extension_site_audit`：操作者、插件、版本与安全变更摘要。
 *
 * 提交以版本检查为权威：`expectedRevision` 不匹配返回冲突且**不修改**任何持久化状态。
 * 秘密值永不落库：只保存 opaque secret reference。
 */
import type { DatabaseSync } from "node:sqlite";
import type {
  ApplicationExtensionActualState,
  ApplicationExtensionSafeDiagnostic
} from "@woohaa3/contracts";
import { loadNodeSqlite } from "../repository/sqlite-loader.js";

export type SiteExtensionConfigRecord = {
  extensionId: string;
  desiredEnabled: boolean;
  values: Record<string, unknown>;
  secretRefs: string[];
  configVersion: number;
  updatedAt: string;
};

export type SiteExtensionActualRecord = {
  extensionId: string;
  actualState: ApplicationExtensionActualState;
  diagnostics: ApplicationExtensionSafeDiagnostic[];
  updatedAt: string;
};

/** 安全审计摘要：绝不含秘密值或配置正文。 */
export type SiteExtensionAuditSummary = {
  enabled: boolean;
  secretRefCount: number;
  valueKeys: string[];
  /**
   * 非配置提交的运维事件（change: 2026-10-21-isolate-extension-host-process，D7）：崩溃熔断进入 / 解除隔离。
   * 配置提交的审计没有此字段。
   */
  event?: "quarantined" | "unquarantined";
  /** 事件的安全诊断码（如 `crash-loop`）。 */
  diagnosticCode?: string;
};

export type SiteExtensionAuditRecord = {
  sequence: number;
  extensionId: string;
  actor: string;
  fromRevision: number;
  toRevision: number;
  configVersion: number;
  summary: SiteExtensionAuditSummary;
  occurredAt: string;
};

export type SiteExtensionConfigSnapshot = {
  revision: number;
  configs: SiteExtensionConfigRecord[];
};

export type SiteExtensionCommitInput = {
  expectedRevision: number;
  extensionId: string;
  enabled: boolean;
  values: Record<string, unknown>;
  secretRefs: string[];
  actor: string;
  now: string;
};

export type SiteExtensionCommitResult =
  | { ok: true; revision: number; config: SiteExtensionConfigRecord; audit: SiteExtensionAuditRecord }
  | { ok: false; code: "revision-conflict"; currentRevision: number };

type ConfigRow = {
  extension_id: string;
  desired_enabled: number;
  values_json: string;
  secret_refs_json: string;
  config_version: number;
  updated_at: string;
};

type ActualRow = {
  extension_id: string;
  actual_state: string;
  diagnostics_json: string;
  updated_at: string;
};

type AuditRow = {
  sequence: number;
  extension_id: string;
  actor: string;
  from_revision: number;
  to_revision: number;
  config_version: number;
  summary_json: string;
  occurred_at: string;
};

/**
 * 站点扩展标识迁移别名：`oauth-agent` → 旧 `chatgpt`（change: 2026-10-16-...，任务 9.3）。
 * 站点配置按 extensionId 存储，迁移只做读回退，不物理重写行。
 */
const LEGACY_EXTENSION_ID_ALIASES: Readonly<Record<string, string>> = { "oauth-agent": "chatgpt" };

export class SqliteSiteExtensionConfigStore {
  private readonly db: DatabaseSync;

  constructor(options: { path: string }) {
    const { DatabaseSync } = loadNodeSqlite();
    this.db = new DatabaseSync(options.path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS extension_site_config (
        extension_id TEXT PRIMARY KEY,
        desired_enabled INTEGER NOT NULL,
        values_json TEXT NOT NULL,
        secret_refs_json TEXT NOT NULL,
        config_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS extension_site_config_version (
        extension_id TEXT NOT NULL,
        config_version INTEGER NOT NULL,
        desired_enabled INTEGER NOT NULL,
        values_json TEXT NOT NULL,
        secret_refs_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (extension_id, config_version)
      );
      CREATE TABLE IF NOT EXISTS extension_site_revision (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS extension_site_actual (
        extension_id TEXT PRIMARY KEY,
        actual_state TEXT NOT NULL,
        diagnostics_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS extension_site_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        extension_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        from_revision INTEGER NOT NULL,
        to_revision INTEGER NOT NULL,
        config_version INTEGER NOT NULL,
        summary_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS extension_site_audit_plugin
        ON extension_site_audit(extension_id, sequence);
      CREATE TABLE IF NOT EXISTS extension_site_status_log (
        revision INTEGER NOT NULL,
        extension_id TEXT NOT NULL,
        PRIMARY KEY (revision, extension_id)
      );
      INSERT OR IGNORE INTO extension_site_revision (id, revision) VALUES (1, 0);
    `);
  }

  revision(): number {
    const row = this.db.prepare("SELECT revision FROM extension_site_revision WHERE id = 1").get() as
      | { revision: number }
      | undefined;
    return row?.revision ?? 0;
  }

  /** 推进全局 revision（目标/实际状态/公开计数变化都调用）。 */
  bumpRevision(): number {
    const next = this.revision() + 1;
    this.db.prepare("UPDATE extension_site_revision SET revision = ? WHERE id = 1").run(next);
    return next;
  }

  /** 记录某 revision 下发生变化的插件；用于 changes 增量。 */
  private recordStatusChange(revision: number, extensionId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO extension_site_status_log (revision, extension_id) VALUES (?, ?)")
      .run(revision, extensionId);
  }

  /** 自 after 起发生变化的 extensionId（有界）。 */
  changedExtensionIdsSince(after: number): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT extension_id FROM extension_site_status_log WHERE revision > ? ORDER BY extension_id ASC")
      .all(after) as Array<{ extension_id: string }>;
    return rows.map((row) => row.extension_id);
  }

  snapshot(): SiteExtensionConfigSnapshot {
    const rows = this.db
      .prepare(
        `SELECT extension_id, desired_enabled, values_json, secret_refs_json, config_version, updated_at
           FROM extension_site_config ORDER BY extension_id ASC`
      )
      .all() as ConfigRow[];
    return { revision: this.revision(), configs: rows.map(toConfig) };
  }

  get(extensionId: string): SiteExtensionConfigRecord | undefined {
    const select = this.db.prepare(
      `SELECT extension_id, desired_enabled, values_json, secret_refs_json, config_version, updated_at
         FROM extension_site_config WHERE extension_id = ?`
    );
    const row = select.get(extensionId) as ConfigRow | undefined;
    if (row) return toConfig(row);
    // 扩展标识迁移（任务 9.3 / design D11）：`oauth-agent` 无自身行时回退读旧 `chatgpt` 行，
    // 以新标识返回（不物理重写；下次提交落到新标识，回退安全）。
    const legacyId = LEGACY_EXTENSION_ID_ALIASES[extensionId];
    if (!legacyId) return undefined;
    const legacy = select.get(legacyId) as ConfigRow | undefined;
    return legacy ? { ...toConfig(legacy), extensionId } : undefined;
  }

  /**
   * 带版本检查的原子提交：先校验 revision，再在同一事务写配置、推进 revision 与审计。
   * 冲突时不修改任何持久化状态（spec「并发修改保留较新配置」）。
   */
  commit(input: SiteExtensionCommitInput): SiteExtensionCommitResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.revision();
      if (current !== input.expectedRevision) {
        this.db.exec("ROLLBACK");
        return { ok: false, code: "revision-conflict", currentRevision: current };
      }
      const existing = this.get(input.extensionId);
      const configVersion = (existing?.configVersion ?? 0) + 1;
      const nextRevision = current + 1;
      this.db
        .prepare(
          `INSERT INTO extension_site_config
             (extension_id, desired_enabled, values_json, secret_refs_json, config_version, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(extension_id) DO UPDATE SET
             desired_enabled = excluded.desired_enabled,
             values_json = excluded.values_json,
             secret_refs_json = excluded.secret_refs_json,
             config_version = excluded.config_version,
             updated_at = excluded.updated_at`
        )
        .run(
          input.extensionId,
          input.enabled ? 1 : 0,
          JSON.stringify(input.values),
          JSON.stringify(input.secretRefs),
          configVersion,
          input.now
        );
      // 不可变配置快照：被旧版本工作引用的配置必须在提交后仍可读（design D6）。
      this.db
        .prepare(
          `INSERT INTO extension_site_config_version
             (extension_id, config_version, desired_enabled, values_json, secret_refs_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(extension_id, config_version) DO UPDATE SET
             desired_enabled = excluded.desired_enabled,
             values_json = excluded.values_json,
             secret_refs_json = excluded.secret_refs_json,
             updated_at = excluded.updated_at`
        )
        .run(
          input.extensionId,
          configVersion,
          input.enabled ? 1 : 0,
          JSON.stringify(input.values),
          JSON.stringify(input.secretRefs),
          input.now
        );
      this.db.prepare("UPDATE extension_site_revision SET revision = ? WHERE id = 1").run(nextRevision);
      const summary: SiteExtensionAuditSummary = {
        enabled: input.enabled,
        secretRefCount: input.secretRefs.length,
        valueKeys: Object.keys(input.values).sort()
      };
      const insert = this.db
        .prepare(
          `INSERT INTO extension_site_audit
             (extension_id, actor, from_revision, to_revision, config_version, summary_json, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(input.extensionId, input.actor, current, nextRevision, configVersion, JSON.stringify(summary), input.now);
      this.db.exec("COMMIT");
      const config: SiteExtensionConfigRecord = {
        extensionId: input.extensionId,
        desiredEnabled: input.enabled,
        values: input.values,
        secretRefs: input.secretRefs,
        configVersion,
        updatedAt: input.now
      };
      return {
        ok: true,
        revision: nextRevision,
        config,
        audit: {
          sequence: Number(insert.lastInsertRowid),
          extensionId: input.extensionId,
          actor: input.actor,
          fromRevision: current,
          toRevision: nextRevision,
          configVersion,
          summary,
          occurredAt: input.now
        }
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setActual(extensionId: string, actualState: ApplicationExtensionActualState, diagnostics: ApplicationExtensionSafeDiagnostic[], now: string): void {
    // 实际状态/诊断变化推进 revision（design D6：不能只依赖管理员配置审计）。
    this.db
      .prepare(
        `INSERT INTO extension_site_actual (extension_id, actual_state, diagnostics_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(extension_id) DO UPDATE SET
           actual_state = excluded.actual_state,
           diagnostics_json = excluded.diagnostics_json,
           updated_at = excluded.updated_at`
      )
      .run(extensionId, actualState, JSON.stringify(diagnostics), now);
    const revision = this.bumpRevision();
    this.recordStatusChange(revision, extensionId);
  }

  /**
   * 记录一条运维事件审计（不改配置、不新建配置版本）：推进 revision 并写 status log，
   * 让 `changes(after)` 与前端刷新看到它。返回新 revision。
   */
  recordEvent(input: {
    extensionId: string;
    actor: string;
    event: NonNullable<SiteExtensionAuditSummary["event"]>;
    diagnosticCode?: string;
    now: string;
  }): number {
    const current = this.revision();
    const config = this.get(input.extensionId);
    const revision = this.bumpRevision();
    const summary: SiteExtensionAuditSummary = {
      enabled: config?.desiredEnabled ?? false,
      secretRefCount: config?.secretRefs.length ?? 0,
      valueKeys: Object.keys(config?.values ?? {}).sort(),
      event: input.event,
      ...(input.diagnosticCode ? { diagnosticCode: input.diagnosticCode } : {})
    };
    this.db
      .prepare(
        `INSERT INTO extension_site_audit
           (extension_id, actor, from_revision, to_revision, config_version, summary_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.extensionId, input.actor, current, revision, config?.configVersion ?? 0, JSON.stringify(summary), input.now);
    this.recordStatusChange(revision, input.extensionId);
    return revision;
  }

  /** 读取某插件的不可变配置版本快照（被旧版本工作引用时仍可读）。 */
  getVersion(extensionId: string, configVersion: number): SiteExtensionConfigRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT extension_id, desired_enabled, values_json, secret_refs_json, config_version, updated_at
           FROM extension_site_config_version WHERE extension_id = ? AND config_version = ?`
      )
      .get(extensionId, configVersion) as ConfigRow | undefined;
    return row ? toConfig(row) : undefined;
  }

  /** 列出某插件保留的全部配置版本（升序）。 */
  listVersions(extensionId: string): SiteExtensionConfigRecord[] {
    const rows = this.db
      .prepare(
        `SELECT extension_id, desired_enabled, values_json, secret_refs_json, config_version, updated_at
           FROM extension_site_config_version WHERE extension_id = ? ORDER BY config_version ASC`
      )
      .all(extensionId) as ConfigRow[];
    return rows.map(toConfig);
  }

  actual(extensionId: string): SiteExtensionActualRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT extension_id, actual_state, diagnostics_json, updated_at
           FROM extension_site_actual WHERE extension_id = ?`
      )
      .get(extensionId) as ActualRow | undefined;
    return row
      ? {
          extensionId: row.extension_id,
          actualState: row.actual_state as ApplicationExtensionActualState,
          diagnostics: JSON.parse(row.diagnostics_json) as ApplicationExtensionSafeDiagnostic[],
          updatedAt: row.updated_at
        }
      : undefined;
  }

  audit(extensionId: string, limit = 100): SiteExtensionAuditRecord[] {
    const rows = this.db
      .prepare(
        `SELECT sequence, extension_id, actor, from_revision, to_revision, config_version, summary_json, occurred_at
           FROM extension_site_audit WHERE extension_id = ? ORDER BY sequence DESC LIMIT ?`
      )
      .all(extensionId, limit) as AuditRow[];
    return rows.map((row) => ({
      sequence: row.sequence,
      extensionId: row.extension_id,
      actor: row.actor,
      fromRevision: row.from_revision,
      toRevision: row.to_revision,
      configVersion: row.config_version,
      summary: JSON.parse(row.summary_json) as SiteExtensionAuditSummary,
      occurredAt: row.occurred_at
    }));
  }

  close(): void {
    this.db.close();
  }
}

function toConfig(row: ConfigRow): SiteExtensionConfigRecord {
  return {
    extensionId: row.extension_id,
    desiredEnabled: row.desired_enabled === 1,
    values: JSON.parse(row.values_json) as Record<string, unknown>,
    secretRefs: JSON.parse(row.secret_refs_json) as string[],
    configVersion: row.config_version,
    updatedAt: row.updated_at
  };
}

export function createSqliteSiteExtensionConfigStore(options: { path: string }): SqliteSiteExtensionConfigStore {
  return new SqliteSiteExtensionConfigStore(options);
}
