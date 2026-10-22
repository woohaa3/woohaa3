/**
 * 跨进程重启恢复验收
 * （change: 2026-10-05-extract-application-plugin-host，任务 4.4/6.2 / design D5/D6）。
 *
 * 模拟「Application 重启」与「Task 离线后恢复」：
 * - 停用后仍有在途工作时，重开同一独立 store，恢复旧配置实例与内部收尾能力；
 * - 新工作仍被拒绝；pending 提交意图在 Task 恢复后按同一 key 收尾；
 * - 全部引用清零后无需再次管理写入即自动释放。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplicationExtensionMetadata } from "@woohaa3/contracts";
import { createSqliteSiteExtensionConfigStore } from "../extensions/config-store.js";
import { createSqliteExtensionWorkRepository } from "../repository/extension-work-repository.js";
import { createExtensionTaskIntentRepository } from "../repository/extension-task-intent-repository.js";
import { createApplicationExtensionHost } from "../extensions/host.js";
import { createSiteExtensionControlPlane } from "./control-plane.js";
import { createExtensionTaskRecovery } from "./task-recovery.js";
import type { ApplicationExtensionServices } from "./contract.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-app-restart-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

function build(dir: string, services: ApplicationExtensionServices) {
  const store = createSqliteSiteExtensionConfigStore({ path: path.join(dir, "application.sqlite") });
  const work = createSqliteExtensionWorkRepository({ path: path.join(dir, "application.sqlite") });
  const intents = createExtensionTaskIntentRepository({ path: path.join(dir, "application.sqlite") });
  const host = createApplicationExtensionHost();
  const plane = createSiteExtensionControlPlane({
    host,
    store,
    workStore: work,
    metadata: { list: () => [METADATA], get: (id) => (id === METADATA.extensionId ? METADATA : undefined) },
    definitions: [{ extensionId: METADATA.extensionId, activate: () => ({}) }]
  });
  const recovery = createExtensionTaskRecovery({ intents, controlPlane: plane, servicesFor: () => services });
  return { store, work, intents, host, plane, recovery };
}

const onlineServices: ApplicationExtensionServices = {
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

describe("Application 跨进程重启恢复（任务 4.4/6.2）", () => {
  it("停用且有在途工作时重启：恢复旧版本实例、拒绝新工作、引用清零后自动释放", async () => {
    const dir = tempDir();
    const first = build(dir, onlineServices);
    await first.plane.reconcile();
    await first.plane.write({ extensionId: METADATA.extensionId, expectedRevision: first.store.revision(), enabled: true, values: {}, secretRefs: [], actor: "a" });
    const lease = first.plane.workLease(METADATA.extensionId)!;
    const admitted = lease.admit();
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    // 停用（有在途工作 → draining）。
    await first.plane.write({ extensionId: METADATA.extensionId, expectedRevision: first.store.revision(), enabled: false, values: {}, secretRefs: [], actor: "a" });
    expect(first.plane.status(METADATA.extensionId)?.actualState).toBe("draining");
    first.store.close();
    first.work.close();
    first.intents.close();

    // 重启：重开同一 store。
    const second = build(dir, onlineServices);
    await second.plane.reconcile();
    expect(second.plane.status(METADATA.extensionId)?.actualState).toBe("draining");
    // 新工作仍被拒绝。
    expect(second.plane.workLease(METADATA.extensionId)!.admit().ok).toBe(false);
    // 旧工作恢复并终态化；随后 reconcile 自动释放（无需再次管理写入）。
    const resumed = second.plane.workLease(METADATA.extensionId)!.resume(admitted.workId);
    expect(resumed).not.toBeNull();
    resumed!.settle("succeeded");
    await second.plane.reconcile();
    expect(second.plane.status(METADATA.extensionId)?.actualState).toBe("disabled");
    expect(second.plane.status(METADATA.extensionId)?.activeWorkCount).toBe(0);
    second.store.close();
    second.work.close();
    second.intents.close();
  });

  it("Task 离线时 pending 意图保留；Task 恢复后按同一 key 收尾", async () => {
    const dir = tempDir();
    const offline: ApplicationExtensionServices = {
      ...onlineServices,
      tasks: {
        submit: async () => ({ ok: false as const, code: "unavailable", message: "Task 离线" }),
        status: async () => {
          throw new Error("Task 离线");
        },
        cancel: async () => null
      }
    };
    const first = build(dir, offline);
    await first.plane.reconcile();
    await first.plane.write({ extensionId: METADATA.extensionId, expectedRevision: first.store.revision(), enabled: true, values: {}, secretRefs: [], actor: "a" });
    const result = await first.recovery.admit({
      extensionId: METADATA.extensionId,
      workerTaskKey: "key-restart",
      payloadHash: "h",
      submit: async () => ({ ok: false, code: "unavailable", message: "Task 离线" })
    });
    expect(result.ok).toBe(false);
    // pending 意图保留，sweep 不因 Task 离线而误判终态。
    await first.recovery.sweep();
    expect(first.intents.findByKey("key-restart")?.state).toBe("pending");
    first.store.close();
    first.work.close();
    first.intents.close();

    // 重启且 Task 恢复：同一 key 的意图仍在，sweep 依据 Task 事实收尾。
    const online: ApplicationExtensionServices = {
      ...onlineServices,
      tasks: {
        ...onlineServices.tasks,
        status: async (workerTaskKey: string) => ({ workerTaskKey, state: "succeeded" })
      }
    };
    const second = build(dir, online);
    await second.recovery.sweep();
    expect(second.intents.findByKey("key-restart")?.state).toBe("submitted");
    second.store.close();
    second.work.close();
    second.intents.close();
  });
});
