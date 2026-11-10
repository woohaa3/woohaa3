/** Service source identity is independent of Agent sessions, Task IDs and tool grants.
 * Public views deliberately contain no credential references or readable secrets.
 */
export type ServiceConnectionScope = "personal" | "site";
export type ServiceConnectionKind = "api" | "oauth";
/**
 * 服务连接能力用途。
 *
 * `text` 同时表示「可作为文本模型」和「可作为 Agent 模型」：所有文本模型都视为支持工具调用，
 * 不再单独区分 discussion / target-execution。媒体用途仍按模态区分。
 */
export type ServiceConnectionPurpose = "text" | "image" | "video" | "audio" | "candidate";
export type ServiceConnectionProtocol = "responses" | "messages" | "chat-completions" | "gemini" | `provider:${string}`;
export type ServiceConnectionVersion = { configRevision: number; credentialEpoch: number };
export type ServiceConnectionEndpoint = { protocol: ServiceConnectionProtocol; baseUrl: string };
export type ServiceConnectionCapability = {
  purpose: ServiceConnectionPurpose;
  protocol: ServiceConnectionProtocol;
  modelId: string;
  imageInput: boolean;
  evidence: "adapter" | "model-directory" | "tested";
};
export type ServiceConsumerBinding = {
  bindingId: string;
  extensionId: string;
  consumer: "agent" | "provider" | "oauth";
  consumerId: string;
  purposes: readonly ServiceConnectionPurpose[];
  /** Historical model identity stays with the consumer. */
  modelKeys: readonly string[];
};
export type ServiceConnectionView = ServiceConnectionVersion & {
  serviceConnectionId: string;
  scope: ServiceConnectionScope;
  kind: ServiceConnectionKind;
  name: string;
  endpoints: readonly ServiceConnectionEndpoint[];
  capabilities: readonly ServiceConnectionCapability[];
  bindings: readonly ServiceConsumerBinding[];
  enabled: boolean;
  removed: boolean;
  credentialConfigured: boolean;
  locked: boolean;
  managedByAdministrator: boolean;
};
export type ServiceConnectionOperationResult = {
  operationId: string;
  connection: ServiceConnectionView;
};
/** Write-only credential input: never use as a read response. Empty input preserves a Key. */
export type ServiceConnectionSave = {
  operationId: string;
  serviceConnectionId?: string;
  expectedRevision: number;
  expectedCredentialEpoch: number;
  name: string;
  endpoints: readonly ServiceConnectionEndpoint[];
  secret?: string;
  clearCredential?: boolean;
  enabled?: boolean;
};

/** Strict browser write decoder. Scope, owner, credential references and capabilities are host facts. */
export function isServiceConnectionSave(value: unknown): value is ServiceConnectionSave {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const allowed = new Set(["operationId", "serviceConnectionId", "expectedRevision", "expectedCredentialEpoch", "name", "endpoints", "secret", "clearCredential", "enabled"]);
  if (Object.keys(entry).some(key => !allowed.has(key))) return false;
  if (typeof entry.operationId !== "string" || !entry.operationId || entry.operationId.length > 128 || typeof entry.name !== "string" || !entry.name.trim()) return false;
  if (![entry.expectedRevision, entry.expectedCredentialEpoch].every(number => typeof number === "number" && Number.isSafeInteger(number) && number >= 0)) return false;
  if (entry.serviceConnectionId !== undefined && (typeof entry.serviceConnectionId !== "string" || !entry.serviceConnectionId)) return false;
  if (entry.secret !== undefined && typeof entry.secret !== "string" || entry.clearCredential !== undefined && typeof entry.clearCredential !== "boolean" || entry.enabled !== undefined && typeof entry.enabled !== "boolean") return false;
  if (entry.secret && entry.clearCredential) return false;
  if (!Array.isArray(entry.endpoints) || entry.endpoints.length < 1 || entry.endpoints.length > 16) return false;
  return entry.endpoints.every(endpoint => {
    if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) return false;
    const item = endpoint as Record<string, unknown>;
    return Object.keys(item).every(key => key === "protocol" || key === "baseUrl") && typeof item.protocol === "string" &&
      (["responses", "messages", "chat-completions", "gemini"].includes(item.protocol) || /^provider:[a-z0-9][a-z0-9-]*$/.test(item.protocol)) && typeof item.baseUrl === "string" && item.baseUrl.length > 0;
  });
}

/** Backend-only adapter: owner is supplied by an authenticated host operation. Never expose this port over JSON. */
export type ServiceConnectionSourceSnapshot = Omit<ServiceConnectionView, "serviceConnectionId" | "managedByAdministrator"> & {
  legacyId: string;
  /** Opaque internal change evidence. Never returned in public views. */
  credentialFingerprint?: string;
};
export type ServiceConnectionSourceAdapter = {
  /** Keep a credential-only legacy bridge when the optional consumer is disabled. */
  retainAuthorityOnDispose?: boolean;
  id: string;
  scope: ServiceConnectionScope;
  list(owner: string): Promise<readonly ServiceConnectionSourceSnapshot[]>;
  get(owner: string, legacyId: string): Promise<ServiceConnectionSourceSnapshot | null>;
  /** OAuth adapters omit this: tokens stay inside their original authorization execution path. */
  readSecret?(owner: string, legacyId: string, expected: ServiceConnectionVersion): Promise<string | null>;
};
export type ServiceConnectionResolve = ServiceConnectionVersion & {
  serviceConnectionId: string; bindingId: string; purpose: ServiceConnectionPurpose;
  protocol: string; modelId: string; endpoint: string;
};
export type ApplicationServiceConnectionFacade = {
  registerConsumer(input: { protocols: readonly ServiceConnectionProtocol[]; purposes: readonly ServiceConnectionPurpose[] }): () => void;
  registerSource(adapter: ServiceConnectionSourceAdapter): () => void;
  /** Personal projection only. Site management uses the host's administrator boundary. */
  list(owner: string): Promise<readonly ServiceConnectionView[]>;
  get(owner: string, id: string): Promise<ServiceConnectionView | null>;
  resolve(owner: string, input: ServiceConnectionResolve): Promise<{ secret: string; endpoint: string } & ServiceConnectionVersion>;
};

export type ServiceConnectionDirectory = {
  connections: ServiceConnectionView[];
  duplicates: readonly (readonly [string, string])[];
  providers: readonly { providerId: string; protocols: readonly ServiceConnectionProtocol[]; models: readonly { modelId: string; modelKey: string; type: string }[] }[];
};
export type ServiceConnectionManagement =
  | { action: "protocol"; serviceConnectionId: string; configRevision: number; credentialEpoch: number; endpoint: ServiceConnectionEndpoint; models: readonly string[] }
  | { action: "enabled"; serviceConnectionId: string; configRevision: number; credentialEpoch: number; enabled: boolean }
  | { action: "assistant"; serviceConnectionId: string; configRevision: number; credentialEpoch: number; enabled: boolean }
  | { action: "remove"; serviceConnectionId: string; configRevision: number; credentialEpoch: number }
  | { action: "provider"; serviceConnectionId: string; configRevision: number; credentialEpoch: number; providerId: string; modelId: string }
  | { action: "merge"; operationId: string; retainedId: string; removedId: string; retained: ServiceConnectionVersion; removed: ServiceConnectionVersion };
