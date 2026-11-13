/**
 * Task Remote adapter（change: adopt-frontend-cordis-plugin-runtime，design D4；
 *   change: 2026-10-06-improve-task-history-experience，任务 2.4/2.5）。
 *
 * **唯一**浏览器 Task Service 只读协议出口：catalog 与 history list/detail/candidates/subscribe。
 * feature/plugin 不得自行创建 fetch 或 EventSource。
 *
 * 历史订阅用 ReadableStream **增量**消费 NDJSON：跨 chunk 行、UTF-8、残片、畸形消息都被处理；
 * 只有成功解析、校验并交付的消息才确认 cursor。流不可用时以有界轮询 `/changes` **实际交付**
 * 变更。释放会中止流请求、reader 与 timer，迟到回调不再作用于新 scope。
 */
import {
  DEFAULT_TASK_TIMEOUT_MS,
  isTaskExecutionDetail,
  isTaskHistoryCandidates,
  isTaskHistoryEventMessage,
  isTaskHistoryPage,
  normalizeInputBindings,
  type CanvasTaskCatalog,
  type TaskExecutionState,
  type TaskExecutionSummary,
  type TaskHistoryCandidateQuery,
  type TaskHistoryCandidates,
  type TaskHistoryIncrementalBatch
} from "@woohaa3/contracts";
import { getAppPublicFetch } from "./app-base-path.js";
import type { TaskRemoteService } from "../contracts.js";
import { TaskHistoryError } from "../../shared/task-history/client.js";
import type {
  TaskHistoryConnectionStatus,
  TaskHistoryDetailResult,
  TaskHistoryReader
} from "../../shared/task-history/client.js";
import { PPTASK_BASE_PATH, TASK_HISTORY_BASE_PATH } from "./paths.js";

export type TaskRemoteOptions = {
  basePath?: string;
  historyBasePath?: string;
  fetchImpl?: typeof globalThis.fetch;
  /** 流不可用时的有界轮询间隔。 */
  pollIntervalMs?: number;
  /** 单条 NDJSON 行的最大字节（防御性上限）。 */
  maxLineBytes?: number;
};

