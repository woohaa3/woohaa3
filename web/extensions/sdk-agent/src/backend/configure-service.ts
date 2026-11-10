/** 面向设置页的一次保存：地址、凭据和模型目录一起处理，连接身份留在后端。 */
import {
  createBoundedHttpClient,
  createEndpointPolicy,
  createModelTransport,
  type ConnectionService,
} from "@woohaa3/agent-connections";
import { findSdkAgentAdapter, sdkEngineForAdapter } from "../shared.js";
import type { SdkAgentHandlerDeployment } from "./handler.js";

export type ModelServiceInput = {
  operationId?: string;
  connectionId?: string;
  adapterId: string;
  baseUrl?: string;
  secret?: string;
  models?: string[];
  expectedEpoch?: number;
  expectedRevision?: number;
};

export function normalizeModelBaseUrl(raw: string, defaultPath = "/v1"): string {
  const url = new URL(raw.trim());
  url.pathname = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/(?:chat\/completions|responses|messages|models)$/, "");
  if (!url.pathname || url.pathname === "/") url.pathname = defaultPath;
  if (url.search || url.hash || url.username || url.password)
    throw new Error("请填写不含查询参数、账号或密码的 Base URL。");
  return url.toString().replace(/\/$/, "");
}

export async function configureModelService(
  service: ConnectionService,
  deployment: SdkAgentHandlerDeployment,
  owner: string,
  input: ModelServiceInput,
) {
  const fail = (status: number, code: string, message: string) => ({
    status,
    body: { code, message },
  });
  const adapter = findSdkAgentAdapter(input.adapterId);
  if (!adapter)
    return fail(400, "connection-unsupported", "请选择支持的 API 协议。");
  let baseUrl: string;
  try {
    baseUrl = normalizeModelBaseUrl(input.baseUrl || adapter.officialBaseUrl, new URL(adapter.officialBaseUrl).pathname);
  } catch {
    return fail(
      400,
      "malformed-request",
      "Base URL 无效，请填写服务地址，例如 https://api.openai.com/v1。",
    );
  }
  if (!adapter.allowCustomBaseUrl && baseUrl !== adapter.officialBaseUrl)
    return fail(400, "endpoint-not-allowed", "当前接入方式不支持自定义 Base URL。");
  const policy = createEndpointPolicy({
    allowedHosts: deployment.allowedHosts,
    allowHttp: deployment.allowHttp,
  });
  const allowed = policy.check(baseUrl);
  if (!allowed.ok) return fail(400, allowed.code, allowed.message);
  // Stable identity, never URL matching: two accounts at the same relay remain independent.
  const existing = input.connectionId ? await service.get(owner, input.connectionId) : null;
  if (existing?.serviceConnectionId) return fail(403, "forbidden", "共享来源由管理员管理，不能另存一份 API Key。");
  if (input.connectionId && !existing)
    return fail(404, "not-found", "服务不存在或无权访问。");
  const secret = input.secret?.trim() ?? "";
  const endpointChanged = Boolean(
    existing &&
      (existing.adapterId !== adapter.adapterId ||
        (existing.baseUrl ??
          findSdkAgentAdapter(existing.adapterId)?.officialBaseUrl) !==
          baseUrl),
  );
  if (
    !secret &&
    (!existing ||
      endpointChanged ||
      !(await service.credentialConfigured({
        owner,
        connectionId: existing.connectionId,
        purpose: "model-api-key",
      })))
  )
    return fail(
      400,
      "credential-missing",
      "请填写 API Key。修改地址或格式时需要重新填写 Key。",
    );

  const config = {
    adapterId: adapter.adapterId,
    name: existing?.name ?? new URL(baseUrl).hostname,
    baseUrl,
    runCategory: adapter.runCategory,
    authMode: adapter.authMode,
  };
  const saved = await service.configure(owner, {
    ...config, operationId: input.operationId ?? crypto.randomUUID(),
    ...(existing ? { connectionId: existing.connectionId } : {}),
    ...(input.expectedEpoch !== undefined ? { expectedEpoch: input.expectedEpoch } : {}),
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
    ...(secret ? { secret } : {}),
  });
  if (!saved.ok) return fail(saved.error.code === "version-conflict" ? 409 : 500, saved.error.code, saved.error.message);
  const connectionId = saved.value.connectionId;

  const active = await service.get(owner, connectionId);
  if (!active || active.configRevision !== saved.value.configRevision || active.credentialEpoch !== saved.value.credentialEpoch) {
    // A published operation must never send a later Key to the earlier operation's endpoint.
    // Replay is a read-only acknowledgement; callers can explicitly refresh the current directory.
    return { status: 200, body: { connectionId, models: saved.value.models ?? [], modelsError: "此保存操作已完成，目录或设置已更新；请重新读取当前连接。" } };
  }
  if (secret || endpointChanged || input.models?.length) {
    const reset = await service.setStatus({
      owner,
      connectionId,
      patch: {
        transport: { state: "unknown" },
        modelAccess: { state: "unknown" },
        tools: { state: "unknown" },
      },
    });
    if (!reset.ok) return fail(500, reset.error.code, reset.error.message);
  }
  const configured = await service.get(owner, connectionId);
  let models = [
    ...new Set((input.models ?? []).map((id) => id.trim()).filter(Boolean)),
  ];
  let modelsError: string | undefined;
  if (models.length === 0) {
    const credential = await service.readCredential<{ secret: string }>({
      owner,
      connectionId,
      purpose: "model-api-key",
    });
    const apiType = sdkEngineForAdapter(adapter.adapterId)!.apiType;
    const headers: Record<string, string> =
      apiType === "anthropic"
        ? {
            "x-api-key": credential?.secret ?? "",
            "anthropic-version": "2023-06-01",
          }
        : apiType === "gemini" ? { "x-goog-api-key": credential?.secret ?? "" } : { authorization: `Bearer ${credential?.secret ?? ""}` };
    let relay: Awaited<ReturnType<typeof createModelTransport>> | undefined;
    try {
      // Production directory reads use the same checked, pinned network boundary as inference.
      // fetchImpl is an explicit test seam for deterministic directory fixtures.
      if (!deployment.fetchImpl) relay = await createModelTransport({ apiType, upstream: baseUrl, apiKey: credential?.secret ?? "", policy, valid: async () => {
        const current = await service.get(owner, connectionId);
        return current?.configRevision === configured?.configRevision && current?.credentialEpoch === configured?.credentialEpoch;
      } });
      const client = createBoundedHttpClient({
        policy: relay ? createEndpointPolicy({ allowedHosts: ["127.0.0.1"], allowHttp: true }) : policy,
        fetchImpl: deployment.fetchImpl,
        timeoutMs: 8000,
      });
      const result = await client.request<{ data?: unknown[]; models?: unknown[] }>({
        method: "GET",
        url: `${relay?.baseUrl ?? baseUrl}/models`,
        headers: relay ? { authorization: `Bearer ${relay.token}` } : headers,
        includeErrorBody: false,
      });
      const directory = result.ok ? (apiType === "gemini" ? result.value?.models : result.value?.data) : undefined;
      if (Array.isArray(directory)) {
        models = [
          ...new Set(
            directory.flatMap((item) =>
              item &&
              typeof item === "object" &&
              (("id" in item && typeof item.id === "string") || (apiType === "gemini" && "name" in item && typeof item.name === "string"))
                ? [String("id" in item ? item.id : item.name).replace(/^models\//, "")]
                : [],
            ),
          ),
        ];
      }
      if (!result.ok || models.length === 0)
        modelsError = result.ok
          ? "服务没有返回模型列表，可在下方填写模型 ID。"
          : `模型列表读取失败${result.status ? `（HTTP ${result.status}）` : ""}，可填写模型 ID 后重试。`;
    } catch {
      modelsError = "模型列表读取超时或服务不可达，可填写模型 ID 后重试。";
    } finally { await relay?.close(); }
  }
  if (models.length === 0)
    models =
      existing?.models?.length && !endpointChanged
        ? [...existing.models]
        : [];
  const latest = await service.get(owner, connectionId);
  if (
    !latest ||
    latest.configRevision !== configured?.configRevision ||
    latest.credentialEpoch !== configured?.credentialEpoch
  )
    return fail(
      409,
      "version-conflict",
      "读取模型期间设置已变化，请重新读取后再保存。",
    );
  const updated = await service.update(owner, connectionId, { models }, configured ?? undefined);
  if (!updated.ok) return fail(updated.error.code === "version-conflict" ? 409 : 500, updated.error.code, updated.error.message);
  return {
    status: 200,
    body: { connectionId, models, ...(modelsError ? { modelsError } : {}) },
  };
}
