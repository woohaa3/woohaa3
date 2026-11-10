/**
 * 持久工具 grant registry 的存储（change: 2026-11-10-split-agent-runtime-lifecycle，任务 2.2）。
 *
 * 工具 grant 原先只存在宿主进程内存：宿主重启后，执行器 journal 里仍在跑的回合再调用
 * `tools.*` 就会失败。这里把 token、subject、workId、范围与撤销状态写进应用库；内存 Map
 * 只作缓存。撤销写库后立即从缓存移除，重启后也不会复活。
 */
import type { DatabaseSync } from "node:sqlite";
import type { ApplicationToolGrant } from "@woohaa3/contracts";
/** 后端自有 sqlite 入口；不从 Application 服务借，避免测试 mock 该模块时缺导出。 */
function loadNodeSqlite(): { DatabaseSync: new (path: string) => DatabaseSync } {
  return process.getBuiltinModule("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
}

export type PersistedToolGrant = {
  grant: ApplicationToolGrant;
  subject: string;
  revokedAt: string | null;
};

type GrantRow = {
  token: string;
  subject: string;
  work_id: string;
  canvas_ids_json: string;
  node_ids_json: string;
  tools_json: string;
  camera_id: string | null;
  group_scope_json: string | null;
  credential_epoch: number | null;
  created_at: string;
  revoked_at: string | null;
};

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value as string[] : [];

function decode(row: GrantRow): PersistedToolGrant | null {
  try {
    const canvasIds = stringArray(JSON.parse(row.canvas_ids_json));
    const nodeIds = stringArray(JSON.parse(row.node_ids_json));
    const tools = stringArray(JSON.parse(row.tools_json));
    const groupScope = row.group_scope_json ? JSON.parse(row.group_scope_json) as ApplicationToolGrant["groupScope"] : undefined;
    return {
      subject: row.subject,
      revokedAt: row.revoked_at,
      grant: {
        token: row.token,
        canvasIds,
        nodeIds,
        tools,
        workId: row.work_id,
        ...(row.camera_id ? { cameraId: row.camera_id } : {}),
        ...(groupScope ? { groupScope } : {}),
        ...(row.credential_epoch !== null ? { credentialEpoch: row.credential_epoch } : {})
      }
    };
  } catch {
    return null;
  }
}

export type ToolGrantStore = {
  load(): PersistedToolGrant[];
  put(grant: ApplicationToolGrant, subject: string): void;
  revoke(workId: string, subject: string | undefined, now: string): string[];
  revokeToken(token: string, now: string): void;
  close(): void;
};

export class SqliteToolGrantStore implements ToolGrantStore {
  private readonly db: DatabaseSync;

  constructor(options: { path: string }) {
    const { DatabaseSync } = loadNodeSqlite();
    this.db = new DatabaseSync(options.path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_grants (
        token TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        work_id TEXT NOT NULL,
        canvas_ids_json TEXT NOT NULL,
        node_ids_json TEXT NOT NULL,
        tools_json TEXT NOT NULL,
        camera_id TEXT,
        group_scope_json TEXT,
        credential_epoch INTEGER,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS tool_grants_work ON tool_grants(work_id, subject);
    `);
  }

  load(): PersistedToolGrant[] {
    const rows = this.db.prepare("SELECT * FROM tool_grants").all() as GrantRow[];
    return rows.map(decode).filter((entry): entry is PersistedToolGrant => entry !== null);
  }

  put(grant: ApplicationToolGrant, subject: string): void {
    this.db.prepare(`
      INSERT INTO tool_grants
        (token, subject, work_id, canvas_ids_json, node_ids_json, tools_json, camera_id, group_scope_json, credential_epoch, created_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(token) DO UPDATE SET
        subject = excluded.subject,
        work_id = excluded.work_id,
        canvas_ids_json = excluded.canvas_ids_json,
        node_ids_json = excluded.node_ids_json,
        tools_json = excluded.tools_json,
        camera_id = excluded.camera_id,
        group_scope_json = excluded.group_scope_json,
        credential_epoch = excluded.credential_epoch,
        revoked_at = NULL`)
      .run(
        grant.token,
        subject,
        grant.workId,
        JSON.stringify([...grant.canvasIds]),
        JSON.stringify([...grant.nodeIds]),
        JSON.stringify([...grant.tools]),
        grant.cameraId ?? null,
        grant.groupScope ? JSON.stringify(grant.groupScope) : null,
        grant.credentialEpoch ?? null,
        new Date().toISOString()
      );
  }

  revoke(workId: string, subject: string | undefined, now: string): string[] {
    const rows = this.db.prepare("SELECT token FROM tool_grants WHERE work_id = ? AND revoked_at IS NULL AND (? IS NULL OR subject = ?)")
      .all(workId, subject ?? null, subject ?? null) as Array<{ token: string }>;
    const statement = this.db.prepare("UPDATE tool_grants SET revoked_at = ? WHERE work_id = ? AND revoked_at IS NULL AND (? IS NULL OR subject = ?)");
    statement.run(now, workId, subject ?? null, subject ?? null);
    return rows.map((row) => row.token);
  }

  revokeToken(token: string, now: string): void {
    this.db.prepare("UPDATE tool_grants SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL").run(now, token);
  }

  close(): void {
    this.db.close();
  }
}

export function createSqliteToolGrantStore(options: { path: string }): SqliteToolGrantStore {
  return new SqliteToolGrantStore(options);
}

/** 纯内存实现（测试或没有可用库路径的独立入口）。 */
export function createMemoryToolGrantStore(): ToolGrantStore {
  const grants = new Map<string, PersistedToolGrant>();
  return {
    load: () => [...grants.values()],
    put(grant, subject) {
      grants.set(grant.token, { grant, subject, revokedAt: null });
    },
    revoke(workId, subject, now) {
      const tokens: string[] = [];
      for (const [token, entry] of grants) {
        if (entry.grant.workId !== workId || entry.revokedAt !== null) continue;
        if (subject !== undefined && entry.subject !== subject) continue;
        entry.revokedAt = now;
        tokens.push(token);
      }
      return tokens;
    },
    revokeToken(token, now) {
      const entry = grants.get(token);
      if (entry) entry.revokedAt = now;
    },
    close() { grants.clear(); }
  };
}
