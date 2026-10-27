/**
 * Agent 会话请求解码与形状校验
 * （change: 2026-10-12-add-agent-conversation-panel，任务 1.1 / design D2/D3）。
 *
 * 从 `conversation.ts` 拆出（业务源码规模门禁）：只含**无副作用**的请求解码与形状校验，
 * 供宿主 API 在处理前拒绝未知字段、跨画布目标、空 requestId 与非法对象动作。浏览器安全的
 * 纯类型/纯函数：不含 SQLite、SDK、HTTP handler 或秘密。
 */
import { isBoundedId, isJsonObject, isNonEmptyString } from "../validation.js";
import {
  isAgentEntryAction,
  isAgentReasoningEffort,
  type AgentReasoningEffort,
  isAgentTargetMode,
  type AgentCatalogSnapshot,
  type AgentEntryIntent,
  type AgentEntryReference,
  type AgentTargetMode,
  type AgentConversationDecodeResult
} from "./conversation.js";

function fail(code: string, message: string): AgentConversationDecodeResult<never> {
  return { ok: false, code, message };
}

function readId(value: unknown, key: string): string | { error: string } {
  if (!isBoundedId(value)) return { error: `${key} 必须是非空短字符串` };
  return value;
}

/** 解码创建会话请求。`nodeId` 关联生成目标节点（一个节点复用一条会话；design D8）。 */
export type CreateConversationRequest = { canvasId: string; adapterId?: string; title?: string; nodeId?: string; connectionId?: string };

export function decodeCreateConversationRequest(body: unknown): AgentConversationDecodeResult<CreateConversationRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readId(body.canvasId, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (body.adapterId !== undefined && !isBoundedId(body.adapterId)) return fail("malformed-request", "adapterId 非法");
  if (body.title !== undefined && (typeof body.title !== "string" || body.title.length > 200)) return fail("malformed-request", "title 非法");
  if (body.nodeId !== undefined && !isBoundedId(body.nodeId)) return fail("malformed-request", "nodeId 非法");
  if (body.connectionId !== undefined && !isBoundedId(body.connectionId)) return fail("malformed-request", "connectionId 非法");
  return {
    ok: true,
    value: {
      canvasId,
      ...(body.adapterId === undefined ? {} : { adapterId: body.adapterId as string }),
      ...(body.title === undefined ? {} : { title: body.title as string }),
      ...(body.nodeId === undefined ? {} : { nodeId: body.nodeId as string }),
      ...(body.connectionId === undefined ? {} : { connectionId: body.connectionId as string })
    }
  };
}

/** 解码清空节点上下文请求（解除目标关联并归档旧会话；design D8）。 */
export type ClearContextRequest = { canvasId: string; nodeId: string };

export function decodeClearContextRequest(body: unknown): AgentConversationDecodeResult<ClearContextRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readId(body.canvasId, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  const nodeId = readId(body.nodeId, "nodeId");
  if (typeof nodeId === "object") return fail("malformed-request", nodeId.error);
  return { ok: true, value: { canvasId, nodeId } };
}

/**
 * 解码切换来源连接请求（change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 2.3）。
 *
 * 显式切换会解除目标关联（归档旧会话，保留历史）；活动回合仍由服务层拒绝。
 */
export type SwitchConnectionRequest = { canvasId: string; nodeId: string; connectionId: string };

export function decodeSwitchConnectionRequest(body: unknown): AgentConversationDecodeResult<SwitchConnectionRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readId(body.canvasId, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  const nodeId = readId(body.nodeId, "nodeId");
  if (typeof nodeId === "object") return fail("malformed-request", nodeId.error);
  const connectionId = readId(body.connectionId, "connectionId");
  if (typeof connectionId === "object") return fail("malformed-request", connectionId.error);
  return { ok: true, value: { canvasId, nodeId, connectionId } };
}

/**
 * 解码接受回合请求。
 *
 * 空 requestId、跨画布目标或空 prompt 在执行前拒绝；目标节点/模式的语义校验由服务端完成。
 */
export type AcceptTurnRequest = {
  requestId: string;
  entry: AgentEntryIntent;
};