export function createTaskRemote(options: TaskRemoteOptions = {}): TaskRemoteService {
  const basePath = (options.basePath ?? PPTASK_BASE_PATH).replace(/\/$/, "");
  const historyBasePath = (options.historyBasePath ?? TASK_HISTORY_BASE_PATH).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? getAppPublicFetch();
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const maxLineBytes = options.maxLineBytes ?? 1_000_000;

  async function fetchCatalog(): Promise<CanvasTaskCatalog> {
    const response = await fetchImpl(`${basePath}/catalog`, { method: "GET" });
    const body = await response.json().catch(() => null);
    // 兼容尚未更新的后端：503 携带完整目录时仍按配置状态解析。
    if (response.status === 503 && isRecord(body) && body.available === false
      && typeof body.reason === "string" && Array.isArray(body.models) && isRecord(body.defaultModels)) {
      return parseCatalog(body);
    }
    if (!response.ok) throw new TaskHistoryError(readErrorMessage(body, response.status), readErrorCode(body) ?? "unavailable", response.status);
    return parseCatalog(body);
  }

  function createHistory(): TaskHistoryReader {
    async function readJson(response: Response, fallback: string): Promise<unknown> {
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new TaskHistoryError(readErrorMessage(body, response.status) || fallback, readErrorCode(body) ?? "unavailable", response.status);
      }
      return body;
    }

    const reader: TaskHistoryReader = {
      async list(input = {}, signal) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(input)) {
          if (value === undefined || value === "" || value === null) continue;
          if (key === "states" && Array.isArray(value)) {
            if (value.length > 0) params.set("states", value.join(","));
            continue;
          }
          params.set(key, String(value));
        }
        const query = params.toString();
        const response = await fetchImpl(`${historyBasePath}${query ? `?${query}` : ""}`, {
          method: "GET",
          ...(signal ? { signal } : {})
        });
        const body = await readJson(response, "历史列表请求失败");
        if (!isTaskHistoryPage(body)) throw new TaskHistoryError("history-page-invalid", "历史列表响应不符合契约");
        return body;
      },

      async detail(taskKey, signal): Promise<TaskHistoryDetailResult> {
        const response = await fetchImpl(`${historyBasePath}/${encodeURIComponent(taskKey)}`, {
          method: "GET",
          ...(signal ? { signal } : {})
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          return { ok: false, code: readErrorCode(body) ?? (response.status === 404 ? "task-not-found" : "unavailable"), message: readErrorMessage(body, response.status) };
        }
        if (!isTaskExecutionDetail(body)) return { ok: false, code: "invalid-detail", message: "历史详情响应不符合契约" };
        return { ok: true, detail: body };
      },

      async candidates(query: TaskHistoryCandidateQuery = {}, signal): Promise<TaskHistoryCandidates> {
        const params = new URLSearchParams();
        if (query.providerId) params.set("providerId", query.providerId);
        if (query.modelType) params.set("modelType", query.modelType);
        if (query.limit) params.set("limit", String(query.limit));
        const suffix = params.toString();
        const response = await fetchImpl(`${historyBasePath}/candidates${suffix ? `?${suffix}` : ""}`, {
          method: "GET",
          ...(signal ? { signal } : {})
        });
        const body = await readJson(response, "历史候选请求失败");
        if (!isTaskHistoryCandidates(body)) throw new TaskHistoryError("candidates-invalid", "历史候选响应不符合契约");
        return body;
      },

      subscribe(input) {
        let stopped = false;
        let confirmed = input.cursor;
        let lastSyncedAt: string | undefined;
        let attempts = 0;
        let connectedOnce = false;
        let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
        let activeAbort: AbortController | undefined;
        const pollInterval = pollIntervalMs;

        const setStatus = (state: TaskHistoryConnectionStatus["state"], error?: string) => {
          input.onStatus?.({
            state,
            ...(lastSyncedAt ? { lastSyncedAt } : {}),
            ...(error ? { error } : {})
          });
        };

        const deliver = (record: TaskExecutionSummary, cursor: number): void => {
          // 只交付并确认严格更新的 cursor；重复/乱序消息不重复交付、不污染水位。
          if (cursor <= confirmed) return;
          confirmed = cursor;
          lastSyncedAt = new Date().toISOString();
          input.onRecord(record, cursor);
        };

        const deliverMessage = (line: string): "ok" | "resync" => {
          const trimmed = line.trim();
          if (trimmed === "") return "ok";
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            return "resync";
          }
          if (isRecord(parsed) && parsed.type === "resync") return "resync";
          if (!isTaskHistoryEventMessage(parsed)) return "resync";
          deliver(parsed.record, parsed.cursor);
          return "ok";
        };

        /** 消费一次流；返回结束原因。 */
        const runStream = async (): Promise<"ended" | "unavailable" | "resync" | "aborted"> => {
          const controller = new AbortController();
          activeAbort = controller;
          let response: Response;
          try {
            response = await fetchImpl(`${historyBasePath}/events?after=${confirmed}`, {
              method: "GET",
              signal: controller.signal,
              headers: { accept: "application/x-ndjson" }
            });
          } catch (error) {
            return controller.signal.aborted ? "aborted" : "unavailable";
          }
          if (!response.ok || !response.body) return "unavailable";
          connectedOnce = true;
          setStatus("live");
          const stream = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          try {
            for (;;) {
              const { done, value } = await stream.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              let newline = buffer.indexOf("\n");
              while (newline >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                if (line.length > maxLineBytes) return "resync";
                if (deliverMessage(line) === "resync") return "resync";
                newline = buffer.indexOf("\n");
              }
              if (buffer.length > maxLineBytes) return "resync";
            }
            buffer += decoder.decode();
            if (buffer.trim() !== "" && deliverMessage(buffer) === "resync") return "resync";
            return "ended";
          } catch (error) {
            if (controller.signal.aborted) return "aborted";
            input.onError?.(error);
            return "unavailable";
          } finally {
            if (activeAbort === controller) activeAbort = undefined;
            try {
              stream.releaseLock();
            } catch {
              /* ignore */
            }
          }
        };

        /** 有界轮询补偿：实际读取并交付变更。 */
        const pollOnce = async (): Promise<boolean> => {
          try {
            const response = await fetchImpl(`${historyBasePath}/changes?after=${confirmed}&limit=200`, { method: "GET" });
            if (!response.ok) return false;
            const batch = (await response.json().catch(() => null)) as TaskHistoryIncrementalBatch | null;
            if (!batch || !Array.isArray(batch.messages)) return false;
            if (batch.resync === true) {
              input.onResync?.();
              return false;
            }
            for (const message of batch.messages) {
              if (!isTaskHistoryEventMessage(message)) continue;
              deliver(message.record, message.cursor);
            }
            lastSyncedAt = new Date().toISOString();
            return true;
          } catch (error) {
            input.onError?.(error);
            return false;
          }
        };

        const cycle = async (): Promise<void> => {
          if (stopped) return;
          // 已建立过实时流后，短暂重连不再把界面打回「连接中」；只有真正失败才降级。
          if (!connectedOnce) setStatus(attempts === 0 ? "connecting" : "reconnecting");
          const outcome = await runStream();
          if (stopped) return;
          if (outcome === "aborted") return;
          if (outcome === "resync") {
            // 无法续读：要求宿主重读快照后再订阅；本订阅在此结束，不跳过缺口。
            setStatus("reconnecting", "事件流无法续读，需要重新同步");
            input.onResync?.();
            return;
          }
          // 流结束或不可用：先用有界轮询补齐已错过变更，再退避重连。
          const polled = await pollOnce();
          if (stopped) return;
          if (outcome === "ended" && polled) {
            // 服务端正常结束（空闲超时/网关回收）不是故障：保持已展示状态并静默续订，
            // 避免每轮空闲回收都闪一次「重连中」。
            attempts = 0;
            reconnectTimer = setTimeout(() => { void cycle(); }, pollInterval);
            return;
          }
          attempts += 1;
          const delay = Math.min(pollInterval * Math.min(attempts, 3), 15_000);
          // 轮询补偿仍在工作说明只是事件流不可用，降级为「轮询中」；两者都失败才显示重连。
          if (polled) setStatus("polling");
          else setStatus("reconnecting", "事件流与轮询均不可用，正在重连");
          reconnectTimer = setTimeout(() => {
            void cycle();
          }, delay);
        };

        void cycle();

        return () => {
          stopped = true;
          if (reconnectTimer) clearTimeout(reconnectTimer);
          activeAbort?.abort();
          setStatus("offline");
        };
      }
    };
    return reader;
  }

  return { fetchCatalog, createHistory };
}

