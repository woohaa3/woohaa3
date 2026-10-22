/**
 * 后端插件工作在途引用与 draining 生命周期
 * （change: 2026-10-04-add-backend-plugin-extensions，任务 2.2 / design D4）。
 *
 * 语义：
 * - 停用配置提交后，宿主对**全部用户**立即拒绝该插件新工作；
 * - 此前已受理工作绑定其原配置版本并继续执行/恢复/收尾；
 * - 存在在途工作时实际状态为 `draining`，资源保留至引用消失；
 * - 重启从宿主持久化工作状态重建引用，**不能仅依赖内存计数**；
 * - 正在使用的配置与 secret reference 不得被提前删除。
 *
 * 本模块负责**引用计数与准入策略**，不取消任何任务：插件停用绝不隐含取消全部工作。
 */
import type { ApplicationExtensionActualState } from "@woohaa3/contracts";

/** 一条持久化工作引用（重启后据此重建计数与版本）。 */
export type ExtensionWorkReference = {
  workId: string;
  extensionId: string;
  configVersion: number;
  /** 该引用绑定的目标配置是否启用（恢复期仍按原版本执行）。 */
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
};

/** durable 引用仓库；由宿主注入（SQLite 实现见 repository/extension-work-repository）。 */
export type ExtensionWorkReferenceStore = {
  /** 幂等记录一条工作引用（相同 workId 覆盖状态）。 */
  upsert: (reference: ExtensionWorkReference) => void;
  /** 引用进入终态（幂等）。 */
  settle: (workId: string, state: ExtensionWorkReference["state"], now: string) => void;
  list: (extensionId: string) => ExtensionWorkReference[];
  find: (workId: string) => ExtensionWorkReference | undefined;
  deleteAll: (extensionId: string) => void;
  close: () => void;
};

export type ExtensionWorkAdmissionResult =
  | { ok: true; workId: string; configVersion: number }
  | { ok: false; reason: "disabled" | "not-ready" | "version-mismatch" };

export type ExtensionWorkHandle = {
  workId: string;
  configVersion: number;
  /** 幂等终态化并释放引用。 */
  settle: (state: Exclude<ExtensionWorkReference["state"], "queued" | "running">) => void;
  /** 仅更新运行状态（queued→running），不释放引用。 */
  markRunning: () => void;
};

export type ExtensionWorkLease = {
  admission: () => ExtensionWorkAdmissionResult;
  /** 受理一条新工作并登记 durable 引用；被拒绝时不产生任何引用。 */
  admit: () => ExtensionWorkAdmissionResult;
  /** 重启恢复：为 durable 记录重建 handle（不检查 desiredEnabled）。 */
  resume: (workId: string) => ExtensionWorkHandle | null;
  activeWorkCount: () => number;
  /** 存在 queued/running 引用时为 true。 */
  isDraining: () => boolean;
  /** 根据目标启用与在途工作派生实际状态（未配置由调用方另行判定）。 */
  actualState: () => ApplicationExtensionActualState;
  /** 读取某配置版本的在途引用数（用于释放判定）。 */
  activeWorkCountForVersion: (version: number) => number;
  dispose: () => void;
};

let workSequence = 0;

export type CreateExtensionWorkLeaseOptions = {
  extensionId: string;
  store: ExtensionWorkReferenceStore;
  /** 当前目标启用（站点权威，由配置发布注入）。 */
  isDesiredEnabled: () => boolean;
  /** 当前已提交配置版本；null 表示未配置。 */
  committedVersion: () => number | null;
  /** activation 是否已完成（未完成时拒绝新工作）。 */
  isActive: () => boolean;
  now?: () => Date;
  logger?: (event: Record<string, unknown>) => void;
};

/**
 * 为一个插件创建在途工作 lease。
 *
 * 准入规则（design D4）：
 * - 目标未启用 → `disabled`；
 * - activation 未完成 → `not-ready`；
 * - 无已提交版本 → `not-ready`；
 * - 否则按当前已提交版本受理。
 */
export function createExtensionWorkLease(options: CreateExtensionWorkLeaseOptions): ExtensionWorkLease {
  const now = options.now ?? (() => new Date());
  const log = options.logger ?? (() => undefined);

  const activeReferences = (): ExtensionWorkReference[] =>
    options.store.list(options.extensionId).filter((ref) => ref.state === "queued" || ref.state === "running");

  const admission = (): ExtensionWorkAdmissionResult => {
    const version = options.committedVersion();
    if (version === null) return { ok: false, reason: "not-ready" };
    if (!options.isDesiredEnabled()) return { ok: false, reason: "disabled" };
    if (!options.isActive()) return { ok: false, reason: "not-ready" };
    return { ok: true, workId: "", configVersion: version };
  };

  const admit = (): ExtensionWorkAdmissionResult => {
    const result = admission();
    if (!result.ok) {
      log({ event: "extension-work-rejected", extensionId: options.extensionId, reason: result.reason });
      return result;
    }
    workSequence += 1;
    const workId = `plugin-work-${Date.now().toString(36)}-${workSequence.toString(36)}`;
    const timestamp = now().toISOString();
    options.store.upsert({
      workId,
      extensionId: options.extensionId,
      configVersion: result.configVersion,
      state: "queued",
      createdAt: timestamp,
      updatedAt: timestamp
    });
    return { ok: true, workId, configVersion: result.configVersion };
  };

  const makeHandle = (reference: ExtensionWorkReference): ExtensionWorkHandle => {
    let settled = false;
    return {
      workId: reference.workId,
      configVersion: reference.configVersion,
      markRunning: () => {
        if (settled) return;
        options.store.upsert({ ...reference, state: "running", updatedAt: now().toISOString() });
      },
      settle: (state) => {
        if (settled) return;
        settled = true;
        options.store.settle(reference.workId, state, now().toISOString());
        log({ event: "extension-work-settled", extensionId: options.extensionId, workId: reference.workId, state });
      }
    };
  };

  return {
    admission,
    admit,
    resume: (workId) => {
      const reference = options.store.find(workId);
      if (!reference || reference.extensionId !== options.extensionId) return null;
      if (reference.state !== "queued" && reference.state !== "running") return null;
      return makeHandle(reference);
    },
    activeWorkCount: () => activeReferences().length,
    isDraining: () => activeReferences().length > 0,
    activeWorkCountForVersion: (version) =>
      activeReferences().filter((ref) => ref.configVersion === version).length,
    actualState: () => {
      if (options.isDesiredEnabled()) return options.isActive() ? "active" : "configuring";
      return activeReferences().length > 0 ? "draining" : "disabled";
    },
    dispose: () => {
      // 释放 lease 本身不删除 durable 引用：真正释放由宿主在所有工作终态后执行。
    }
  };
}