export function decodeAcceptTurnRequest(body: unknown): AgentConversationDecodeResult<AcceptTurnRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const requestId = readId(body.requestId, "requestId");
  if (typeof requestId === "object") return fail("malformed-request", requestId.error);
  if (Object.keys(body).some(key => !["requestId", "entry"].includes(key))) return fail("malformed-request", "请求包含私有或未知字段");
  const entryRaw = body.entry;
  if (!isJsonObject(entryRaw)) return fail("malformed-request", "entry 必须是对象");
  if (Object.keys(entryRaw).some(key => !["action", "canvasId", "nodeId", "mode", "cameraId", "clipId", "itemId", "model", "reasoningEffort", "connectionId", "connection", "expectedContentHash", "prompt", "references"].includes(key))) return fail("malformed-request", "entry 包含私有或未知字段");
  if (entryRaw.mode === "text" && ["cameraId", "clipId", "itemId"].some(key => entryRaw[key] !== undefined)) return fail("malformed-request", "文本目标不能带片场或镜头身份");
  const binding = entryRaw.connection;
  if (binding !== undefined && (!isJsonObject(binding) || Object.keys(binding).some(key => !["connectionId", "adapterId", "configRevision", "credentialEpoch"].includes(key)) || !isBoundedId(binding.connectionId) || !isBoundedId(binding.adapterId) || ![binding.configRevision, binding.credentialEpoch].every(n => Number.isSafeInteger(n) && (n as number) >= 0))) return fail("malformed-request", "connection 非法");
  const action = entryRaw.action;
  if (!isAgentEntryAction(action)) return fail("malformed-request", "action 必须是 discuss / generate / modify");
  const canvasId = readId(entryRaw.canvasId, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (typeof entryRaw.prompt !== "string" || entryRaw.prompt.trim() === "") {
    return fail("malformed-request", "prompt 必须是非空字符串");
  }
  if (entryRaw.prompt.length > 20_000) return fail("malformed-request", "prompt 超过 20000 字符");
  if (entryRaw.nodeId !== undefined && !isBoundedId(entryRaw.nodeId)) return fail("malformed-request", "nodeId 非法");
  if (entryRaw.mode !== undefined && !isAgentTargetMode(entryRaw.mode)) return fail("malformed-request", "mode 非法");
  if (entryRaw.cameraId !== undefined && !isBoundedId(entryRaw.cameraId)) return fail("malformed-request", "cameraId 非法");
  if (entryRaw.clipId !== undefined && !isBoundedId(entryRaw.clipId)) return fail("malformed-request", "clipId 非法");
  if (entryRaw.itemId !== undefined && !isBoundedId(entryRaw.itemId)) return fail("malformed-request", "itemId 非法");
  if (entryRaw.expectedContentHash !== undefined && typeof entryRaw.expectedContentHash !== "string") {
    return fail("malformed-request", "expectedContentHash 非法");
  }
  if (entryRaw.model !== undefined && !isBoundedId(entryRaw.model)) return fail("malformed-request", "model 非法");
  if (entryRaw.connectionId !== undefined && !isBoundedId(entryRaw.connectionId)) return fail("malformed-request", "connectionId 非法");
  if (entryRaw.reasoningEffort !== undefined && !isAgentReasoningEffort(entryRaw.reasoningEffort)) return fail("malformed-request", "reasoningEffort 非法");
  const references = decodeReferences(entryRaw.references);
  if (references === null) return fail("malformed-request", "references 非法");

  const entry: AgentEntryIntent = {
    ...(binding === undefined ? {} : { connection: binding as AgentEntryIntent["connection"] }),
    action,
    canvasId,
    ...(entryRaw.nodeId === undefined ? {} : { nodeId: entryRaw.nodeId as string }),
    ...(entryRaw.mode === undefined ? {} : { mode: entryRaw.mode as AgentTargetMode }),
    ...(entryRaw.cameraId === undefined ? {} : { cameraId: entryRaw.cameraId as string }),
    ...(entryRaw.clipId === undefined ? {} : { clipId: entryRaw.clipId as string }),
    ...(entryRaw.itemId === undefined ? {} : { itemId: entryRaw.itemId as string }),
    ...(entryRaw.model === undefined ? {} : { model: entryRaw.model as string }),
    ...(entryRaw.reasoningEffort === undefined ? {} : { reasoningEffort: entryRaw.reasoningEffort as AgentReasoningEffort }),
    ...(entryRaw.connectionId === undefined ? {} : { connectionId: entryRaw.connectionId as string }),
    ...(entryRaw.expectedContentHash === undefined ? {} : { expectedContentHash: entryRaw.expectedContentHash as string }),
    prompt: entryRaw.prompt,
    ...(references === undefined ? {} : { references })
  };

  // 对象类目标动作缺少片段身份：拒绝并说明，MUST NOT 扩大成整体片场修改（design D3/任务 4.2）。
  if ((action === "modify" || (action === "generate" && entry.mode === "film-set")) && entry.itemId !== undefined && entry.clipId === undefined) {
    return fail("malformed-request", "对象动作缺少 clipId，拒绝退化成整体片场修改");
  }
  if ((entry.mode === "camera" || entry.mode === "canvas-group") && entry.nodeId === undefined) {
    return fail("malformed-request", "camera 目标必须带 nodeId");
  }
  return { ok: true, value: { requestId, entry } };
}