function readErrorCode(body: unknown): string | undefined {
  if (isRecord(body) && typeof body.code === "string" && body.code !== "") return body.code;
  return undefined;
}

function readErrorMessage(body: unknown, status: number): string {
  if (isRecord(body)) {
    const message = body.message ?? body.error;
    if (typeof message === "string" && message !== "") return message;
  }
  return `任务网关请求失败（HTTP ${status}）`;
}

function parseCatalog(input: unknown): CanvasTaskCatalog {
  if (!isRecord(input)) {
    return { available: false, reason: "任务目录响应无法识别", models: [], defaultModels: {} };
  }
  const available = input.available === true;
  const reason = readString(input.reason);
  const models = Array.isArray(input.models)
    ? input.models.flatMap((entry) => {
        const model = parseCatalogModel(entry);
        return model ? [model] : [];
      })
    : [];
  return {
    available,
    ...(reason !== undefined ? { reason } : {}),
    models,
    defaultModels: parseDefaultModels(input.defaultModels)
  };
}

function parseDefaultModels(input: unknown): CanvasTaskCatalog["defaultModels"] {
  if (!isRecord(input)) return {};
  const defaults: CanvasTaskCatalog["defaultModels"] = {};
  const image = readString(input.image);
  const language = readString(input.language);
  if (image !== undefined) defaults.image = image;
  if (language !== undefined) defaults.language = language;
  return defaults;
}

function parseCatalogModel(input: unknown): CanvasTaskCatalog["models"][number] | null {
  if (!isRecord(input)) return null;
  const providerId = readString(input.providerId);
  const modelKey = readString(input.modelKey);
  const providerModelId = readString(input.providerModelId) ?? modelKey;
  const modelType =
    input.modelType === "image" || input.modelType === "language" || input.modelType === "video" || input.modelType === "audio" || input.modelType === "motion"
      ? input.modelType
      : undefined;
  const interaction = parseInteraction(input.interaction);
  if (providerId === undefined || modelKey === undefined || providerModelId === undefined || modelType === undefined || interaction === undefined) {
    return null;
  }
  return {
    modelKey,
    providerId,
    providerModelId,
    modelType,
    title: readString(input.title) ?? providerModelId,
    interaction,
    inputSchema: isRecord(input.inputSchema) ? input.inputSchema : {},
    defaultInput: isRecord(input.defaultInput) ? input.defaultInput : {},
    bindings: normalizeInputBindings(input.bindings),
    taskTimeoutMs: readNumber(input.taskTimeoutMs) ?? DEFAULT_TASK_TIMEOUT_MS[modelType]
  };
}

/** 严格解析 interaction descriptor；拒绝任何额外字段（module URL / 组件路径 / 源码）。 */
function parseInteraction(input: unknown): { id: string; version: number } | undefined {
  if (!isRecord(input)) return undefined;
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes("id") || !keys.includes("version")) return undefined;
  const id = readString(input.id);
  const version = readNumber(input.version);
  if (id === undefined || version === undefined || !Number.isInteger(version) || version < 1) {
    return undefined;
  }
  return { id, version };
}

function readString(input: unknown): string | undefined {
  return typeof input === "string" && input !== "" ? input : undefined;
}

function readNumber(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

export type { TaskExecutionState };
