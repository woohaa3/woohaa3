import { randomUUID } from "node:crypto";
import { createSdkAgentConversationAdapter, type SdkAgentRuntimeOptions } from "./sdk-agent-connections.js";
import { createFixedEngineRuntime } from "./fixed-engine-runtime.js";
import { sdkEngineForAdapter } from "../shared.js";
/**
 * sdk-agent 受控 HTTP handler（连接设置 / Key 生命周期 / 探测 / 测试生成）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 1.4/1.5/5.3 / design D3/D4）。
 *
 * 宿主在进入前完成认证、Origin/CSRF 与预算校验并注入可信 `context`；owner 只取
 * `context.principal.subject`（绝不来自请求体）。本 handler：
 * - `GET  /api/sdk-agent/connections`：列出 owner 可见连接（不含秘密）；
 * - `POST /api/sdk-agent/configure`：一次保存地址、Key 并读取模型目录，不触发生成；
 * - `POST /api/sdk-agent/connections`：旧客户端创建连接（写设置，不调用模型）；
 * - `POST /api/sdk-agent/connections/<id>/credential`：保存/替换 Key（明文只在此请求出现）；
 * - `DELETE /api/sdk-agent/connections/<id>/credential`：清除 Key（推进 epoch）；
 * - `DELETE /api/sdk-agent/connections/<id>`：删除连接（清凭据、保留历史）；
 * - `POST /api/sdk-agent/check`：无生成探测（不收费）；
 * - `POST /api/sdk-agent/test-generation`：显式最小生成（用户触发；失败不自动换模型）。
 */
import type {
  ApplicationExtensionRawRequest,
  ApplicationExtensionRawResponse,
  ApplicationExtensionRequestContext,
  ApplicationToolDelegationFacade,
} from "@woohaa3/contracts";
import {
  createEndpointPolicy,
  type ConnectionService,
} from "@woohaa3/agent-connections";
import {
  findSdkAgentAdapter,
  SDK_AGENT_ADAPTERS,
  type SdkAgentAdapterId,
} from "../shared.js";
import {
  configureModelService,
  type ModelServiceInput,
} from "./configure-service.js";

export type SdkAgentHandlerDeployment = {
  allowedHosts?: readonly string[];
  allowHttp: boolean;
  agentSdkDirs?: { workspaceDir: string; configDir: string };
  mcpServerUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
};

export type SdkAgentHandlerOptions = {
  service: ConnectionService;
  deployment: SdkAgentHandlerDeployment;
  tools?: ApplicationToolDelegationFacade;
  runtimeOptions?: SdkAgentRuntimeOptions;
};

const BASE_PATH = "/api/sdk-agent";

