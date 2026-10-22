/**
 * 后端插件工作 admission / draining / 恢复测试
 * （change: 2026-10-04-add-backend-plugin-extensions，任务 2.2）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSqliteExtensionWorkRepository } from "../repository/extension-work-repository.js";
import { createExtensionWorkLease, type ExtensionWorkLease, type ExtensionWorkReferenceStore } from "./work.js";

const dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-plugin-work-"));
  dirs.push(dir);
  return path.join(dir, "plugin.sqlite");
}
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function memoryStore(): ExtensionWorkReferenceStore {
  const records = new Map<string, import("./work.js").ExtensionWorkReference>();
  return {
    upsert: (reference) => records.set(reference.workId, reference),
    settle: (workId, state, now) => {
      const existing = records.get(workId);
      if (existing) records.set(workId, { ...existing, state, updatedAt: now });
    },
    list: (extensionId) => [...records.values()].filter((entry) => entry.extensionId === extensionId),
    find: (workId) => records.get(workId),
    deleteAll: (extensionId) => {
      for (const [key, value] of records) if (value.extensionId === extensionId) records.delete(key);
    },
    close: () => records.clear()
  };
}

function lease(overrides: Partial<Parameters<typeof createExtensionWorkLease>[0]> = {}): ExtensionWorkLease {
  return createExtensionWorkLease({
    extensionId: "sample",
    store: memoryStore(),
    isDesiredEnabled: () => true,
    committedVersion: () => 1,
    isActive: () => true,
    now: () => new Date("2026-10-04T00:00:00.000Z"),
    ...overrides
  });
}

describe("插件工作 admission（任务 2.2）", () => {
  it("关闭提交后拒绝新工作，旧工作继续并可终态化", () => {
    let enabled = true;
    const store = memoryStore();
    const work = lease({ store, isDesiredEnabled: () => enabled });
    const admitted = work.admit();
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    // 提交停用。
    enabled = false;
    expect(work.admission()).toEqual({ ok: false, reason: "disabled" });
    expect(work.isDraining()).toBe(true);
    expect(work.actualState()).toBe("draining");
    // 旧工作仍可完成并释放引用。
    const handle = work.resume(admitted.workId);
    expect(handle).not.toBeNull();
    handle!.settle("succeeded");
    expect(work.activeWorkCount()).toBe(0);
    expect(work.actualState()).toBe("disabled");
  });

  it("activation 未完成 / 无版本时拒绝新工作", () => {
    expect(lease({ isActive: () => false }).admission()).toEqual({ ok: false, reason: "not-ready" });
    expect(lease({ committedVersion: () => null }).admission()).toEqual({ ok: false, reason: "not-ready" });
  });

  it("被拒绝的 admission 不产生任何引用", () => {
    const store = memoryStore();
    const work = lease({ store, isDesiredEnabled: () => false });
    expect(work.admit().ok).toBe(false);
    expect(work.activeWorkCount()).toBe(0);
  });

  it("按版本统计在途引用（旧版本工作不影响新版本判定）", () => {
    const store = memoryStore();
    let version = 1;
    const work = lease({ store, committedVersion: () => version });
    const first = work.admit();
    version = 2;
    const second = work.admit();
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(work.activeWorkCountForVersion(1)).toBe(1);
    expect(work.activeWorkCountForVersion(2)).toBe(1);
  });
});

describe("draining 时重启恢复（任务 2.2）", () => {
  it("从 durable SQLite 重建引用且新工作仍被停用策略阻止", () => {
    const dbPath = tempDb();
    const store = createSqliteExtensionWorkRepository({ path: dbPath });
    const work = lease({ store });
    const admitted = work.admit();
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    work.resume(admitted.workId)?.markRunning();
    store.close();

    // 模拟重启：重新打开同一 durable store，插件已停用。
    const reopened = createSqliteExtensionWorkRepository({ path: dbPath });
    const resumed = lease({ store: reopened, isDesiredEnabled: () => false });
    expect(resumed.activeWorkCount()).toBe(1);
    expect(resumed.actualState()).toBe("draining");
    expect(resumed.admission()).toEqual({ ok: false, reason: "disabled" });
    const handle = resumed.resume(admitted.workId);
    expect(handle?.configVersion).toBe(1);
    handle?.settle("failed");
    expect(resumed.activeWorkCount()).toBe(0);
    reopened.close();
  });
});
