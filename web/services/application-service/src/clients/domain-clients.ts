/**
 * Application -> 领域服务的受限网络客户端
 * （change: 2026-10-05-extract-application-plugin-host，任务 2.3 / design D3/D4）。
 *
 * 插件通过 `ctx.tasks` / `ctx.media` / `ctx.canvas` 调用；实现位于 Application。客户端：
 * - 使用服务身份令牌（插件拿不到）；
 * - 绑定可信 extensionId、不可变 configVersion 与 delegated principal；
 * - 有界超时与稳定错误映射；
 * - 不 import 任何领域服务实现。
 *
 * 任务只允许提交**自己拥有的非画布任务**；画布节点 run/cancel 必须经 Canvas。
 */
import {
  buildInternalHeaders,
  createCorrelationId,
  retryDelayMs,
  shouldRetryTransport,
  withTimeout,
  type ProtocolErrorBody,
  type TaskExecutionDetail,
  type TaskSubmitResponse
} from "@woohaa3/contracts";
import type {
  ApplicationExtensionCanvasFacade,
  ApplicationExtensionMediaFacade,
  ApplicationExtensionPrincipal,
  ApplicationExtensionTaskFacade,
  ApplicationExtensionTaskSubmitResult
} from "@woohaa3/contracts";

export type DomainClientOptions = {
  serviceToken?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof globalThis.fetch;
  logger?: (event: Record<string, unknown>) => void;
};

export class DomainClientError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "DomainClientError";
    this.code = code;
    this.status = status;
  }
}

type CallOptions = DomainClientOptions & { baseUrl: string };

/** 版本化、受认证、有界超时的内部 JSON 调用。 */
async function callInternal<T>(
  options: CallOptions,
  method: string,
  path: string,
  body: unknown
): Promise<T> {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxRetries = options.maxRetries ?? 2;
  for (let attempt = 0; ; attempt += 1) {
    const correlationId = createCorrelationId();
    try {
      const response = await withTimeout(
        (signal) =>
          fetchImpl(`${baseUrl}${path}`, {
            method,
            headers: buildInternalHeaders({ serviceToken: options.serviceToken, correlationId }),
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            signal
          }),
        options.timeoutMs
      );
      const parsed = (await response.json().catch(() => null)) as unknown;
      if (response.ok) return parsed as T;
      const errorBody = parsed as ProtocolErrorBody | null;
      const code = errorBody?.code ?? "storage-failed";
      if (shouldRetryTransport({ attempt, status: response.status, code, maxRetries })) {
        await delay(retryDelayMs(attempt));
        continue;
      }
      throw new DomainClientError(code, errorBody?.message ?? "领域服务请求失败", response.status);
    } catch (error) {
      if (error instanceof DomainClientError) throw error;
      if (shouldRetryTransport({ attempt, maxRetries })) {
        await delay(retryDelayMs(attempt));
        continue;
      }
      throw new DomainClientError("unavailable", "领域服务暂时不可用");
    }
  }
}

/** 插件任务提交体：只含稳定关联与调用权限，不含秘密。 */
export type ExtensionTaskSubmitBody = {
  workerTaskKey: string;
  modelType: string;
  modelKey: string;
  prompt: string;
  parameters: Record<string, unknown>;
  inputs: readonly { assetId: string; role: string; storageKey: string; mediaType: string; mediaKind?: string }[];
  extensionId: string;
  configVersion: number;
  delegatedActor?: string;
};

export type TaskDomainClientOptions = DomainClientOptions & { baseUrl: string };

/** 代表某插件提交/查询/取消其非画布任务。 */
export function createApplicationTaskFacade(
  options: TaskDomainClientOptions,
  principal: ApplicationExtensionPrincipal
): ApplicationExtensionTaskFacade {
  const associationPath = (workerTaskKey: string) =>
    `/internal/v1/extensions/${encodeURIComponent(principal.extensionId)}/tasks/${encodeURIComponent(workerTaskKey)}`;

  return {
    async submit(input): Promise<ApplicationExtensionTaskSubmitResult> {
      const body: ExtensionTaskSubmitBody = {
        workerTaskKey: input.workerTaskKey,
        modelType: input.modelType,
        modelKey: input.modelKey,
        prompt: input.prompt,
        parameters: input.parameters,
        inputs: input.inputs ?? [],
        extensionId: principal.extensionId,
        configVersion: principal.configVersion,
        ...(principal.delegatedActor ? { delegatedActor: principal.delegatedActor } : {})
      };
      try {
        const result = await callInternal<TaskSubmitResponse>(options, "PUT", associationPath(input.workerTaskKey), body);
        return { ok: true, workerTaskKey: result.workerTaskKey, reused: result.reused, state: result.state };
      } catch (error) {
        if (error instanceof DomainClientError) {
          const mapped = mapTaskError(error.code);
          return { ok: false, code: mapped, message: error.message };
        }
        return { ok: false, code: "unavailable", message: "任务服务暂时不可用" };
      }
    },
    async result(workerTaskKey) {
      if (!principal.capabilities.includes("tasks:read-own")) throw new DomainClientError("unauthorized", "插件没有任务结果读取权限");
      try { return await callInternal<import("@woohaa3/contracts").ApplicationExtensionTaskResult>(options,"GET",`${associationPath(workerTaskKey)}/result`,undefined); }
      catch(error) { if(error instanceof DomainClientError && error.code === "task-not-found") return null; throw error; }
    },
    async status(workerTaskKey) {
      try {
        const detail = await callInternal<TaskExecutionDetail>(options, "GET", associationPath(workerTaskKey), undefined);
        return { workerTaskKey, state: detail.state };
      } catch (error) {
        if (error instanceof DomainClientError && error.code === "task-not-found") return null;
        throw error;
      }
    },
    async cancel(workerTaskKey) {
      try {
        await callInternal<unknown>(options, "POST", `${associationPath(workerTaskKey)}/cancel`, {});
      } catch (error) {
        if (error instanceof DomainClientError && error.code === "task-not-found") return null;
        throw error;
      }
      const detail = await callInternal<TaskExecutionDetail>(options, "GET", associationPath(workerTaskKey), undefined);
      return { workerTaskKey, state: detail.state };
    }
  };
}

