import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { InstanceDataScope } from "@woohaa3/contracts";
import { loadNodeSqlite } from "./sqlite-loader.js";

export type InstanceScopeMigration = {
  /** 部署侧明确指定的旧源路径；不能来自业务请求。 */
  sourceStorePath: string;
  /** 枚举并校验旧记录的宿主适配器；不能把猜测的路径 hash 当作存在证明。 */
  verifiedSubjects: readonly string[];
};

/** 只供版本 1 的旧数据定位使用，不建立应用身份。 */
export function legacyLocalDataOwner(storePath: string): string {
  return `local:${createHash("sha256").update(path.resolve(storePath)).digest("hex").slice(0, 24)}`;
}

/** 与 Application 数据一起持久保存；目录移动后只读记录，不重新计算 owner。 */
export function openInstanceDataScope(storePath: string, migration?: InstanceScopeMigration): InstanceDataScope {
  fs.mkdirSync(path.dirname(path.resolve(storePath)), { recursive: true });
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(storePath);
  try {
    const existingTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='application_instance_scope'").get();
    if (existingTable) {
      const row = db.prepare("SELECT version, id, owner_id, credential_owner_id FROM application_instance_scope WHERE singleton=1").get() as
        { version: number; id: string; owner_id: string; credential_owner_id: string } | undefined;
      if (!row || row.version !== 1 || !row.id || !row.owner_id || !row.credential_owner_id) throw new Error("实例归属版本未知或记录损坏");
      if (migration && (new Set(migration.verifiedSubjects).size !== 1 || row.owner_id !== migration.verifiedSubjects[0] || row.owner_id !== legacyLocalDataOwner(migration.sourceStorePath))) throw new Error("实例归属已固定，不能改绑旧空间");
      return Object.freeze({ kind: "instance", id: row.id, ownerId: row.owner_id, credentialOwnerId: row.credential_owner_id });
    }
    const hasConversations = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_conversations'").get();
    const localOwners = hasConversations
      ? (db.prepare("SELECT DISTINCT owner FROM agent_conversations WHERE owner GLOB 'local:*'").all() as Array<{ owner: string }>).map(row => row.owner)
      : [];
    if (localOwners.length && !migration) throw new Error("存在旧本机记录，需要指定并核验唯一来源");
    let legacyOwner: string | undefined;
    if (migration) {
      const subjects = [...new Set(migration.verifiedSubjects)];
      if (subjects.length !== 1 || subjects[0] !== legacyLocalDataOwner(migration.sourceStorePath)) throw new Error("旧数据归属不明确，需要指定并核验唯一来源");
      if (localOwners.some(owner => owner !== subjects[0])) throw new Error("旧数据存在多个归属，需要显式迁移");
      legacyOwner = subjects[0];
    }
    // VACUUM INTO 是一致的 SQLite 快照，包含 WAL 中尚未 checkpoint 的数据。
    // 固定备份名不覆盖第一次备份，迁移失败后仍可回退。
    const backupPath = `${path.resolve(storePath)}.before-instance-scope-v1.sqlite`;
    if (!fs.existsSync(backupPath)) {
      db.prepare("VACUUM INTO ?").run(backupPath);
      fs.chmodSync(backupPath, 0o600);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TABLE application_instance_scope (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, id TEXT NOT NULL, owner_id TEXT NOT NULL, credential_owner_id TEXT NOT NULL)");
      const id = `instance:${randomUUID()}`;
      const ownerId = legacyOwner ?? id;
      const credentialOwnerId = legacyOwner ? `principal:${legacyOwner}` : id;
      db.prepare("INSERT INTO application_instance_scope VALUES (1, 1, ?, ?, ?)").run(id, ownerId, credentialOwnerId);
      db.exec("COMMIT");
      return Object.freeze({ kind: "instance", id, ownerId, credentialOwnerId });
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}

/** 宿主读取持久记录核验旧来源；不从浏览器会话推断。 */
export function verifiedLegacyInstanceMigration(
  storePath: string,
  input: { sourceStorePath?: string; hasCredential?: (credentialOwnerId: string) => boolean } = {}
): InstanceScopeMigration | undefined {
  const sourceStorePath = input.sourceStorePath ?? storePath;
  const subject = legacyLocalDataOwner(sourceStorePath);
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(storePath);
  try {
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='application_instance_scope'").get()) return undefined;
    const hasConversations = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_conversations'").get();
    const owners = hasConversations
      ? (db.prepare("SELECT DISTINCT owner FROM agent_conversations WHERE owner GLOB 'local:*'").all() as Array<{ owner: string }>).map(row => row.owner)
      : [];
    if (owners.some(owner => owner !== subject)) throw new Error("旧会话归属与源路径不符，需要显式指定唯一来源");
    const hasCredential = input.hasCredential?.(`principal:${subject}`) ?? false;
    if (!owners.length && !hasCredential) {
      if (input.sourceStorePath) throw new Error("指定源没有可核验的旧记录");
      return undefined;
    }
    return { sourceStorePath, verifiedSubjects: [subject] };
  } finally { db.close(); }
}
