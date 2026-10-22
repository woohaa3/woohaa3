/**
 * ChatGPT 个人授权 remote adapter（extension 前端 owner）
 * （change: 2026-10-10-unify-extension-frontend-entry，任务 5.1 / design D5；由宿主
 *  `cordis/plugins/chatgpt/remote.ts` 迁入）。
 *
 * 浏览器访问 ChatGPT 授权/生成的唯一出口：状态快照、授权 URL、断开、个人模型目录、生成
 * （同源 SSE）与 requestId 回执。**绝不**接触或持久化任何 token：token 由后端 per-owner 加密
 * 保存；本地会话由服务端 HttpOnly cookie 承载（浏览器 JS 读不到）。
 *
 * 本 adapter 只解释业务协议（路由与 DTO），HTTP/SSE 编解码与稳定错误映射由宿主注入的
 * `ApplicationRemoteTransport` 负责。传输**必填**：不自建 fetch/SSE 回退。
 */
import {
  CHATGPT_ROUTES,
  type ChatGptAuthSnapshot,
  type ChatGptGenerateRequest,
  type ChatGptGenerationReceipt,
  type ChatGptModelsSnapshot
} from "@woohaa3/contracts";
import type { ApplicationRemoteTransport } from "@woohaa3/frontend/extension-api";
import { CHATGPT_BASE_PATH } from "./routes.js";

export type ChatGptProgress = { requestId: string; stage: string; detail?: string };

export type ChatGptGenerationSink = {
  progress?: (event: ChatGptProgress) => void;
  /** 推理完成（成功或失败）；成功以服务端权威回执为准。 */
  done?: (receipt: ChatGptGenerationReceipt) => void;
};

export type ChatGptRemote = {
  fetchStatus: () => Promise<{ ok: true; snapshot: ChatGptAuthSnapshot } | { ok: false; error: string; code?: string }>;
  startAuthorize: () => Promise<{ ok: true; url: string } | { ok: false; error: string }>;
  disconnect: () => Promise<{ ok: true; snapshot: ChatGptAuthSnapshot } | { ok: false; error: string }>;
  fetchModels: () => Promise<{ ok: true; snapshot: ChatGptModelsSnapshot } | { ok: false; error: string }>;
  generate: (
    input: ChatGptGenerateRequest,
    sink: ChatGptGenerationSink
  ) => { cancel: () => void };
  receipt: (requestId: string) => Promise<{ ok: true; receipt: ChatGptGenerationReceipt } | { ok: false; error: string }>;
};

export type ChatGptRemoteOptions = {
  /** 同源业务前缀（缺省 `/api/oauth-agent`）；测试可注入。 */
  basePath?: string;
  /** 通用 Application Remote 传输（必填；生产由宿主在 extension scope 注入）。 */
  transport: ApplicationRemoteTransport;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createChatGptRemote(options: ChatGptRemoteOptions): ChatGptRemote {
  const basePath = (options.basePath ?? CHATGPT_BASE_PATH).replace(/\/$/, "");
  const transport = options.transport;

  const readError = (result: { error: string }, fallback: string): string => (result.error !== "" ? result.error : fallback);
  const path = (suffix: string) => `${basePath}/${suffix}`;

  return {
    async fetchStatus() {
      const result = await transport.request({ path: path(CHATGPT_ROUTES.status), method: "GET" });
      if (!result.ok) return { ok: false, error: readError(result, "无法读取 ChatGPT 授权状态"), ...(result.code ? { code: result.code } : {}) };
      if (!isRecord(result.data) || typeof result.data.state !== "string") return { ok: false, error: "授权状态响应无法识别" };
      return { ok: true, snapshot: result.data as unknown as ChatGptAuthSnapshot };
    },
    async startAuthorize() {
      const result = await transport.request({ path: path(CHATGPT_ROUTES.authorizeStart), method: "POST", body: {} });
      if (!result.ok) return { ok: false, error: readError(result, "无法发起 ChatGPT 授权") };
      if (!isRecord(result.data) || typeof result.data.url !== "string") return { ok: false, error: "授权响应缺失 URL" };
      return { ok: true, url: result.data.url };
    },
    async disconnect() {
      const result = await transport.request({ path: path(CHATGPT_ROUTES.disconnect), method: "POST", body: {} });
      if (!result.ok) return { ok: false, error: readError(result, "断开 ChatGPT 授权失败") };
      return { ok: true, snapshot: result.data as unknown as ChatGptAuthSnapshot };
    },
    async fetchModels() {
      const result = await transport.request({ path: path(CHATGPT_ROUTES.models), method: "GET" });
      if (!result.ok) return { ok: false, error: readError(result, "无法读取账户模型") };
      const body = result.data;
      if (!isRecord(body) || !Array.isArray(body.models)) return { ok: false, error: "模型目录响应无法识别" };
      return {
        ok: true,
        snapshot: {
          models: (body.models as Array<{ id?: unknown; label?: unknown }>).filter(
            (model) => typeof model.id === "string" && model.id !== ""
          ).map((model) => ({ id: model.id as string, label: typeof model.label === "string" ? model.label : (model.id as string) })),
          ...(typeof body.error === "string" ? { error: body.error } : {})
        }
      };
    },
    generate(input, sink) {
      const handle = transport.stream({
        path: path(CHATGPT_ROUTES.generate),
        method: "POST",
        body: input,
        callbacks: {
          onEvent: (event) => {
            let data: unknown;
            try {
              data = JSON.parse(event.data);
            } catch {
              return;
            }
            if (event.type === "progress") sink.progress?.(data as ChatGptProgress);
            else if (event.type === "result") sink.done?.(data as ChatGptGenerationReceipt);
          },
          onError: (message) => sink.done?.({ status: "failed", requestId: input.requestId, mode: input.mode, code: "generate-failed", message }),
          onClose: () => undefined
        }
      });
      return { cancel: () => handle.cancel() };
    },
    async receipt(requestId) {
      const result = await transport.request({ path: path(`${CHATGPT_ROUTES.generate}/${encodeURIComponent(requestId)}`), method: "GET" });
      if (!result.ok || !isRecord(result.data)) return { ok: false, error: "无法读取生成回执" };
      return { ok: true, receipt: result.data as unknown as ChatGptGenerationReceipt };
    }
  };
}
