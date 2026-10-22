import { nativeContextKey, type NativeContext } from "./native-context.js";
/**
 * 连接生命周期服务（change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 1.3/1.4/1.5 /
 * design D3/D4）。
 *
 * 把宿主注入的**隔离**存储组合成 owner-scoped 连接管理：
 * - 元数据经 `ExtensionDocumentStore`（按 extensionId 隔离，CAS 版本）；
 * - 凭据经 `ApplicationExtensionSecretStore`（加密、不回读明文）；
 * - 三类凭据用途（`model-api-key` / `appserver-auth` / `mcp-grant`）严格分开，不跨连接复用；
 * - 替换/清除凭据推进**连接级** `credentialEpoch`，使旧原生会话与迟到结果失效；
 * - 保存设置不调用模型（无生成副作用）；删除连接清其凭据但**不**删除宿主历史。
 *
 * 不含任何厂商 SDK 或网络调用：调用方（扩展）只经本服务读写连接；协议检查在扩展适配器内。
 */
import type { ExtensionDocumentStore, ApplicationExtensionSecretStore, ExtensionDocumentValue } from "@woohaa3/contracts";
import type { AgentConnectionAuthMode, AgentConnectionRunCategory, AgentConnectionStatus, AgentCredentialPurpose } from "@woohaa3/contracts";
import {
  connectionMetadataKey,
  connectionMetadataPrefix,
  isConnectionMetadataRecord,
  type ConnectionMetadataRecord,
  type ConnectionNativeBinding
} from "./metadata.js";

export type ConnectionConfigInput = {
  adapterId: string;
  name: string;
  runCategory: AgentConnectionRunCategory;
  authMode: AgentConnectionAuthMode;
  baseUrl?: string;
  models?: readonly string[];
  modelCapabilities?: ConnectionMetadataRecord["modelCapabilities"];
};

export type ConnectionServiceError = {
  code: "not-found" | "malformed-request" | "version-conflict" | "epoch-invalid" | "storage-failed" | "credential-missing";
  message: string;
};

export type ConnectionServiceResult<T> = { ok: true; value: T } | { ok: false; error: ConnectionServiceError };

export type ConnectionServiceOptions = {
  documents: ExtensionDocumentStore;
  runtimeVersionFor?: (adapterId: string) => string | undefined;
  secrets?: ApplicationExtensionSecretStore;
  now?: () => string;
  createId?: (prefix: string) => string;
};

export type ConnectionService = {
  setRuntimeProbe?(owner: string, connectionId: string, version: string, evidence: import("@woohaa3/contracts").AgentConnectionStatusEvidence): Promise<ConnectionServiceResult<ConnectionMetadataRecord>>;
  migrateRuntime?(owner: string, connectionId: string, runtimeVersion: string, beforeMigration: () => boolean): Promise<ConnectionServiceResult<{ changed: boolean }>>;
  list(owner: string): Promise<ConnectionMetadataRecord[]>;
  get(owner: string, connectionId: string): Promise<ConnectionMetadataRecord | null>;
  create(owner: string, input: ConnectionConfigInput): Promise<ConnectionServiceResult<ConnectionMetadataRecord>>;
  update(owner: string, connectionId: string, patch: Partial<ConnectionConfigInput>): Promise<ConnectionServiceResult<ConnectionMetadataRecord>>;
  /** 删除连接：清其凭据与元数据；不删除宿主历史/画布内容。 */
  remove(owner: string, connectionId: string): Promise<ConnectionServiceResult<{ removed: true }>>;
  /** 保存/替换凭据（明文只在此请求出现；加密保存后不回读）。 */
  saveCredential(input: {
    owner: string;
    connectionId: string;
    purpose: AgentCredentialPurpose;
    secret: string;
    expectedEpoch?: number;
  }): Promise<ConnectionServiceResult<{ credentialEpoch: number }>>;
  /** 清除凭据并推进 epoch（幂等）。 */
  clearCredential(input: { owner: string; connectionId: string; purpose: AgentCredentialPurpose }): Promise<ConnectionServiceResult<{ credentialEpoch: number }>>;
  /** 是否已保存凭据（不返回明文）。 */
  credentialConfigured(input: { owner: string; connectionId: string; purpose: AgentCredentialPurpose }): Promise<boolean>;
  /** 读取凭据供适配器内部使用（进程内；绝不穿过浏览器边界）。 */
  readCredential<T = { secret: string }>(input: { owner: string; connectionId: string; purpose: AgentCredentialPurpose }): Promise<T | null>;
  /** 记录/更新原生会话绑定（按 connectionId + epoch 归属）。 */
  setNativeBinding(input: { owner: string; connectionId: string; context?: NativeContext; native: ConnectionNativeBinding }): Promise<ConnectionServiceResult<ConnectionMetadataRecord>>;
  /** 解析仍有效的原生会话 id（epoch 不匹配返回 null，不自动复用）。 */
  resolveNativeBinding(input: { owner: string; connectionId: string; context?: NativeContext }): Promise<ConnectionNativeBinding | null>;
  /**
   * 记录一次真实证据快照（探测/运行后）。
   *
   * 保存设置不调用本方法；`credential` 证据由本服务按凭据实际状态维护，调用方只提交
   * transport/modelAccess/tools。
   */
  setStatus(input: {
    owner: string;
    connectionId: string;
    patch: Partial<Pick<AgentConnectionStatus, "transport" | "credential" | "modelAccess" | "tools">>;
  }): Promise<ConnectionServiceResult<ConnectionMetadataRecord>>;
};

