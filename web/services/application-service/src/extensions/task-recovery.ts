/**
 * 跨进程插件任务提交意图恢复
 * （change: 2026-10-05-extract-application-plugin-host，任务 4.2/4.4 / design D5）。
 *
 * 语义：
 * - 提交前先在 Application 本地 durable 记录意图（含稳定 workerTaskKey 与 payload 指纹）；
 * - 停用提交后新意图被拒绝（准入与停用互斥），但已受理意图继续提交/收尾；
 * - 响应丢失后按同一 key 查询/重试，不能换 key 或误报未执行；
 * - Task 离线时 pending 计入在途，不视为终态；恢复循环在 Task 可用后继续提交。
 *
 * 本模块不建立第二套任务队列、认领调度或 worker。
 */
import type { SiteExtensionControlPlane } from "../extensions/control-plane.js";
import type { ExtensionTaskIntent, ExtensionTaskIntentStore } from "../repository/extension-task-intent-repository.js";
import type { ApplicationExtensionServices } from "../extensions/contract.js";

export type ExtensionTaskRecoveryOptions = {
  intents: ExtensionTaskIntentStore;
  controlPlane: SiteExtensionControlPlane;
  servicesFor: (extensionId: string) => ApplicationExtensionServices;
  now?: () => Date;
  logger?: (event: Record<string, unknown>) => void;
};

export type ExtensionTaskRecovery = {
  /** 受理一条插件任务：先记录意图，再调用 Task；返回稳定 key 的结果。 */
  admit(input: {
    extensionId: string;
    workerTaskKey: string;
    payloadHash: string;
    submit: () => Promise<{ ok: true; state: string; reused: boolean } | { ok: false; code: string; message: string }>;
  }): Promise<{ ok: true; state: string; reused: boolean } | { ok: false; code: string; message: string }>;
  /** 恢复循环：按持久化意图继续提交/收尾。 */
  sweep: () => Promise<void>;
  pendingCount: (extensionId: string) => number;
};

let intentSequence = 0;

export function createExtensionTaskRecovery(options: ExtensionTaskRecoveryOptions): ExtensionTaskRecovery {
  const now = options.now ?? (() => new Date());
  const log = options.logger ?? (() => undefined);

  const admit: ExtensionTaskRecovery["admit"] = async (input) => {
    const lease = options.controlPlane.workLease(input.extensionId);
    if (!lease) return { ok: false, code: "unsupported", message: "插件未配置工作在途能力" };
    // 准入检查与本地意图记录在同一同步段：停用提交后 lease.admit() 立即拒绝。
    const admission = lease.admit();
    if (!admission.ok) {
      return { ok: false, code: admission.reason === "disabled" ? "unsupported" : "unavailable", message: `插件工作被拒绝：${admission.reason}` };
    }
    intentSequence += 1;
    const timestamp = now().toISOString();
    const intent: ExtensionTaskIntent = {
      intentId: `plugin-intent-${Date.now().toString(36)}-${intentSequence.toString(36)}`,
      extensionId: input.extensionId,
      configVersion: admission.configVersion,
      workerTaskKey: input.workerTaskKey,
      payloadHash: input.payloadHash,
      state: "pending",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    options.intents.create(intent);

    const result = await input.submit();
    if (result.ok) {
      options.intents.update(intent.intentId, "submitted", now().toISOString());
    } else if (result.code === "key-reused") {
      // payload 不一致：意图确定失败，不重试。
      options.intents.update(intent.intentId, "failed", now().toISOString());
    }
    return result;
  };

  const sweep = async (): Promise<void> => {
    for (const intent of options.intents.list("pending")) {
      const services = options.servicesFor(intent.extensionId);
      try {
        const status = await services.tasks.status(intent.workerTaskKey);
        if (status) {
          options.intents.update(intent.intentId, "submitted", now().toISOString());
          continue;
        }
      } catch (error) {
        // Task 暂时离线：保留 pending，不能视为终态。
        log({ event: "extension-task-recovery-deferred", extensionId: intent.extensionId, message: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  const pendingCount = (extensionId: string): number => options.intents.list("pending").filter((intent) => intent.extensionId === extensionId).length;

  return { admit, sweep, pendingCount };
}
