/**
 * sdk-agent 连接设置 remote adapter（extension 前端 owner）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 2.5/5.3 / design D4）。
 *
 * 浏览器访问 `/api/sdk-agent/*` 的唯一出口，复用宿主注入的 `ApplicationRemoteTransport`；
 * **绝不**持久化或回读明文 Key：Key 只在一次 POST 请求体里出现，成功后组件清空字段。
 * 本 adapter 只解释业务协议（路由与 DTO）。
 */
import type { ApplicationRemoteTransport } from "@woohaa3/frontend/extension-api";

export type SdkAgentConnectionView = {
  connectionId: string;
  adapterId: string;
  name: string;
  label: string;
  authMode: string;
  runCategory: string;
  configRevision: number;
  credentialEpoch: number;
  credentialConfigured: boolean;
  needsLocalRuntime: boolean;
  allowCustomBaseUrl: boolean;
  baseUrl?: string;
  models: string[];
  lastStatus?: unknown;
};

export type SdkAgentAdapterView = {
  adapterId: string;
  label: string;
  runCategory: string;
  authMode: string;
  officialBaseUrl: string;
  allowCustomBaseUrl: boolean;
  requiresLocalRuntime: boolean;
  suggestedModels: readonly string[];
};

export type SdkAgentCheckResult = {
  transport: string;
  credential: string;
  modelAccess: string;
  tools: string;
  note: string;
};

export type SdkAgentRemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code?: string };

export type SdkAgentConfigureInput = {
  operationId?: string;
  connectionId?: string;
  adapterId: string;
  baseUrl?: string;
  secret?: string;
  models?: string[];
  expectedEpoch?: number;
  expectedRevision?: number;
};
export type SdkAgentTestConnectionResult = {
  ok: boolean;
  models?: string[];
  message: string;
  code?: string;
};

export type SdkAgentRemote = {
  testConnection?: (
    input: SdkAgentConfigureInput,
  ) => Promise<SdkAgentRemoteResult<SdkAgentTestConnectionResult>>;
  configure: (
    input: SdkAgentConfigureInput,
  ) => Promise<
    SdkAgentRemoteResult<{
      connectionId: string;
      models: string[];
      modelsError?: string;
    }>
  >;
  list: () => Promise<
    SdkAgentRemoteResult<{
      connections: SdkAgentConnectionView[];
      adapters: SdkAgentAdapterView[];
    }>
  >;
  create: (input: {
    adapterId: string;
    name?: string;
    baseUrl?: string;
    models?: string[];
  }) => Promise<SdkAgentRemoteResult<{ connectionId: string }>>;
  saveCredential: (input: {
    connectionId: string;
    secret: string;
    expectedEpoch?: number;
  }) => Promise<
    SdkAgentRemoteResult<{
      credentialConfigured: boolean;
      credentialEpoch: number;
    }>
  >;
  clearCredential: (
    connectionId: string,
  ) => Promise<
    SdkAgentRemoteResult<{
      credentialConfigured: boolean;
      credentialEpoch: number;
    }>
  >;
  remove: (
    connectionId: string,
  ) => Promise<SdkAgentRemoteResult<{ removed: boolean }>>;
  check: (
    connectionId: string,
  ) => Promise<SdkAgentRemoteResult<SdkAgentCheckResult>>;
  testGeneration: (input: {
    connectionId: string;
    model?: string;
  }) => Promise<
    SdkAgentRemoteResult<{
      ok: boolean;
      model: string;
      assistantText?: string;
      code?: string;
      message?: string;
    }>
  >;
};