function defaultId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ? `${prefix}-${random}` : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 凭据 purpose 键：按连接隔离（禁止跨连接/提供方复用）。 */
export function credentialPurposeKey(connectionId: string, purpose: AgentCredentialPurpose): string {
  return `connection:${connectionId}:${purpose}`;
}

export function createConnectionService(options: ConnectionServiceOptions): ConnectionService {
  const documents = options.documents;
  const secrets = options.secrets;
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? defaultId;

  /** 文档存储要求可 JSON 序列化的值；此处转换（含 readonly 数组）。 */
  const toDocumentValue = (record: ConnectionMetadataRecord): ExtensionDocumentValue =>
    JSON.parse(JSON.stringify(record)) as ExtensionDocumentValue;

  const readRecord = async (owner: string, connectionId: string): Promise<{ record: ConnectionMetadataRecord; revision: number } | null> => {
    const read = await documents.get(connectionMetadataKey(connectionId));
    if (!read.found) return null;
    const record = read.document.value;
    if (!isConnectionMetadataRecord(record) || record.owner !== owner) return null;
    return { record, revision: read.document.revision };
  };

  /** 写入记录：owner 校验 + CAS；返回新 revision。 */
  const writeRecord = async (
    record: ConnectionMetadataRecord,
    expectedRevision: number | null
  ): Promise<ConnectionServiceResult<number>> => {
    const result = await documents.batch([{ op: "set", key: connectionMetadataKey(record.connectionId), value: toDocumentValue(record), expectedRevision }]);
    if (result.ok) return { ok: true, value: result.revisions[connectionMetadataKey(record.connectionId)] ?? 0 };
    if (result.code === "revision-conflict") return { ok: false, error: { code: "version-conflict", message: "连接配置已被并发修改，请重试" } };
    return { ok: false, error: { code: "storage-failed", message: result.message } };
  };

  const requireCredentials = (): ConnectionServiceResult<ApplicationExtensionSecretStore> => {
    if (!secrets) return { ok: false, error: { code: "storage-failed", message: "宿主未配置秘密仓库，无法保存凭据" } };
    return { ok: true, value: secrets };
  };

  return {
    async setRuntimeProbe(owner, connectionId, version, evidence) {
      const found = await readRecord(owner, connectionId);
      if (!found) return { ok: false, error: { code: "not-found", message: "连接不存在" } };
      const next = { ...found.record, runtimeProbe: { version, evidence }, updatedAt: now() };
      const saved = await writeRecord(next, found.revision);
      return saved.ok ? { ok: true, value: next } : saved;
    },
    async migrateRuntime(owner, connectionId, runtimeVersion, beforeMigration) {
      const found = await readRecord(owner, connectionId);
      if (!found) return { ok: false, error: { code: "not-found", message: "连接不存在" } };
      if (found.record.runtimeVersion === runtimeVersion) return { ok: true, value: { changed: false } };
      if (!beforeMigration()) return { ok: false, error: { code: "version-conflict", message: "原连接仍有活动或待核对回合，升级暂缓" } };
      const next: ConnectionMetadataRecord = { ...found.record, runtimeVersion, runCategory: "agent-sdk", configRevision: found.record.configRevision + 1, native: undefined, nativeBindings: undefined, runtimeProbe: undefined, lastStatus: undefined, updatedAt: now() };
      const saved = await documents.batch([
        { op: "set", key: `runtime-migrations/${connectionId}/${found.record.configRevision}`, value: toDocumentValue(found.record), expectedRevision: null },
        { op: "set", key: connectionMetadataKey(connectionId), value: toDocumentValue(next), expectedRevision: found.revision }
      ]);
      return saved.ok ? { ok: true, value: { changed: true } } : { ok: false, error: { code: "version-conflict", message: "连接升级未完成，请重试" } };
    },
    async list(owner) {
      const page = await documents.scan(connectionMetadataPrefix(), { limit: 500 });
      return page.entries
        .map((entry) => entry.value)
        .filter((value): value is ConnectionMetadataRecord => isConnectionMetadataRecord(value) && value.owner === owner)
        .sort((left, right) => (left.connectionId < right.connectionId ? -1 : left.connectionId > right.connectionId ? 1 : 0));
    },

    async get(owner, connectionId) {
      const found = await readRecord(owner, connectionId);
      return found?.record ?? null;
    },

    async create(owner, input) {
      if (!owner) return { ok: false, error: { code: "malformed-request", message: "缺少可信 owner" } };
      if (!input.adapterId || input.name.trim() === "") return { ok: false, error: { code: "malformed-request", message: "adapterId/name 非法" } };
      const timestamp = now();
      const record: ConnectionMetadataRecord = {
        connectionId: createId("conn"),
        ...(options.runtimeVersionFor?.(input.adapterId) ? { runtimeVersion: options.runtimeVersionFor(input.adapterId) } : {}),
        owner,
        adapterId: input.adapterId,
        name: input.name.trim(),
        runCategory: input.runCategory,
        authMode: input.authMode,
        configRevision: 1,
        credentialEpoch: 0,
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        ...(input.models ? { models: [...input.models] } : {}),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      const written = await writeRecord(record, null);
      return written.ok ? { ok: true, value: record } : written;
    },

    async update(owner, connectionId, patch) {
      const found = await readRecord(owner, connectionId);
      if (!found) return { ok: false, error: { code: "not-found", message: "连接不存在或无权访问" } };
      const next: ConnectionMetadataRecord = {
        ...found.record,
        ...(patch.adapterId !== undefined ? { adapterId: patch.adapterId } : {}),
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.runCategory !== undefined ? { runCategory: patch.runCategory } : {}),
        ...(patch.authMode !== undefined ? { authMode: patch.authMode } : {}),
        ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
        ...(patch.models !== undefined ? { models: [...patch.models] } : {}),
        ...(patch.modelCapabilities !== undefined ? { modelCapabilities: patch.modelCapabilities } : patch.baseUrl !== undefined ? { modelCapabilities: undefined } : {}),
        // 配置变化推进 revision；切换接入方式使原生会话绑定失效（design D4）。
        configRevision: found.record.configRevision + 1,
        ...(patch.adapterId !== undefined || patch.authMode !== undefined || patch.baseUrl !== undefined ? { native: undefined, nativeBindings: undefined, lastStatus: undefined } : {}),
        updatedAt: now()
      };
      const written = await writeRecord(next, found.revision);
      return written.ok ? { ok: true, value: next } : written;
    },

    async remove(owner, connectionId) {
      const found = await readRecord(owner, connectionId);
      if (!found) return { ok: false, error: { code: "not-found", message: "连接不存在或无权访问" } };
      if (secrets) {
        for (const purpose of ["model-api-key", "appserver-auth", "mcp-grant"] as const) {
          secrets.clear(owner, credentialPurposeKey(connectionId, purpose));
        }
      }
      const result = await documents.batch([{ op: "delete", key: connectionMetadataKey(connectionId), expectedRevision: found.revision }]);
      if (!result.ok) {
        if (result.code === "revision-conflict") return { ok: false, error: { code: "version-conflict", message: "连接已被并发修改，请重试" } };
        return { ok: false, error: { code: "storage-failed", message: result.message } };
      }
      return { ok: true, value: { removed: true } };
    },

    async saveCredential(input) {
      const found = await readRecord(input.owner, input.connectionId);
      if (!found) return { ok: false, error: { code: "not-found", message: "连接不存在或无权访问" } };
      const store = requireCredentials();
      if (!store.ok) return store;
      if (input.secret.trim() === "") return { ok: false, error: { code: "malformed-request", message: "凭据不能为空" } };
      // 迟到写入：期望 epoch 不匹配即拒绝（不恢复旧 Key；design D4）。
      if (input.expectedEpoch !== undefined && input.expectedEpoch !== found.record.credentialEpoch) {
        return { ok: false, error: { code: "epoch-invalid", message: "凭据已被更新，拒绝迟到写入" } };
      }
      const purposeKey = credentialPurposeKey(input.connectionId, input.purpose);
      const current = store.value.read<{ secret: string }>(input.owner, purposeKey);
      const written = store.value.write(input.owner, purposeKey, { secret: input.secret }, { version: current?.version ?? 0, epoch: store.value.epoch(input.owner) });
      if (!written.ok) return { ok: false, error: { code: written.code === "storage-failed" ? "storage-failed" : "epoch-invalid", message: written.message } };
      // 推进连接级 epoch，使旧原生会话/迟到结果失效。
      const nextEpoch = found.record.credentialEpoch + 1;
      const next: ConnectionMetadataRecord = { ...found.record, credentialEpoch: nextEpoch, native: undefined, nativeBindings: undefined, lastStatus: undefined, modelCapabilities: undefined, updatedAt: now() };
      const stored = await writeRecord(next, found.revision);
      if (!stored.ok) {
        // 元数据写入失败：清除刚写入的凭据，保持「未生效」而不是半状态。
        store.value.clear(input.owner, purposeKey);
        return stored;
      }
      return { ok: true, value: { credentialEpoch: nextEpoch } };
    },

    async clearCredential(input) {
      const found = await readRecord(input.owner, input.connectionId);
      if (!found) return { ok: false, error: { code: "not-found", message: "连接不存在或无权访问" } };
      if (secrets) secrets.clear(input.owner, credentialPurposeKey(input.connectionId, input.purpose));
      const nextEpoch = found.record.credentialEpoch + 1;
      const next: ConnectionMetadataRecord = { ...found.record, credentialEpoch: nextEpoch, native: undefined, nativeBindings: undefined, lastStatus: undefined, modelCapabilities: undefined, updatedAt: now() };
      const stored = await writeRecord(next, found.revision);
      if (!stored.ok) return stored;
      return { ok: true, value: { credentialEpoch: nextEpoch } };
    },

    async credentialConfigured(input) {
      if (!secrets) return false;
      const read = secrets.read<{ secret: string }>(input.owner, credentialPurposeKey(input.connectionId, input.purpose));
      return read !== null && typeof read.value?.secret === "string" && read.value.secret.length > 0;
    },

    readCredential<T>(input: { owner: string; connectionId: string; purpose: AgentCredentialPurpose }): Promise<T | null> {
      if (!secrets) return Promise.resolve(null);
      const read = secrets.read<T>(input.owner, credentialPurposeKey(input.connectionId, input.purpose));
      return Promise.resolve(read ? read.value : null);
    },

    async setNativeBinding(input) {
      const found = await readRecord(input.owner, input.connectionId);
      if (!found) return { ok: false, error: { code: "not-found", message: "连接不存在或无权访问" } };
      if (input.native.credentialEpoch !== found.record.credentialEpoch ||
          (input.context && (input.context.configRevision !== found.record.configRevision || input.context.credentialEpoch !== found.record.credentialEpoch))) {
        return { ok: false, error: { code: "version-conflict", message: "原生上下文已失效" } };
      }
      const next: ConnectionMetadataRecord = {
        ...found.record,
        ...(input.context ? { nativeBindings: {
          ...found.record.nativeBindings,
          [nativeContextKey(input.owner, input.connectionId, input.context)]: input.native
        } } : { native: input.native }),
        updatedAt: now()
      };
      const stored = await writeRecord(next, found.revision);
      return stored.ok ? { ok: true, value: next } : stored;
    },

    async resolveNativeBinding(input) {
      const found = await readRecord(input.owner, input.connectionId);
      if (!found) return null;
      if (input.context && (input.context.credentialEpoch !== found.record.credentialEpoch || input.context.configRevision !== found.record.configRevision)) return null;
      const binding = input.context
        ? found.record.nativeBindings?.[nativeContextKey(input.owner, input.connectionId, input.context)]
        : found.record.native;
      if (!binding || binding.credentialEpoch !== found.record.credentialEpoch) return null;
      return binding;
    },

    async setStatus(input) {
      const found = await readRecord(input.owner, input.connectionId);
      if (!found) return { ok: false, error: { code: "not-found", message: "连接不存在或无权访问" } };
      const previous = found.record.lastStatus;
      const base = previous ?? {
        transport: { state: "unknown", checkedAt: null },
        credential: { state: "unknown", checkedAt: null },
        modelAccess: { state: "unknown", checkedAt: null },
        tools: { state: "unknown", checkedAt: null }
      };
      const next: ConnectionMetadataRecord = {
        ...found.record,
        lastStatus: {
          ...base,
          ...(input.patch.transport ? { transport: input.patch.transport } : {}),
          ...(input.patch.credential ? { credential: input.patch.credential } : {}),
          ...(input.patch.modelAccess ? { modelAccess: input.patch.modelAccess } : {}),
          ...(input.patch.tools ? { tools: input.patch.tools } : {})
        },
        updatedAt: now()
      };
      const stored = await writeRecord(next, found.revision);
      return stored.ok ? { ok: true, value: next } : stored;
    }
  };
}