export function createSdkAgentHandler(options: SdkAgentHandlerOptions) {
  const { service, deployment } = options;
  const configureQueues = new Map<string, Promise<void>>();

  const sendJson = (
    res: ApplicationExtensionRawResponse,
    status: number,
    payload: unknown,
  ) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(payload));
  };

  const readBody = async (
    req: ApplicationExtensionRawRequest,
  ): Promise<unknown> => {
    const chunks: Buffer[] = [];
    return await new Promise((resolve) => {
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (text.trim() === "") return resolve({});
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(null);
        }
      });
      req.on("error", () => resolve(null));
    });
  };

  const handle = async (
    req: ApplicationExtensionRawRequest,
    res: ApplicationExtensionRawResponse,
    context: ApplicationExtensionRequestContext,
  ): Promise<void> => {
    const owner = context.principal?.subject;
    if (!owner)
      return sendJson(res, 401, {
        code: "unauthorized",
        message: "缺少可信身份",
      });
    const url = new URL(req.url ?? BASE_PATH, "http://localhost");
    const suffix = url.pathname.startsWith(BASE_PATH)
      ? url.pathname.slice(BASE_PATH.length).replace(/^\/+/, "")
      : "";
    const method = (req.method ?? "GET").toUpperCase();
    const segments = suffix.split("/").filter((part) => part !== "");

    // 一次保存地址、Key 与模型目录；同一用户的并发保存串行处理，避免重复创建。
    if (suffix === "configure" && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown> | null;
      if (
        !body ||
        typeof body.adapterId !== "string" ||
        ["secret", "baseUrl", "connectionId"].some(
          (key) => body[key] !== undefined && typeof body[key] !== "string",
        )
      )
        return sendJson(res, 400, {
          code: "malformed-request",
          message: "服务配置格式无效",
        });
      const previous = configureQueues.get(owner) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      configureQueues.set(owner, current);
      await previous;
      try {
        const result = await configureModelService(service, deployment, owner, {
          adapterId: body.adapterId,
          ...(typeof body.operationId === "string" ? { operationId: body.operationId } : {}),
          ...(typeof body.connectionId === "string"
            ? { connectionId: body.connectionId }
            : {}),
          ...(typeof body.baseUrl === "string"
            ? { baseUrl: body.baseUrl }
            : {}),
          ...(typeof body.secret === "string" ? { secret: body.secret } : {}),
          ...(typeof body.expectedEpoch === "number"
            ? { expectedEpoch: body.expectedEpoch }
            : {}),
          ...(typeof body.expectedRevision === "number"
            ? { expectedRevision: body.expectedRevision }
            : {}),
          ...(Array.isArray(body.models)
            ? {
                models: body.models.filter(
                  (id): id is string => typeof id === "string",
                ),
              }
            : {}),
        } satisfies ModelServiceInput);
        return sendJson(res, result.status, result.body);
      } finally {
        release();
        if (configureQueues.get(owner) === current)
          configureQueues.delete(owner);
      }
    }

    // GET /connections：列出可见连接（只读；不含秘密）。
    if (
      segments.length === 1 &&
      segments[0] === "connections" &&
      method === "GET"
    ) {
      const records = await service.list(owner);
      const connections = await Promise.all(
        records.map(async (record) => {
          const adapter = findSdkAgentAdapter(record.adapterId);
          const credentialConfigured = await service.credentialConfigured({
            owner,
            connectionId: record.connectionId,
            purpose: "model-api-key",
          });
          return {
            connectionId: record.connectionId,
            adapterId: record.adapterId,
            name: record.name,
            label: adapter?.label ?? record.adapterId,
            authMode: record.authMode,
            runCategory: record.runCategory,
            configRevision: record.configRevision,
            credentialEpoch: record.credentialEpoch,
            credentialConfigured,
            needsLocalRuntime: adapter?.requiresLocalRuntime ?? false,
            allowCustomBaseUrl: adapter?.allowCustomBaseUrl ?? false,
            baseUrl: record.baseUrl,
            models: record.models ?? [],
            lastStatus: record.lastStatus,
          };
        }),
      );
      return sendJson(res, 200, { connections, adapters: SDK_AGENT_ADAPTERS });
    }

    // POST /connections：创建连接（写设置；不调用模型）。
    if (
      segments.length === 1 &&
      segments[0] === "connections" &&
      method === "POST"
    ) {
      const body = (await readBody(req)) as Record<string, unknown> | null;
      if (!body || typeof body.adapterId !== "string")
        return sendJson(res, 400, {
          code: "malformed-request",
          message: "缺少 adapterId",
        });
      const adapter = findSdkAgentAdapter(body.adapterId);
      if (!adapter)
        return sendJson(res, 400, {
          code: "connection-unsupported",
          message: "未知接入方式",
        });
      const baseUrl =
        typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
      if (baseUrl !== "" && !adapter.allowCustomBaseUrl) {
        return sendJson(res, 400, {
          code: "endpoint-not-allowed",
          message: "当前接入方式不接受自定义 Base URL",
        });
      }
      if (baseUrl !== "") {
        const check = createEndpointPolicy({
          allowedHosts: deployment.allowedHosts,
          allowHttp: deployment.allowHttp,
        }).check(baseUrl);
        if (!check.ok)
          return sendJson(res, 400, {
            code: check.code,
            message: check.message,
          });
      }
      const models = Array.isArray(body.models)
        ? (body.models as unknown[]).filter(
            (entry): entry is string =>
              typeof entry === "string" && entry !== "",
          )
        : undefined;
      const created = await service.create(owner, {
        adapterId: adapter.adapterId,
        name:
          typeof body.name === "string" && body.name.trim() !== ""
            ? body.name
            : adapter.label,
        runCategory: adapter.runCategory,
        authMode: adapter.authMode,
        ...(baseUrl !== "" ? { baseUrl } : {}),
        ...(models && models.length > 0 ? { models } : {}),
      });
      if (!created.ok)
        return sendJson(
          res,
          created.error.code === "version-conflict" ? 409 : 500,
          created.error,
        );
      return sendJson(res, 200, { connectionId: created.value.connectionId });
    }

    // /connections/<id>[/credential|/clear|/delete]
    if (segments.length >= 2 && segments[0] === "connections") {
      const connectionId = decodeURIComponent(segments[1]);
      const record = await service.get(owner, connectionId);
      if (!record)
        return sendJson(res, 404, {
          code: "not-found",
          message: "连接不存在或无权访问",
        });

      if (
        segments.length === 3 &&
        segments[2] === "delete" &&
        method === "POST"
      ) {
        const removed = await service.remove(owner, connectionId);
        return removed.ok
          ? sendJson(res, 200, { removed: true })
          : sendJson(res, 500, removed.error);
      }

      if (record.serviceConnectionId && segments.length === 3 && ["credential", "clear"].includes(segments[2]) && method === "POST")
        return sendJson(res, 409, { code: "source-managed", message: "请在服务来源详情管理凭据；此处只保存消费引用" });

      if (
        segments.length === 3 &&
        segments[2] === "credential" &&
        method === "POST"
      ) {
        const body = (await readBody(req)) as Record<string, unknown> | null;
        const secret =
          body && typeof body.secret === "string" ? body.secret : "";
        const expectedEpoch =
          body && typeof body.expectedEpoch === "number"
            ? body.expectedEpoch
            : undefined;
        const saved = await service.saveCredential({
          owner,
          connectionId,
          purpose: "model-api-key",
          secret,
          ...(expectedEpoch !== undefined ? { expectedEpoch } : {}),
        });
        if (!saved.ok)
          return sendJson(
            res,
            saved.error.code === "epoch-invalid"
              ? 409
              : saved.error.code === "malformed-request"
                ? 400
                : 500,
            saved.error,
          );
        return sendJson(res, 200, {
          credentialConfigured: true,
          credentialEpoch: saved.value.credentialEpoch,
        });
      }

      if (
        segments.length === 3 &&
        segments[2] === "clear" &&
        method === "POST"
      ) {
        const cleared = await service.clearCredential({
          owner,
          connectionId,
          purpose: "model-api-key",
        });
        return cleared.ok
          ? sendJson(res, 200, {
              credentialConfigured: false,
              credentialEpoch: cleared.value.credentialEpoch,
            })
          : sendJson(res, 500, cleared.error);
      }
    }

    // POST /check：无生成探测（不收费、不调用模型）。
    if (segments.length === 1 && segments[0] === "check" && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown> | null;
      const connectionId =
        body && typeof body.connectionId === "string" ? body.connectionId : "";
      const record = await service.get(owner, connectionId);
      if (!record)
        return sendJson(res, 404, {
          code: "not-found",
          message: "连接不存在或无权访问",
        });
      const adapter = findSdkAgentAdapter(record.adapterId);
      if (!adapter)
        return sendJson(res, 400, {
          code: "connection-unsupported",
          message: "未知接入方式",
        });
      const credentialConfigured = await service.credentialConfigured({
        owner,
        connectionId,
        purpose: "model-api-key",
      });
      const fixed = sdkEngineForAdapter(adapter.adapterId)!;
      let runtimeReady = false;
      try {
        const runtime = options.runtimeOptions?.runtime ?? (deployment.agentSdkDirs ? createFixedEngineRuntime(deployment.agentSdkDirs) : undefined);
        if (runtime) { await runtime.resolve(fixed.engine); runtimeReady = true; }
      } catch { /* Runtime failure does not lose the saved key or contact a model. */ }
      await service.setRuntimeProbe?.(owner, connectionId, `${fixed.engine}@${fixed.version}:1`, { state: runtimeReady ? "ready" : "unavailable", checkedAt: new Date().toISOString(), ...(!runtimeReady ? { reason: "缺少配套运行时，请重新安装对应平台扩展" } : {}) });
      return sendJson(res, 200, {
        runtime: runtimeReady ? "ready" : "runtime-missing",
        engine: fixed.engine,
        engineVersion: fixed.version,
        transport: "unknown",
        credential: credentialConfigured ? "ready" : "unavailable",
        modelAccess: "unknown",
        tools: "unknown",
        note: "无生成探测：不调用模型、不产生费用；不表示模型可调用",
      });
    }

    // POST /test-generation：显式最小生成（用户触发；失败不自动换模型）。
    if (
      segments.length === 1 &&
      segments[0] === "test-generation" &&
      method === "POST"
    ) {
      const body = (await readBody(req)) as Record<string, unknown> | null;
      const connectionId =
        body && typeof body.connectionId === "string" ? body.connectionId : "";
      const record = await service.get(owner, connectionId);
      if (!record)
        return sendJson(res, 404, {
          code: "not-found",
          message: "连接不存在或无权访问",
        });
      const adapter = findSdkAgentAdapter(record.adapterId);
      if (!adapter)
        return sendJson(res, 400, {
          code: "connection-unsupported",
          message: "未知接入方式",
        });
      const model = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : record.models?.[0];
      if (!model) return sendJson(res, 400, { code: "malformed-request", message: "请选择模型" });
      const requestId = `maintenance-${randomUUID()}`;
      const runner = createSdkAgentConversationAdapter(adapter, options.runtimeOptions ?? {
        service, ...deployment, ...(options.tools ? { tools: options.tools } : {})
      });
      const outcome = await runner.run({ owner, canvasId: "maintenance", conversationId: requestId,
        turnId: requestId, requestId, connection: { connectionId, adapterId: record.adapterId, configRevision: record.configRevision, credentialEpoch: record.credentialEpoch },
        intent: { action: "discuss", canvasId: "maintenance", prompt: "请只回复 ok。", model }, history: [], signal: AbortSignal.timeout(60_000), emit: () => undefined });
      const result = outcome.status === "succeeded"
        ? { ok: true as const, outcome: { assistantText: outcome.assistantText ?? "" } }
        : { ok: false as const, code: outcome.error?.code ?? "transport-unavailable", message: outcome.error?.message ?? "固定引擎测试失败" };
      if (result.ok) {
        await service.setStatus({
          owner,
          connectionId,
          patch: {
            modelAccess: {
              state: "ready",
              checkedAt: new Date().toISOString(),
            },
          },
        });
        return sendJson(res, 200, {
          ok: true,
          model,
          assistantText: result.outcome.assistantText,
        });
      }
      await service.setStatus({
        owner,
        connectionId,
        patch: {
          modelAccess: {
            state: result.code === "model-access-denied" ? "failed" : "unknown",
            checkedAt: new Date().toISOString(),
            reason: result.message,
          },
        },
      });
      return sendJson(res, 200, {
        ok: false,
        code: result.code,
        message: result.message,
        model,
      });
    }

    return sendJson(res, 404, { code: "not-found", message: "未知路径" });
  };

  return { handle };
}

export type SdkAgentHandler = ReturnType<typeof createSdkAgentHandler>;
export type { SdkAgentAdapterId };
