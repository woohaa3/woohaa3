/**
 * Application Remote adapter
 * （change: 2026-10-05-extract-application-plugin-host，任务 5.3 / design D7）。
 *
 * 浏览器访问站点插件控制面的**唯一**出口：公开状态 snapshot、有界增量、管理员配置写入，
 * 以及 Application 健康/就绪读取。浏览器不持有服务间令牌，也不调用内部 work/recovery 接口。
 *
 * 结果全部映射为稳定契约（snapshot / changes / 写入结果），失败携带稳定错误码，
 * 不向 UI 泄漏底层响应正文。站点管理不再经 Task Remote。
 */
import type {
  ApplicationExtensionChangeBatch,
  ApplicationExtensionSnapshot,
  ApplicationExtensionStatus
} from "@woohaa3/contracts";
import { getAppPublicFetch } from "./app-base-path.js";
import { APPLICATION_HEALTH_BASE_PATH, APPLICATION_EXTENSION_BASE_PATH } from "./paths.js";
import { createGenerationModelsRemote } from "./generation-models-remote.js";
import type {
  ApplicationRemoteTransport,
  ApplicationTransportErrorCode,
  ApplicationTransportStreamCallbacks,
  ApplicationTransportStreamEvent
} from "../contract/remote.js";

export type ApplicationRemote = {
  /** 权威状态 snapshot（不含秘密）。 */
  fetchSnapshot: () => Promise<ApplicationExtensionSnapshotResult>;
  /** 有界增量；resyncRequired 时调用方必须重取 snapshot。 */
  fetchChanges: (after: number) => Promise<ApplicationExtensionChangesResult>;
  /** 管理员配置写入（浏览器不携带服务令牌；由同源 ingress 传递可信管理员上下文）。 */
  writeConfig: (input: ApplicationExtensionConfigWriteInput) => Promise<ApplicationExtensionWriteResult>;
  /** 读取 Application liveness/readiness（只含状态与安全原因）。 */
  health: () => Promise<ApplicationHealthResult>;
  /** 生成模型策略（change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 5.1）。 */
  generationModels: {
    fetchSnapshot: () => ReturnType<import("./generation-models-remote.js").GenerationModelsRemote["fetchSnapshot"]>;
    writeConfig: (input: import("@woohaa3/contracts").GenerationModelsWriteRequest) => ReturnType<import("./generation-models-remote.js").GenerationModelsRemote["writeConfig"]>;
  };
  /**
   * 通用插件 JSON/流式传输（change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 6.1）。
   *
   * 插件（如 ChatGPT）拥有自己的业务协议 adapter，但 MUST 复用本传输发起同源请求，携带同源会话
   * 与取消信号，不自行创建针对服务的 fetch/EventSource。传输只做 HTTP/SSE 编解码与稳定错误映射，
   * 不解释业务协议，也不持有服务间令牌。
   */
  transport: ApplicationRemoteTransport;
};

export type ApplicationExtensionConfigWriteInput = {
  extensionId: string;
  expectedRevision: number;
  enabled: boolean;
  values: Record<string, unknown>;
  /** opaque secret reference；浏览器不接触秘密值。 */
  secretRefs: string[];
};

export type ApplicationExtensionSnapshotResult =
  | { ok: true; snapshot: ApplicationExtensionSnapshot }
  | { ok: false; code: ApplicationExtensionRemoteError; error: string };

export type ApplicationExtensionChangesResult =
  | { ok: true; batch: ApplicationExtensionChangeBatch }
  | { ok: false; code: ApplicationExtensionRemoteError; error: string };

export type ApplicationExtensionWriteResult =
  | { ok: true; revision: number; status: ApplicationExtensionStatus }
  | { ok: false; code: ApplicationExtensionRemoteError; error: string; currentRevision?: number };

export type ApplicationHealthResult =
  | { ok: true; status: "ok" | "ready" }
  | { ok: false; error: string; reason?: string };

export type ApplicationExtensionRemoteError =
  | "unauthorized"
  | "revision-conflict"
  | "config-invalid"
  | "extension-not-found"
  | "unavailable"
  | "malformed";