export type SdkAgentRemoteOptions = {
  basePath?: string;
  transport: ApplicationRemoteTransport;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createSdkAgentRemote(
  options: SdkAgentRemoteOptions,
): SdkAgentRemote {
  const basePath = (options.basePath ?? "/api/sdk-agent").replace(/\/$/, "");
  const transport = options.transport;
  const path = (suffix: string) => `${basePath}/${suffix}`;

  const fail = (
    result: { error: string; code?: string },
    fallback: string,
  ): SdkAgentRemoteResult<never> => ({
    ok: false,
    error: result.error !== "" ? result.error : fallback,
    ...(result.code ? { code: result.code } : {}),
  });

  return {
    async testConnection(input) {
      const result = await transport.request({
        path: path("test-connection"),
        method: "POST",
        body: input,
      });
      if (!result.ok) return fail(result, "连接测试失败");
      if (!isRecord(result.data) || typeof result.data.ok !== "boolean")
        return { ok: false, error: "测试响应无法识别" };
      return {
        ok: true,
        value: result.data as unknown as SdkAgentTestConnectionResult,
      };
    },
    async configure(input) {
      const result = await transport.request({
        path: path("configure"),
        method: "POST",
        body: input,
      });
      if (!result.ok) return fail(result, "服务设置保存失败");
      if (
        !isRecord(result.data) ||
        typeof result.data.connectionId !== "string" ||
        !Array.isArray(result.data.models)
      )
        return { ok: false, error: "保存响应无法识别" };
      return {
        ok: true,
        value: result.data as {
          connectionId: string;
          models: string[];
          modelsError?: string;
        },
      };
    },
    async list() {
      const result = await transport.request({
        path: path("connections"),
        method: "GET",
      });
      if (!result.ok) return fail(result, "无法读取连接列表");
      const body = result.data;
      if (!isRecord(body) || !Array.isArray(body.connections))
        return { ok: false, error: "连接列表响应无法识别" };
      return {
        ok: true,
        value: {
          connections: body.connections as SdkAgentConnectionView[],
          adapters: (Array.isArray(body.adapters)
            ? body.adapters
            : []) as SdkAgentAdapterView[],
        },
      };
    },
    async create(input) {
      const result = await transport.request({
        path: path("connections"),
        method: "POST",
        body: input,
      });
      if (!result.ok) return fail(result, "创建连接失败");
      if (
        !isRecord(result.data) ||
        typeof result.data.connectionId !== "string"
      )
        return { ok: false, error: "创建响应无法识别" };
      return { ok: true, value: { connectionId: result.data.connectionId } };
    },
    async saveCredential(input) {
      const result = await transport.request({
        path: path(
          `connections/${encodeURIComponent(input.connectionId)}/credential`,
        ),
        method: "POST",
        body: {
          secret: input.secret,
          ...(input.expectedEpoch !== undefined
            ? { expectedEpoch: input.expectedEpoch }
            : {}),
        },
      });
      if (!result.ok) return fail(result, "保存 Key 失败");
      if (
        !isRecord(result.data) ||
        typeof result.data.credentialEpoch !== "number"
      )
        return { ok: false, error: "保存响应无法识别" };
      return {
        ok: true,
        value: {
          credentialConfigured: true,
          credentialEpoch: result.data.credentialEpoch,
        },
      };
    },
    async clearCredential(connectionId) {
      const result = await transport.request({
        path: path(`connections/${encodeURIComponent(connectionId)}/clear`),
        method: "POST",
        body: {},
      });
      if (!result.ok) return fail(result, "清除 Key 失败");
      if (
        !isRecord(result.data) ||
        typeof result.data.credentialEpoch !== "number"
      )
        return { ok: false, error: "清除响应无法识别" };
      return {
        ok: true,
        value: {
          credentialConfigured: false,
          credentialEpoch: result.data.credentialEpoch,
        },
      };
    },
    async remove(connectionId) {
      const result = await transport.request({
        path: path(`connections/${encodeURIComponent(connectionId)}/delete`),
        method: "POST",
        body: {},
      });
      if (!result.ok) return fail(result, "删除连接失败");
      return { ok: true, value: { removed: true } };
    },
    async check(connectionId) {
      const result = await transport.request({
        path: path("check"),
        method: "POST",
        body: { connectionId },
      });
      if (!result.ok) return fail(result, "连接检查失败");
      if (!isRecord(result.data))
        return { ok: false, error: "检查响应无法识别" };
      return { ok: true, value: result.data as unknown as SdkAgentCheckResult };
    },
    async testGeneration(input) {
      const result = await transport.request({
        path: path("test-generation"),
        method: "POST",
        body: input,
      });
      if (!result.ok) return fail(result, "测试生成失败");
      if (!isRecord(result.data))
        return { ok: false, error: "测试响应无法识别" };
      return {
        ok: true,
        value: result.data as unknown as {
          ok: boolean;
          model: string;
          assistantText?: string;
          code?: string;
          message?: string;
        },
      };
    },
  };
}
