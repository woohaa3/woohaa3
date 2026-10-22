/**
 * 应用插件隔离秘密仓库契约（纯类型）
 * （change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 1.4 / design D5）。
 *
 * 宿主提供按 extensionId/owner/purpose 隔离的秘密仓库；插件拥有授权记录**语义**，但拿不到
 * 仓库数据库或宿主主密钥。契约覆盖有界加密 read/write/clear、原子比较交换（版本）、
 * owner 内刷新协调与授权 epoch。
 */

/** 秘密记录读取结果：不存在/解密失败返回 null。 */
export type ApplicationSecretReadResult<T> = { value: T; version: number } | null;

/**
 * 一次写入的并发前置条件：
 * - `version`：期望当前版本（新记录为 0）；不匹配返回 conflict；
 * - `epoch`：期望授权 epoch；断开后 epoch 变化使旧写入失效。
 */
export type ApplicationSecretWritePrecondition = {
  version: number;
  /** 期望的授权 epoch（可选）；不匹配视为失效写入。 */
  epoch?: number;
};

export type ApplicationSecretWriteResult =
  | { ok: true; version: number }
  | { ok: false; code: "version-conflict" | "epoch-invalid" | "storage-failed"; message: string };

/** owner 内刷新协调：同一 owner 的并发刷新合并为一次。 */
export type ApplicationSecretRefreshCoordinator = {
  /** 合并同名 key 的并发刷新；返回同一 promise。 */
  run: <T>(owner: string, key: string, task: () => Promise<T>) => Promise<T>;
};

/**
 * 受限秘密仓库：插件只能读写的**自己 purpose** 的加密记录。
 *
 * 记录内容由插件定义（OAuth token 等），宿主只负责隔离、加密持久化与版本/epoch。
 */
export type ApplicationExtensionSecretStore = {
  /** 读取 owner 的记录（不改变版本）。 */
  read: <T>(owner: string, purpose: string) => ApplicationSecretReadResult<T>;
  /** 原子加密写入（带版本/epoch 前置条件）。 */
  write: <T>(
    owner: string,
    purpose: string,
    record: T,
    precondition: ApplicationSecretWritePrecondition
  ) => ApplicationSecretWriteResult;
  /** 清除 owner 的记录（幂等）。 */
  clear: (owner: string, purpose: string) => void;
  /** 当前授权 epoch（断开/重绑后推进）。 */
  epoch: (owner: string) => number;
  /** 推进授权 epoch（断开或重新绑定）；使较旧刷新写入失效。 */
  bumpEpoch: (owner: string) => number;
  /** owner 内刷新协调。 */
  refresh: ApplicationSecretRefreshCoordinator;
};
