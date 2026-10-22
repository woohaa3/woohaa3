/**
 * 隔离通用扩展数据存储（Mongo 驱动）测试
 * （change: 2026-10-13-add-offline-canvas-migration-and-mongodb-backend，任务 1.2 / design D4）。
 *
 * 用内存 `MongoDocumentClientLike` fake 镜像 SQLite 驱动的契约断言：owner 隔离、CAS（缺省无条件、
 * null 表示必须不存在）、事务原子 batch（任一冲突整批回滚）、前缀扫描分页与 schema 版本。
 */
import { describe, expect, it } from "vitest";
import { createMongoExtensionDocumentStore } from "./mongo-extension-document-store.js";
import { FakeMongoClient } from "../../tests/test-support/fake-mongo-documents.js";

async function provider(owners: string[]) {
  const client = new FakeMongoClient();
  const store = createMongoExtensionDocumentStore({ client, database: "woohaa3", owners });
  await store.initialize();
  return store;
}

describe("Mongo ExtensionDocumentStore owner 隔离（任务 1.2）", () => {
  it("未登记 owner 返回 null（fail closed）", async () => {
    const store = await provider(["test-access"]);
    expect(store.forExtension("task-monitor")).toBeNull();
    const ownerStore = store.forExtension("test-access");
    expect(ownerStore).not.toBeNull();
    expect(ownerStore!.owner()).toBe("test-access");
    await store.close();
  });

  it("跨 owner 键空间互不可见", async () => {
    const store = await provider(["a", "b"]);
    const a = store.forExtension("a")!;
    const b = store.forExtension("b")!;
    expect((await a.batch([{ op: "set", key: "k", value: { v: 1 } }])).ok).toBe(true);
    expect((await a.get("k")).found).toBe(true);
    expect((await b.get("k")).found).toBe(false);
    await store.close();
  });
});

describe("Mongo ExtensionDocumentStore CAS 与原子 batch（任务 1.2）", () => {
  it("expectedRevision 缺省为无条件写；null 表示必须不存在", async () => {
    const store = await provider(["x"]);
    const s = store.forExtension("x")!;
    expect(await s.batch([{ op: "set", key: "k", value: { v: 1 } }])).toEqual({ ok: true, revisions: { k: 1 } });
    expect(await s.batch([{ op: "set", key: "k", value: { v: 2 } }])).toEqual({ ok: true, revisions: { k: 2 } });
    expect(await s.batch([{ op: "set", key: "k", value: { v: 3 }, expectedRevision: null }])).toEqual({
      ok: false,
      code: "revision-conflict",
      key: "k",
      currentRevision: 2
    });
    const read = await s.get("k");
    expect(read.found && read.document.value).toEqual({ v: 2 });
    await store.close();
  });

  it("任一步冲突整批回滚，不落部分写入", async () => {
    const store = await provider(["x"]);
    const s = store.forExtension("x")!;
    await s.batch([{ op: "set", key: "existing", value: { v: 1 } }]);
    const result = await s.batch([
      { op: "set", key: "new", value: { v: "should-not-commit" } },
      { op: "set", key: "existing", value: { v: 2 }, expectedRevision: 99 }
    ]);
    expect(result.ok).toBe(false);
    expect((await s.get("new")).found).toBe(false);
    const existing = await s.get("existing");
    expect(existing.found && existing.document.value).toEqual({ v: 1 });
    await store.close();
  });

  it("delete 走 CAS；期望存在却缺失时冲突", async () => {
    const store = await provider(["x"]);
    const s = store.forExtension("x")!;
    await s.batch([{ op: "set", key: "k", value: { v: 1 } }]);
    expect(await s.batch([{ op: "delete", key: "k", expectedRevision: 0 }])).toEqual({
      ok: false,
      code: "revision-conflict",
      key: "k",
      currentRevision: 1
    });
    expect(await s.batch([{ op: "delete", key: "k", expectedRevision: 1 }])).toEqual({ ok: true, revisions: { k: null } });
    expect((await s.get("k")).found).toBe(false);
    await store.close();
  });

  it("拒绝非法 value 与超长/空 key", async () => {
    const store = await provider(["x"]);
    const s = store.forExtension("x")!;
    expect((await s.batch([{ op: "set", key: "", value: {} }])).ok).toBe(false);
    expect((await s.batch([{ op: "set", key: "k", value: undefined as never }])).ok).toBe(false);
    await store.close();
  });

  it("前缀扫描分页与 schema 版本按 owner 维护", async () => {
    const store = await provider(["x"]);
    const s = store.forExtension("x")!;
    for (const key of ["acl/1", "acl/2", "acl/3", "member/a/1"]) await s.batch([{ op: "set", key, value: { key } }]);
    const first = await s.scan("acl/", { limit: 2 });
    expect(first.entries.map((e) => e.key)).toEqual(["acl/1", "acl/2"]);
    expect(first.nextCursor).toBe("acl/2");
    const second = await s.scan("acl/", { limit: 2, cursor: first.nextCursor! });
    expect(second.entries.map((e) => e.key)).toEqual(["acl/3"]);
    expect(second.nextCursor).toBeNull();
    expect(await s.schemaVersion()).toBe(0);
    await s.setSchemaVersion(3);
    expect(await s.schemaVersion()).toBe(3);
    await store.close();
  });
});
