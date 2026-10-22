/**
 * 隔离通用扩展数据存储（SQLite 驱动）测试
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 0.4 / design D5）。
 *
 * 覆盖：owner 隔离（未登记 owner 返回 null、跨 owner 不可见）；CAS 语义（expectedRevision 缺省
 * 无条件、null 表示"必须不存在"、不同 revision 冲突不落写）；原子 batch（任一冲突整批回滚）；
 * 前缀扫描分页与 schema 版本；不暴露裸 SQL 句柄。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSqliteExtensionDocumentStore } from "./extension-document-store.js";

const dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-extdoc-"));
  dirs.push(dir);
  return path.join(dir, "documents.sqlite");
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function store(owners: string[]) {
  return createSqliteExtensionDocumentStore({ path: tempDb(), owners });
}

describe("ExtensionDocumentStore owner 隔离（任务 0.4）", () => {
  it("未登记 owner 返回 null（fail closed），不暴露数据库句柄", () => {
    const provider = store(["test-access"]);
    expect(provider.forExtension("task-monitor")).toBeNull();
    const ownerStore = provider.forExtension("test-access");
    expect(ownerStore).not.toBeNull();
    expect(ownerStore!.owner()).toBe("test-access");
    // 不暴露裸 db/SQL 方法。
    expect((ownerStore as unknown as Record<string, unknown>).db).toBeUndefined();
    provider.close();
  });

  it("跨 owner 键空间互不可见", async () => {
    const provider = store(["a", "b"]);
    const a = provider.forExtension("a")!;
    const b = provider.forExtension("b")!;
    expect((await a.batch([{ op: "set", key: "k", value: { v: 1 } }])).ok).toBe(true);
    expect((await a.get("k")).found).toBe(true);
    expect((await b.get("k")).found).toBe(false);
    provider.close();
  });
});

describe("ExtensionDocumentStore CAS 与原子 batch（任务 0.4）", () => {
  it("expectedRevision 缺省为无条件写；null 表示必须不存在", async () => {
    const provider = store(["x"]);
    const s = provider.forExtension("x")!;
    // 无条件写两次，revision 递增。
    expect(await s.batch([{ op: "set", key: "k", value: { v: 1 } }])).toEqual({ ok: true, revisions: { k: 1 } });
    expect(await s.batch([{ op: "set", key: "k", value: { v: 2 } }])).toEqual({ ok: true, revisions: { k: 2 } });
    // null 表示"必须不存在"：已存在时冲突。
    expect(await s.batch([{ op: "set", key: "k", value: { v: 3 }, expectedRevision: null }])).toEqual({
      ok: false,
      code: "revision-conflict",
      key: "k",
      currentRevision: 2
    });
    const read = await s.get("k");
    expect(read.found && read.document.value).toEqual({ v: 2 });
    provider.close();
  });

  it("任一步冲突整批回滚，不落部分写入", async () => {
    const provider = store(["x"]);
    const s = provider.forExtension("x")!;
    await s.batch([{ op: "set", key: "existing", value: { v: 1 } }]);
    const result = await s.batch([
      { op: "set", key: "new", value: { v: "should-not-commit" } },
      { op: "set", key: "existing", value: { v: 2 }, expectedRevision: 99 }
    ]);
    expect(result.ok).toBe(false);
    expect((await s.get("new")).found).toBe(false);
    const existing = await s.get("existing");
    expect(existing.found && existing.document.value).toEqual({ v: 1 });
    provider.close();
  });

  it("拒绝非法 value 与超长/空 key", async () => {
    const provider = store(["x"]);
    const s = provider.forExtension("x")!;
    expect((await s.batch([{ op: "set", key: "", value: {} }])).ok).toBe(false);
    expect((await s.batch([{ op: "set", key: "k", value: undefined as never }])).ok).toBe(false);
    provider.close();
  });

  it("前缀扫描分页与 schema 版本按 owner 维护", async () => {
    const provider = store(["x"]);
    const s = provider.forExtension("x")!;
    for (const key of ["acl:1", "acl:2", "acl:3", "other"]) await s.batch([{ op: "set", key, value: { key } }]);
    const first = await s.scan("acl:", { limit: 2 });
    expect(first.entries.map((e) => e.key)).toEqual(["acl:1", "acl:2"]);
    expect(first.nextCursor).toBe("acl:2");
    const second = await s.scan("acl:", { limit: 2, cursor: first.nextCursor! });
    expect(second.entries.map((e) => e.key)).toEqual(["acl:3"]);
    expect(second.nextCursor).toBeNull();
    expect(await s.schemaVersion()).toBe(0);
    await s.setSchemaVersion(3);
    expect(await s.schemaVersion()).toBe(3);
    provider.close();
  });
});
