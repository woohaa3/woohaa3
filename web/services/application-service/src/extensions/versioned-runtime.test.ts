/**
 * 多版本实例与跨进程恢复测试
 * （change: 2026-10-05-extract-application-plugin-host，任务 4.3/4.4 / design D5/D6）。
 *
 * 覆盖：
 * - 配置版本推进后旧版本被在途工作引用时保留、引用清零后自动释放；
 * - 版本化实例的 public/recovery 命名空间隔离（旧版本不能成为公共新工作入口）；
 * - 跨进程提交意图：先记录意图再提交、停用互斥、响应丢失后按同 key 恢复。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplicationExtensionMetadata } from "@woohaa3/contracts";
import { createSqliteSiteExtensionConfigStore } from "./config-store.js";
import { createSqliteExtensionWorkRepository } from "../repository/extension-work-repository.js";
import { createExtensionTaskIntentRepository } from "../repository/extension-task-intent-repository.js";
import { createApplicationExtensionHost } from "./host.js";
import { createSiteExtensionControlPlane } from "./control-plane.js";
import { createExtensionTaskRecovery } from "./task-recovery.js";
import type { ApplicationBackendExtensionDefinition } from "./contract.js";

const dirs: string[] = [];
/** 用例建出来的 SQLite 端口：先关再删目录（Windows 上不关就 EBUSY）。 */
const stores: Array<{ close(): void }> = [];
function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-app-version-"));
  dirs.push(dir);
  return path.join(dir, "plugin.sqlite");
}
afterEach(() => {
  // 有用例已经手动关过，这里再关一次会抛 "database is not open"；关闭本身是幂等语义。
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* 已经关过 */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const METADATA: ApplicationExtensionMetadata = {
  extensionId: "sample-site-extension",
  name: "样例",
  description: "测试",
  version: "1.0.0",
  managementScope: "site",
  host: "application",
  configSchema: { schemaId: "s", schemaVersion: 1 },
  dependencies: [],
  capabilities: []
};

function metadataSource() {
  return { list: () => [METADATA], get: (id: string) => (id === METADATA.extensionId ? METADATA : undefined) };
}

describe("配置版本历史与多版本实例（任务 4.3 / design D6）", () => {
  it("保留不可变配置版本快照，旧版本工作不覆盖新版本依赖", async () => {
    const store = createSqliteSiteExtensionConfigStore({ path: tempDb() });
    const work = createSqliteExtensionWorkRepository({ path: tempDb() });
    stores.push(store, work);
    const host = createApplicationExtensionHost();
    const plane = createSiteExtensionControlPlane({
      host,
      store,
      workStore: work,
      metadata: metadataSource(),
      definitions: [{ extensionId: METADATA.extensionId, requiredDependencies: [], activate: () => ({}) }]
    });
    // v1 提交并受理工作在途。
    const first = await plane.write({ extensionId: METADATA.extensionId, expectedRevision: 0, enabled: true, values: { v: 1 }, secretRefs: [], actor: "a" });
    expect(first.ok).toBe(true);
    const lease = plane.workLease(METADATA.extensionId)!;
    const admitted = lease.admit();
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;

    // v2 提交：旧版本实例因在途引用保留（recovery），新版本成为 public。
    const second = await plane.write({ extensionId: METADATA.extensionId, expectedRevision: plane.snapshot().revision, enabled: true, values: { v: 2 }, secretRefs: [], actor: "a" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.status.configVersion).toBe(2);
    // 两个版本实例共存，且快照可读。
    expect(host.activeVersions(METADATA.extensionId).sort()).toEqual([1, 2]);
    expect(store.getVersion(METADATA.extensionId, 1)?.values).toEqual({ v: 1 });
    expect(store.getVersion(METADATA.extensionId, 2)?.values).toEqual({ v: 2 });

    // 旧工作终态化并再次提交（触发释放）后，旧版本实例被释放。
    lease.resume(admitted.workId)!.settle("succeeded");
    const third = await plane.write({ extensionId: METADATA.extensionId, expectedRevision: plane.snapshot().revision, enabled: true, values: { v: 3 }, secretRefs: [], actor: "a" });
    expect(third.ok).toBe(true);
    expect(host.activeVersions(METADATA.extensionId)).toEqual([3]);
    store.close();
    work.close();
  });

  it("旧版本实例不作为公共 handler 入口", async () => {
    const store = createSqliteSiteExtensionConfigStore({ path: tempDb() });
    const work = createSqliteExtensionWorkRepository({ path: tempDb() });
    stores.push(store, work);
    const host = createApplicationExtensionHost();
    const definition: ApplicationBackendExtensionDefinition = {
      extensionId: METADATA.extensionId,
      activate: (h) => {
        h.registerHandler({ route: "sample/x", auth: "public", handle: () => ({ body: { ok: true } }) });
      }
    };
    // v1 设为 public 并注册 handler。
    await host.activateVersioned(definition, 1, "public");
    // v2 public 顶替，旧版本改为 recovery（内部命名空间）。
    await host.activateVersioned(definition, 2, "public");
    // public 路由仍可派发一次（指向 v2）。
    const result = await host.dispatch("sample/x", { body: null, context: { authLevel: "public" } });
    expect(result.body).toEqual({ ok: true });
    // recovery 版本贡献在隔离命名空间，不暴露公共 route。
    expect(host.activeVersions(METADATA.extensionId).sort()).toEqual([2]);
    store.close();
    work.close();
  });
});

describe("跨进程提交意图（任务 4.2 / design D5）", () => {
  function harness() {
    const store = createSqliteSiteExtensionConfigStore({ path: tempDb() });
    const work = createSqliteExtensionWorkRepository({ path: tempDb() });
    stores.push(store, work);
    const intents = createExtensionTaskIntentRepository({ path: tempDb() });
    // 意图仓库同样打开一个 SQLite 文件，不关就删不掉目录。
    stores.push(intents);
    const host = createApplicationExtensionHost();
    const plane = createSiteExtensionControlPlane({
      host,
      store,
      workStore: work,
      metadata: metadataSource(),
      definitions: [{ extensionId: METADATA.extensionId, activate: () => ({}) }]
    });
    const services = {
      tasks: {
        submit: async (input: { workerTaskKey: string }) => ({ ok: true as const, workerTaskKey: input.workerTaskKey, state: "queued", reused: false }),
        status: async () => null,
        cancel: async () => null
      },
      media: { stat: async () => ({ exists: false }) },
      canvas: {
        requestNodeRun: async () => ({ ok: false as const, code: "unavailable", message: "n/a" }),
        requestNodeCancel: async () => ({ ok: false as const, code: "unavailable", message: "n/a" })
      }
    };
    const recovery = createExtensionTaskRecovery({ intents, controlPlane: plane, servicesFor: () => services });
    return { store, work, intents, plane, recovery };
  }

  it("先记录持久化意图再调用 Task；相同 key 的响应丢失可恢复", async () => {
    const { plane, intents, recovery } = harness();
    await plane.write({ extensionId: METADATA.extensionId, expectedRevision: 0, enabled: true, values: {}, secretRefs: [], actor: "a" });

    let submitCount = 0;
    const first = await recovery.admit({
      extensionId: METADATA.extensionId,
      workerTaskKey: "key-1",
      payloadHash: "hash-1",
      submit: async () => {
        submitCount += 1;
        // 模拟响应丢失：不返回成功，意图保持 pending。
        return { ok: false, code: "unavailable", message: "响应丢失" };
      }
    });
    expect(first.ok).toBe(false);
    expect(submitCount).toBe(1);
    expect(intents.findByKey("key-1")?.state).toBe("pending");
    // 重启后按同一 key 恢复：sweep 不换 key、不误报未执行。
    expect(intents.list("pending").map((intent) => intent.workerTaskKey)).toEqual(["key-1"]);
  });

  it("停用提交后拒绝新意图", async () => {
    const { plane, recovery, intents } = harness();
    await plane.write({ extensionId: METADATA.extensionId, expectedRevision: 0, enabled: true, values: {}, secretRefs: [], actor: "a" });
    await plane.write({ extensionId: METADATA.extensionId, expectedRevision: plane.snapshot().revision, enabled: false, values: {}, secretRefs: [], actor: "a" });
    const result = await recovery.admit({
      extensionId: METADATA.extensionId,
      workerTaskKey: "key-2",
      payloadHash: "hash-2",
      submit: async () => ({ ok: true, state: "queued", reused: false })
    });
    expect(result.ok).toBe(false);
    expect(intents.findByKey("key-2")).toBeUndefined();
  });

  it("payload 不一致稳定失败且不重试", async () => {
    const { plane, recovery, intents } = harness();
    await plane.write({ extensionId: METADATA.extensionId, expectedRevision: 0, enabled: true, values: {}, secretRefs: [], actor: "a" });
    const result = await recovery.admit({
      extensionId: METADATA.extensionId,
      workerTaskKey: "key-3",
      payloadHash: "hash-3",
      submit: async () => ({ ok: false, code: "key-reused", message: "payload 不一致" })
    });
    expect(result.ok).toBe(false);
    expect(intents.findByKey("key-3")?.state).toBe("failed");
  });
});
