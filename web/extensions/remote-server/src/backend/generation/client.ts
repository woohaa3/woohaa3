/**
 * 服务端托管生成的 Connect JSON 客户端（change: 2026-10-20-reserve-remote-generation-provider，任务 5.1）。
 *
 * 复用 `../connect.ts` 的 `callConnect`：Bearer 只在本机宿主、远端正文一律压成稳定短语；
 * 不引 `@connectrpc`（这里只需要 5 个一元调用，两端共享的是 proto 语义，不是生成代码）。
 *
 * 本模块**不持有会话**：会话唯一归属 `../session.ts`，每次调用由调用方传入。
 */
import { connectProcedurePath } from "../../shared.js";
import { callConnect } from "../connect.js";
import { GENERATION_METHODS, GENERATION_SERVICE } from "./protocol.js";

/** 生成调用比登录/探测更重（目录可能很大），但仍必须有界：挂住比失败更糟。 */
export const GENERATION_REQUEST_TIMEOUT_MS = 15_000;

/** 调用方传入的会话引用（与服务端会话同形；令牌不落任何持久物）。 */
export type GenerationSessionRef = { serverUrl: string; token: string };

export type GenerationCall<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string };

export type GenerationClient = {
  getCapabilities(session: GenerationSessionRef): Promise<GenerationCall<unknown>>;
  getCatalog(session: GenerationSessionRef): Promise<GenerationCall<unknown>>;
  submitTask(session: GenerationSessionRef, body: Record<string, unknown>): Promise<GenerationCall<unknown>>;
  getTask(session: GenerationSessionRef, input: { taskId?: string; idempotencyKey?: string }): Promise<GenerationCall<unknown>>;
  cancelTask(session: GenerationSessionRef, taskId: string): Promise<GenerationCall<unknown>>;
};

export function createGenerationClient(options: {
  fetchImpl: typeof globalThis.fetch;
  timeoutMs?: number;
}): GenerationClient {
  const timeoutMs = options.timeoutMs ?? GENERATION_REQUEST_TIMEOUT_MS;
  const call = <T>(session: GenerationSessionRef, method: string, body: unknown): Promise<GenerationCall<T>> =>
    callConnect<T>(
      options.fetchImpl,
      session.serverUrl,
      connectProcedurePath(GENERATION_SERVICE, method),
      body,
      { token: session.token, timeoutMs }
    );

  return {
    getCapabilities: (session) => call(session, GENERATION_METHODS.getCapabilities, {}),
    getCatalog: (session) => call(session, GENERATION_METHODS.getCatalog, {}),
    submitTask: (session, body) => call(session, GENERATION_METHODS.submitTask, body),
    getTask: (session, input) => {
      // GetTask 的 reference 是 oneof：恰好给一个键（ProtoJSON 就是同名成员）。
      const body: Record<string, unknown> =
        typeof input.taskId === "string" && input.taskId !== ""
          ? { taskId: input.taskId }
          : { idempotencyKey: input.idempotencyKey ?? "" };
      return call(session, GENERATION_METHODS.getTask, body);
    },
    cancelTask: (session, taskId) => call(session, GENERATION_METHODS.cancelTask, { taskId })
  };
}
