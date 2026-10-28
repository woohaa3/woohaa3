/**
 * 隔离通用扩展数据存储契约（纯类型）
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 0.4 / design D5）。
 *
 * 扩展（如 Access 的 ACL）需要持久、带版本、可原子更新的隔离数据。宿主提供
 * owner-scoped `ExtensionDocumentStore`：owner 来自**可信 registration**（extensionId），
 * 不来自请求体；facade 拒绝跨 owner 读写。宿主按配置以 SQLite 或 Mongo profile 提供通用驱动
 *（change: 2026-10-13-add-offline-canvas-migration-and-mongodb-backend），**不**暴露裸 SQL/
 * 数据库句柄/其它 extension 空间/Canvas Y.Doc/Task 表。
 *
 * 扩展拥有自己的 schema/迁移/业务索引；store 只保证文档级原子性与顺序。接口为**异步**
 *（`Promise`），使同步的 SQLite 与异步的 Mongo 驱动共用同一契约。
 */

/** 结构性 JSON 标量/对象/数组（可持久化）。 */
export type ExtensionDocumentValue =
  | null
  | boolean
  | number
  | string
  | ExtensionDocumentValue[]
  | { [key: string]: ExtensionDocumentValue };

export function isExtensionDocumentValue(value: unknown): value is ExtensionDocumentValue {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "boolean") return true;
  if (type === "number") return Number.isFinite(value as number);
  if (Array.isArray(value)) return value.every(isExtensionDocumentValue);
  if (type === "object") {
    return Object.values(value as Record<string, unknown>).every(isExtensionDocumentValue);
  }
  return false;
}

/** 一份文档的记录：值 + 单调 revision。读返回 null 表示不存在。 */
export type ExtensionDocument<T extends ExtensionDocumentValue = ExtensionDocumentValue> = {
  key: string;
  value: T;
  revision: number;
  updatedAt: string;
};

/** 带版本读取，供 CAS 使用。 */
export type ExtensionDocumentRead<T extends ExtensionDocumentValue = ExtensionDocumentValue> =
  | { found: true; document: ExtensionDocument<T> }
  | { found: false };

export type ExtensionDocumentWriteResult =
  | { ok: true; revision: number }
  | { ok: false; code: "revision-conflict"; currentRevision: number | null }
  | { ok: false; code: "invalid"; message: string };

/**
 * 原子写入操作：set（带可选 expectedRevision 做 CAS）、delete（带 expectedRevision）。
 *
 * 一次 `batch` 内的所有操作要么全提交、要么全不提交（成员索引与正文一致）。
 */
export type ExtensionDocumentOperation =
  | {
      op: "set";
      key: string;
      value: ExtensionDocumentValue;
      /** 期望当前 revision；`null` 表示“应不存在”。缺省为无条件覆盖（不推荐用于 ACL）。 */
      expectedRevision?: number | null;
    }
  | {
      op: "delete";
      key: string;
      expectedRevision?: number | null;
    };

export type ExtensionDocumentBatchResult =
  | { ok: true; revisions: Record<string, number | null> }
  | { ok: false; code: "revision-conflict"; key: string; currentRevision: number | null }
  | { ok: false; code: "invalid"; message: string };

/** 前缀扫描的一页（有界；稳定 key 排序）。 */
export type ExtensionDocumentScanPage = {
  entries: ExtensionDocument[];
  /** 下一页 cursor；无更多时为 null。 */
  nextCursor: string | null;
};

/**
 * 一个 extension 的 owner-scoped 存储 facade。
 *
 * `owner` 固定为可信 extensionId；实现 MUST 拒绝任何其它 owner 的键/索引访问。
 */
export type ExtensionDocumentStore = {
  /** 该 facade 的 owner（extensionId）。 */
  owner(): string;
  get<T extends ExtensionDocumentValue = ExtensionDocumentValue>(key: string): Promise<ExtensionDocumentRead<T>>;
  /** 原子 batch（CAS/成员索引一致）。 */
  batch(operations: readonly ExtensionDocumentOperation[]): Promise<ExtensionDocumentBatchResult>;
  /** 前缀扫描（有界分页）。 */
  scan(prefix: string, options?: { cursor?: string; limit?: number }): Promise<ExtensionDocumentScanPage>;
  /** schema 迁移钩子：扩展拥有 schema，store 只保证幂等执行一次标记。 */
  schemaVersion(): Promise<number>;
  setSchemaVersion(version: number): Promise<void>;
};

/** 按可信 extensionId 解析 owner-scoped store；未知 extension 返回 null。 */
export type ExtensionDocumentStoreProvider = {
  forExtension(extensionId: string): ExtensionDocumentStore | null;
};
