/**
 * Agent 连接请求解码与形状校验（无副作用）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 1.1/1.4/1.5）。
 *
 * 供贡献方扩展与宿主在**副作用之前**拒绝未知字段、非法 authMode、空连接身份与越界 base URL。
 * 浏览器安全的纯函数：不含 SQLite、SDK、HTTP handler 或秘密。
 */
import { isBoundedId, isJsonObject } from "../validation.js";
import {
  isAgentConnectionAuthMode,
  isAgentConnectionCheckKind,
  isAgentConnectionRunCategory,
  isAgentCredentialPurpose,
  type AgentConnectionDecodeResult,
  type AgentConnectionAuthMode,
  type AgentConnectionRunCategory,
  type AgentCredentialPurpose
} from "./agent-connection.js";

function fail(code: string, message: string): AgentConnectionDecodeResult<never> {
  return { ok: false, code, message };
}

function readId(value: unknown, key: string): string | { error: string } {
  if (!isBoundedId(value)) return { error: `${key} 必须是非空短字符串` };
  return value;
}

/**
 * 兼容 API 的 base URL 允许策略输入。
 *
 * 只做**语法**校验（http/https、无 userinfo、无片段）；主机允许范围由部署策略在后端判定，
 * 本函数不代替允许清单。
 */
export function normalizeEndpointUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hash !== "") return null;
  return url.toString();
}

/** 创建/更新连接的非秘密配置。 */
export type AgentConnectionConfigRequest = {
  adapterId: string;
  name: string;
  runCategory: AgentConnectionRunCategory;
  authMode: AgentConnectionAuthMode;
  /** 自定义 endpoint（仅兼容 API；官方 SDK 不接受）。 */
  baseUrl?: string;
  /** 显式模型（无目录时用户手填；不冒充账号已授权）。 */
  models?: readonly string[];
};

export function decodeAgentConnectionConfigRequest(
  body: unknown
): AgentConnectionDecodeResult<AgentConnectionConfigRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const adapterId = readId(body.adapterId, "adapterId");
  if (typeof adapterId === "object") return fail("malformed-request", adapterId.error);
  if (typeof body.name !== "string" || body.name.trim() === "" || body.name.length > 120) {
    return fail("malformed-request", "name 必须是非空短字符串");
  }
  if (!isAgentConnectionRunCategory(body.runCategory)) return fail("malformed-request", "runCategory 非法");
  if (!isAgentConnectionAuthMode(body.authMode)) return fail("malformed-request", "authMode 非法");
  let baseUrl: string | undefined;
  if (body.baseUrl !== undefined) {
    const normalized = normalizeEndpointUrl(body.baseUrl);
    if (normalized === null) return fail("malformed-request", "baseUrl 必须是合法的 http(s) 地址且不含凭据/片段");
    baseUrl = normalized;
  }
  let models: string[] | undefined;
  if (body.models !== undefined) {
    if (!Array.isArray(body.models) || body.models.length > 50) return fail("malformed-request", "models 非法");
    const out: string[] = [];
    for (const entry of body.models) {
      if (!isBoundedId(entry)) return fail("malformed-request", "models 项非法");
      if (!out.includes(entry)) out.push(entry);
    }
    models = out;
  }
  return {
    ok: true,
    value: {
      adapterId,
      name: body.name.trim(),
      runCategory: body.runCategory,
      authMode: body.authMode,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(models === undefined ? {} : { models })
    }
  };
}

/** 保存凭据请求（明文只在本次请求体出现；后端加密保存后不回读）。 */
export type SaveAgentCredentialRequest = {
  connectionId: string;
  purpose: AgentCredentialPurpose;
  /** 明文密钥/口令；后端处理后前端 MUST 清空字段。 */
  secret: string;
  /** 期望当前凭据 epoch（可选）；不匹配视为失效写入。 */
  expectedEpoch?: number;
};

export function decodeSaveAgentCredentialRequest(
  body: unknown
): AgentConnectionDecodeResult<SaveAgentCredentialRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const connectionId = readId(body.connectionId, "connectionId");
  if (typeof connectionId === "object") return fail("malformed-request", connectionId.error);
  if (!isAgentCredentialPurpose(body.purpose)) return fail("malformed-request", "purpose 非法");
  if (typeof body.secret !== "string" || body.secret.trim() === "" || body.secret.length > 8192) {
    return fail("malformed-request", "secret 必须是非空有界字符串");
  }
  if (body.expectedEpoch !== undefined && (typeof body.expectedEpoch !== "number" || !Number.isInteger(body.expectedEpoch) || body.expectedEpoch < 0)) {
    return fail("malformed-request", "expectedEpoch 非法");
  }
  return {
    ok: true,
    value: {
      connectionId,
      purpose: body.purpose,
      secret: body.secret,
      ...(body.expectedEpoch === undefined ? {} : { expectedEpoch: body.expectedEpoch as number })
    }
  };
}

/** 清除凭据请求。 */
export type ClearAgentCredentialRequest = { connectionId: string; purpose: AgentCredentialPurpose };

export function decodeClearAgentCredentialRequest(
  body: unknown
): AgentConnectionDecodeResult<ClearAgentCredentialRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const connectionId = readId(body.connectionId, "connectionId");
  if (typeof connectionId === "object") return fail("malformed-request", connectionId.error);
  if (!isAgentCredentialPurpose(body.purpose)) return fail("malformed-request", "purpose 非法");
  return { ok: true, value: { connectionId, purpose: body.purpose } };
}

/** 连接检查请求：默认 probe（无生成），`generation` 需用户显式触发。 */
export type CheckAgentConnectionRequest = {
  connectionId: string;
  kind: import("./agent-connection.js").AgentConnectionCheckKind;
  /** 测试生成的模型（kind=generation 时必须显式）。 */
  model?: string;
};

export function decodeCheckAgentConnectionRequest(
  body: unknown
): AgentConnectionDecodeResult<CheckAgentConnectionRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const connectionId = readId(body.connectionId, "connectionId");
  if (typeof connectionId === "object") return fail("malformed-request", connectionId.error);
  const kind = body.kind ?? "probe";
  if (!isAgentConnectionCheckKind(kind)) return fail("malformed-request", "kind 非法");
  if (kind === "generation" && !isBoundedId(body.model)) return fail("malformed-request", "测试生成必须显式提供 model");
  return {
    ok: true,
    value: {
      connectionId,
      kind,
      ...(body.model === undefined ? {} : { model: body.model as string })
    }
  };
}

/** 连接查询（按 id 或 adapter 过滤；缺省全部可见连接）。 */
export type AgentConnectionQuery = { adapterId?: string };

export function decodeAgentConnectionQuery(value: string | null | undefined): AgentConnectionQuery {
  if (typeof value !== "string" || value.trim() === "") return {};
  return isBoundedId(value) ? { adapterId: value } : {};
}