export type ApplicationRemoteOptions = {
  basePath?: string;
  healthBasePath?: string;
  fetchImpl?: typeof globalThis.fetch;
};

export function createApplicationRemote(
  options: ApplicationRemoteOptions = {}
): ApplicationRemote {
  const basePath = (options.basePath ?? APPLICATION_EXTENSION_BASE_PATH).replace(/\/$/, "");
  const healthBasePath = (options.healthBasePath ?? APPLICATION_HEALTH_BASE_PATH).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? getAppPublicFetch();

  const fetchSnapshot: ApplicationRemote["fetchSnapshot"] = async () => {
    try {
      const response = await fetchImpl(basePath, { method: "GET" });
      const body = await response.json().catch(() => null);
      if (!response.ok) return { ok: false, code: mapStatus(response.status), error: readError(body, "无法读取站点插件状态") };
      if (!isSnapshot(body)) return { ok: false, code: "malformed", error: "站点插件状态响应无法识别" };
      return { ok: true, snapshot: body };
    } catch {
      return { ok: false, code: "unavailable", error: "无法连接站点插件服务" };
    }
  };

  const fetchChanges: ApplicationRemote["fetchChanges"] = async (after) => {
    try {
      const response = await fetchImpl(`${basePath}/changes?after=${encodeURIComponent(String(after))}`, { method: "GET" });
      const body = await response.json().catch(() => null);
      if (!response.ok) return { ok: false, code: mapStatus(response.status), error: readError(body, "无法读取站点插件增量") };
      if (!isChangeBatch(body)) return { ok: false, code: "malformed", error: "站点插件增量响应无法识别" };
      return { ok: true, batch: body };
    } catch {
      return { ok: false, code: "unavailable", error: "无法连接站点插件服务" };
    }
  };

  const writeConfig: ApplicationRemote["writeConfig"] = async (input) => {
    try {
      const response = await fetchImpl(`${basePath}/${encodeURIComponent(input.extensionId)}/config`, {
        method: "PUT",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          expectedRevision: input.expectedRevision,
          enabled: input.enabled,
          values: input.values,
          secretRefs: input.secretRefs
        })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const code = readErrorCode(body) ?? mapStatus(response.status);
        const current = readCurrentRevision(body);
        return {
          ok: false,
          code,
          error: readError(body, "站点插件配置保存失败"),
          ...(current !== undefined ? { currentRevision: current } : {})
        };
      }
      if (!isWriteResponse(body)) return { ok: false, code: "malformed", error: "站点插件配置响应无法识别" };
      return { ok: true, revision: body.revision, status: body.status };
    } catch {
      return { ok: false, code: "unavailable", error: "无法连接站点插件服务" };
    }
  };

  const health: ApplicationRemote["health"] = async () => {
    try {
      const response = await fetchImpl(`${healthBasePath}/ready`, { method: "GET" });
      if (response.ok) return { ok: true, status: "ready" };
      const body = await response.json().catch(() => null);
      return { ok: false, error: "应用服务未就绪", ...(readReason(body) ? { reason: readReason(body) as string } : {}) };
    } catch {
      return { ok: false, error: "无法连接应用服务" };
    }
  };

  // 传入**原始** fetch 实现：传输层会各自包装一次公开前缀（避免重复加前缀）。
  const transport = createApplicationTransport({ ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });

  return { fetchSnapshot, fetchChanges, writeConfig, health, generationModels: createGenerationModelsRemote({ ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) }), transport };
}

/**
 * 通用插件 JSON/SSE 传输（change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 6.1）。
 *
 * 只用同源 `fetch` + `credentials: same-origin`；不创建 WebSocket/EventSource，不附加服务令牌。
 * 业务协议由调用插件解释（本模块只解析 SSE 的 `event:`/`data:` 行）。
 */