function decodeReferences(value: unknown): readonly AgentEntryReference[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const out: AgentEntryReference[] = [];
  for (const raw of value) {
    if (!isJsonObject(raw)) return null;
    if (raw.kind !== "asset" && raw.kind !== "node") return null;
    const reference: AgentEntryReference = { kind: raw.kind };
    if (raw.storageKey !== undefined) {
      if (typeof raw.storageKey !== "string" || raw.storageKey.length === 0 || raw.storageKey.length > 300) return null;
      reference.storageKey = raw.storageKey;
    }
    if (raw.nodeId !== undefined) {
      if (!isBoundedId(raw.nodeId)) return null;
      reference.nodeId = raw.nodeId;
    }
    if (raw.role !== undefined) {
      if (typeof raw.role !== "string" || raw.role.length > 100) return null;
      reference.role = raw.role;
    }
    out.push(reference);
  }
  return out;
}

/** 解码显式运行关联（宿主内部/受控面使用）。 */
export type LinkRunRequest = { runId?: string; taskId?: string };
export function decodeLinkRunRequest(body: unknown): AgentConversationDecodeResult<LinkRunRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  if (body.runId !== undefined && !isBoundedId(body.runId)) return fail("malformed-request", "runId 非法");
  if (body.taskId !== undefined && !isBoundedId(body.taskId)) return fail("malformed-request", "taskId 非法");
  if (body.runId === undefined && body.taskId === undefined) return fail("malformed-request", "至少提供 runId 或 taskId");
  return {
    ok: true,
    value: {
      ...(body.runId === undefined ? {} : { runId: body.runId as string }),
      ...(body.taskId === undefined ? {} : { taskId: body.taskId as string })
    }
  };
}

/** 解码 cursor 查询（事件重放/回合查询）。 */
export function decodeCursorQuery(value: string | null | undefined): number {
  if (typeof value !== "string" || value.trim() === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

/** 解码 adapter id 列表（会话列表筛选；缺省全部）。 */
export function decodeAdapterQuery(value: string | null | undefined): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return isBoundedId(value) ? value : undefined;
}

/** 校验 adapter 目录/授权响应形状（宿主解析 capability 后使用）。 */
export function isAgentCatalogSnapshot(value: unknown): value is AgentCatalogSnapshot {
  if (!isJsonObject(value)) return false;
  if (!Array.isArray(value.models)) return false;
  const shapeOk = value.models.every((entry) => isJsonObject(entry) && isBoundedId(entry.id) && typeof entry.label === "string" && (entry.reasoningEfforts === undefined || (Array.isArray(entry.reasoningEfforts) && entry.reasoningEfforts.every(isAgentReasoningEffort))));
  if (!shapeOk) return false;
  return value.error === undefined || typeof value.error === "string";
}

export function isAgentEntryIntent(value: unknown): value is AgentEntryIntent {
  if (!isJsonObject(value)) return false;
  if (!isAgentEntryAction(value.action)) return false;
  if (!isBoundedId(value.canvasId)) return false;
  if (!isNonEmptyString(value.prompt)) return false;
  if (value.nodeId !== undefined && !isBoundedId(value.nodeId)) return false;
  if (value.mode !== undefined && !isAgentTargetMode(value.mode)) return false;
  if (value.model !== undefined && !isBoundedId(value.model)) return false;
  if (value.reasoningEffort !== undefined && !isAgentReasoningEffort(value.reasoningEffort)) return false;
  if (value.connectionId !== undefined && !isBoundedId(value.connectionId)) return false;
  if (value.references !== undefined) {
    if (!Array.isArray(value.references)) return false;
    if (!value.references.every((entry) => isJsonObject(entry) && (entry.kind === "asset" || entry.kind === "node"))) return false;
  }
  return true;
}

/** 供内部审计：references 中的 storageKey 形态（仅显式引用，不推断）。 */
export function referenceStorageKeys(intent: AgentEntryIntent): string[] {
  const out: string[] = [];
  for (const reference of intent.references ?? []) {
    if (reference.kind === "asset" && reference.storageKey) out.push(reference.storageKey);
  }
  return out;
}