export type MediaDomainClientOptions = DomainClientOptions & { baseUrl: string };

/** 插件只能查询稳定媒体引用是否存在；不接触 COS 凭据或签出长期 URL。 */
export function createApplicationMediaFacade(options: MediaDomainClientOptions, principal?: ApplicationExtensionPrincipal): ApplicationExtensionMediaFacade {
  return {
    ...(principal ? {resources: {
      async read(storageKey: string, canvasId?: string) {
        requireCapability(principal,"media:read");
        // canvasId 只透传，由 media-service 校验后交给存储路由：远端画布的字节只在托管存储里。
        const data=await callInternal<{bytesBase64:string;contentType:string}>(options,"POST","/internal/v1/media/extension-read",{extensionId:principal.extensionId,storageKey,...(canvasId!==undefined?{canvasId}:{})});
        return {bytes:new Uint8Array(Buffer.from(data.bytesBase64,"base64")),contentType:data.contentType};
      },
      async write(input: {bytes:Uint8Array;contentType:string;canvasId?:string}) {
        requireCapability(principal,"media:write");
        if(input.bytes.length>16*1024*1024)throw new DomainClientError("limit-exceeded","资源字节超限");
        return callInternal<import("@woohaa3/contracts").MediaMetadata>(options,"POST","/internal/v1/media/extension-write",{extensionId:principal.extensionId,bytesBase64:Buffer.from(input.bytes).toString("base64"),contentType:input.contentType,...(input.canvasId!==undefined?{canvasId:input.canvasId}:{})});
      }
    }} : {}),
    async stat(storageKey) {
      const result = await callInternal<{ exists: boolean; matches: boolean; metadata?: { contentType: string; size: number } }>(
        options,
        "POST",
        "/internal/v1/media/verify",
        { storageKey }
      );
      return result.exists
        ? { exists: true, ...(result.metadata ? { contentType: result.metadata.contentType, size: result.metadata.size } : {}) }
        : { exists: false };
    }
  };
}

export type CanvasDomainClientOptions = DomainClientOptions & { baseUrl: string };

/**
 * 插件对画布节点的 run/cancel 必须经 Canvas 语义接口；插件不能伪造 run identity 或直接写
 * 画布结果。这里只转发请求，由 Canvas 从权威状态生成 runId 与 workerTaskKey。
 */
export function createApplicationCanvasFacade(options: CanvasDomainClientOptions): ApplicationExtensionCanvasFacade {
  return {
    async requestNodeRun(input) {
      try {
        const result = await callInternal<{ runId: string }>(
          options,
          "POST",
          `/internal/v1/extensions/canvas/nodes/${encodeURIComponent(input.canvasId)}/${encodeURIComponent(input.nodeId)}/run`,
          { modelKey: input.modelKey, prompt: input.prompt, parameters: input.parameters }
        );
        return { ok: true, runId: result.runId };
      } catch (error) {
        if (error instanceof DomainClientError) return { ok: false, code: error.code, message: error.message };
        return { ok: false, code: "unavailable", message: "画布服务暂时不可用" };
      }
    },
    async requestNodeCancel(input) {
      try {
        await callInternal<unknown>(
          options,
          "POST",
          `/internal/v1/extensions/canvas/nodes/${encodeURIComponent(input.canvasId)}/${encodeURIComponent(input.nodeId)}/cancel`,
          { runId: input.runId }
        );
        return { ok: true };
      } catch (error) {
        if (error instanceof DomainClientError) return { ok: false, code: error.code, message: error.message };
        return { ok: false, code: "unavailable", message: "画布服务暂时不可用" };
      }
    }
  };
}

function mapTaskError(code: string): Extract<ApplicationExtensionTaskSubmitResult, { ok: false }>["code"] {
  switch (code) {
    case "unauthorized":
      return "unauthorized";
    case "unsupported":
      return "unsupported";
    case "key-reused":
      return "key-reused";
    case "storage-failed":
      return "storage-failed";
    default:
      return "unavailable";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireCapability(principal: ApplicationExtensionPrincipal, capability: string): void {
  if(!principal.capabilities.includes(capability))throw new DomainClientError("unauthorized","插件没有资源访问权限");
}