export function createApplicationTransport(options: { fetchImpl?: typeof globalThis.fetch } = {}): ApplicationRemoteTransport {
  const fetchImpl = options.fetchImpl ?? getAppPublicFetch();
  return {
    async request(input) {
      const controller = new AbortController();
      const signal = input.signal ?? controller.signal;
      try {
        const response = await fetchImpl(input.path, {
          method: input.method ?? "GET",
          credentials: "same-origin",
          signal,
          headers: { ...(input.body === undefined ? {} : { "content-type": "application/json", "x-requested-with": "woohaa3" }) },
          ...(input.body === undefined
            ? {}
            : { body: JSON.stringify(input.body) })
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          return { ok: false, code: mapTransportStatus(response.status), error: readError(body, "请求失败"), status: response.status,
            ...(typeof body?.creationRegistered === "boolean" ? { body: { creationRegistered: body.creationRegistered } } : {}) };
        }
        return { ok: true, status: response.status, data: body };
      } catch (error) {
        if (isAbortError(error)) return { ok: false, code: "aborted", error: "请求已取消" };
        return { ok: false, code: "unavailable", error: "无法连接应用服务" };
      }
    },
    stream(input) {
      const controller = new AbortController();
      const signal = input.signal ?? controller.signal;
      let aborted = false;
      void (async () => {
        try {
          const response = await fetchImpl(input.path, {
            method: input.method ?? "GET",
            credentials: "same-origin",
            signal,
            headers: {
              accept: "text/event-stream",
              "x-requested-with": "woohaa3",
              ...(input.body === undefined ? {} : { "content-type": "application/json" })
            },
            ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) })
          });
          if (!response.ok || !response.body) {
            const body = await response.json().catch(() => null);
            if (!aborted) input.callbacks.onError(readError(body, "流式请求失败"), mapTransportStatus(response.status));
            return;
          }
          await consumeSseStream(response.body, input.callbacks);
        } catch (error) {
          if (!aborted && !isAbortError(error)) {
            input.callbacks.onError(error instanceof Error ? error.message : "流式请求失败", "unavailable");
          }
        } finally {
          input.callbacks.onClose?.();
        }
      })();
      return {
        cancel: () => {
          aborted = true;
          controller.abort();
        }
      };
    }
  };
}

/** 解析同源 SSE 字节流（`event:`/`data:`；`:` 开头为心跳注释）。 */
export async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  callbacks: ApplicationTransportStreamCallbacks
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = parseApplicationSseBlock(block);
      if (event) callbacks.onEvent(event);
    }
  }
}

function parseApplicationSseBlock(block: string): ApplicationTransportStreamEvent | null {
  let type = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  return { type, data: dataLines.join("\n") };
}

function mapTransportStatus(status: number): ApplicationTransportErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status >= 400 && status < 500) return "invalid";
  return "unavailable";
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && (error as { name?: string }).name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSnapshot(value: unknown): value is ApplicationExtensionSnapshot {
  return isRecord(value) && typeof value.revision === "number" && Array.isArray(value.plugins);
}

function isChangeBatch(value: unknown): value is ApplicationExtensionChangeBatch {
  return isRecord(value) && typeof value.revision === "number" && typeof value.resyncRequired === "boolean" && Array.isArray(value.changes);
}

function isWriteResponse(value: unknown): value is { revision: number; status: ApplicationExtensionStatus } {
  return isRecord(value) && typeof value.revision === "number" && isRecord(value.status);
}

function readError(body: unknown, fallback: string): string {
  if (isRecord(body) && typeof body.message === "string" && body.message !== "") return body.message;
  return fallback;
}

function readReason(body: unknown): string | undefined {
  return isRecord(body) && typeof body.reason === "string" && body.reason !== "" ? body.reason : undefined;
}

function readErrorCode(body: unknown): ApplicationExtensionRemoteError | undefined {
  if (!isRecord(body) || typeof body.code !== "string") return undefined;
  const known: ApplicationExtensionRemoteError[] = [
    "unauthorized",
    "revision-conflict",
    "config-invalid",
    "extension-not-found",
    "unavailable",
    "malformed"
  ];
  return (known as string[]).includes(body.code) ? (body.code as ApplicationExtensionRemoteError) : undefined;
}

function readCurrentRevision(body: unknown): number | undefined {
  return isRecord(body) && typeof body.currentRevision === "number" ? body.currentRevision : undefined;
}

function mapStatus(status: number): ApplicationExtensionRemoteError {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "extension-not-found";
  if (status === 409) return "revision-conflict";
  return "unavailable";
}
