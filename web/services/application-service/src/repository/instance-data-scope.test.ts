import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createApplicationSecretStoreForExtension } from "../secrets/store.js";
import { afterEach, describe, expect, it } from "vitest";
import { legacyLocalDataOwner, openInstanceDataScope, verifiedLegacyInstanceMigration } from "./instance-data-scope.js";
import { loadNodeSqlite } from "./sqlite-loader.js";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instance-scope-"));
  roots.push(root);
  return { root, store: path.join(root, "application.sqlite") };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("instance data scope persistence", () => {
  it("重启、复制及移动数据目录后不重算空间或 owner", () => {
    const { root, store } = fixture();
    const first = openInstanceDataScope(store);
    expect(first.kind).toBe("instance");
    expect(first.id).toMatch(/^instance:/);
    expect(openInstanceDataScope(store)).toEqual(first);
    const moved = path.join(root, "moved.sqlite");
    fs.renameSync(store, moved);
    expect(openInstanceDataScope(moved)).toEqual(first);
  });
  it("核验后的旧 owner 保留凭据 AAD 与会话键，备份可回退且迁移幂等", () => {
    const { store } = fixture();
    const { DatabaseSync } = loadNodeSqlite();
    const db = new DatabaseSync(store);
    db.exec("CREATE TABLE original(value TEXT); INSERT INTO original VALUES ('kept')");
    db.close();
    const subject = legacyLocalDataOwner(store);
    const migration = { sourceStorePath: store, verifiedSubjects: [subject] };
    const scope = openInstanceDataScope(store, migration);
    expect(scope.ownerId).toBe(subject);
    expect(scope.credentialOwnerId).toBe(`principal:${subject}`);
    const backup = fs.readFileSync(`${store}.before-instance-scope-v1.sqlite`);
    expect(openInstanceDataScope(store, migration)).toEqual(scope);
    expect(fs.readFileSync(`${store}.before-instance-scope-v1.sqlite`)).toEqual(backup);
    const restored = new DatabaseSync(`${store}.before-instance-scope-v1.sqlite`);
    expect(restored.prepare("SELECT value FROM original").get()).toEqual({ value: "kept" });
    expect(restored.prepare("SELECT name FROM sqlite_master WHERE name='application_instance_scope'").get()).toBeUndefined();
    restored.close();
  });
  it("空候选、多个候选、移动前未迁移或旧浏览器会话不能猜测接管", () => {
    const { store } = fixture();
    const subject = legacyLocalDataOwner(store);
    for (const verifiedSubjects of [[], [subject, 'local:other'], ['local:browser-session'], ['enterprise-user']]) {
      expect(() => openInstanceDataScope(store, { sourceStorePath: store, verifiedSubjects })).toThrow("归属不明确");
    }
    expect(() => openInstanceDataScope(store, { sourceStorePath: `${store}.moved`, verifiedSubjects: [subject] })).toThrow("归属不明确");
  });
  it("固定后的空间不能重新绑定另一来源", () => {
    const { store } = fixture();
    openInstanceDataScope(store);
    expect(() => openInstanceDataScope(store, { sourceStorePath: store, verifiedSubjects: [legacyLocalDataOwner(store)] })).toThrow("不能改绑");
  });
});

it("未迁移的旧会话不会静默换成新的实例 owner", () => {
  const { store } = fixture();
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(store);
  db.exec("CREATE TABLE agent_conversations(owner TEXT); INSERT INTO agent_conversations VALUES ('local:unverified')");
  db.close();
  expect(() => openInstanceDataScope(store)).toThrow("需要指定并核验唯一来源");
  expect(() => openInstanceDataScope(store, { sourceStorePath: store, verifiedSubjects: [legacyLocalDataOwner(store)] })).toThrow("多个归属");
});

it("备份包含 WAL 中已提交的记录", () => {
  const { store } = fixture();
  const { DatabaseSync } = loadNodeSqlite();
  const writer = new DatabaseSync(store);
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE original(value TEXT); INSERT INTO original VALUES ('wal-record')");
  try {
    openInstanceDataScope(store);
    const backup = new DatabaseSync(`${store}.before-instance-scope-v1.sqlite`);
    try { expect(backup.prepare("SELECT value FROM original").get()).toEqual({ value: "wal-record" }); }
    finally { backup.close(); }
  } finally { writer.close(); }
});


it("兼容别名恢复真实加密记录，目录移动与企业空间不会改变归属", () => {
  const { root, store } = fixture();
  const owner = legacyLocalDataOwner(store);
  const masterKey = randomBytes(32);
  const directory = path.join(root, "credentials");
  const secrets = createApplicationSecretStoreForExtension({ directory, masterKey, extensionId: "chatgpt" });
  secrets.write(`principal:${owner}`, "oauth", { accessToken: "fixture-token" }, { version: 0 });
  const scope = openInstanceDataScope(store, { sourceStorePath: store, verifiedSubjects: [owner] });
  expect(secrets.read<{ accessToken: string }>(scope.credentialOwnerId, "oauth")?.value.accessToken).toBe("fixture-token");
  const movedStore = path.join(root, "renamed.sqlite");
  const movedCredentials = path.join(root, "moved-credentials");
  fs.renameSync(store, movedStore);
  fs.renameSync(directory, movedCredentials);
  const reopened = openInstanceDataScope(movedStore);
  const restored = createApplicationSecretStoreForExtension({ directory: movedCredentials, masterKey, extensionId: "chatgpt" });
  expect(reopened).toEqual(scope);
  expect(restored.read<{ accessToken: string }>(reopened.credentialOwnerId, "oauth")?.value.accessToken).toBe("fixture-token");
  expect(restored.read("principal:first-enterprise-user", "oauth")).toBeNull();
  expect(restored.read("local:old-browser-session", "oauth")).toBeNull();
});

it("宿主自动核验当前路径的 ledger，移动前未迁移时要求显式源", () => {
  const { store, root } = fixture();
  const { DatabaseSync } = loadNodeSqlite();
  const old = legacyLocalDataOwner(store);
  const db = new DatabaseSync(store);
  db.exec("CREATE TABLE agent_conversations(owner TEXT)");
  db.prepare("INSERT INTO agent_conversations VALUES (?)").run(old);
  db.close();
  expect(verifiedLegacyInstanceMigration(store)?.verifiedSubjects).toEqual([old]);
  const moved = path.join(root, "moved.sqlite");
  fs.renameSync(store, moved);
  expect(() => verifiedLegacyInstanceMigration(moved)).toThrow("显式指定");
  const migration = verifiedLegacyInstanceMigration(moved, { sourceStorePath: store });
  const scope = openInstanceDataScope(moved, migration);
  expect(scope.ownerId).toBe(old);
  expect(verifiedLegacyInstanceMigration(moved)).toBeUndefined();
});
it("仅真实存在的旧凭据可建立别名，旧浏览器 session 不作为候选", () => {
  const { store } = fixture();
  expect(verifiedLegacyInstanceMigration(store, { hasCredential: () => false })).toBeUndefined();
  const expected = `principal:${legacyLocalDataOwner(store)}`;
  const migration = verifiedLegacyInstanceMigration(store, { hasCredential: key => key === expected });
  expect(openInstanceDataScope(store, migration).credentialOwnerId).toBe(expected);
});
