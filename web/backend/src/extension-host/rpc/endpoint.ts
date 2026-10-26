/**
 * 双向 JSON-RPC 端点（change: 2026-10-21-isolate-extension-host-process，D3）。
 *
 * 宿主与子进程各持一个：`send` 把帧交给 IPC，`receive` 喂入对端的帧。端点负责：
 * - 请求表、超时（`rpc-timeout`，超时后向对端发 `$/cancel`）、调用方 AbortSignal → `$/cancel`；
 * - 每方向在途上限（`rpc-busy`），迟到响应丢弃；
 * - 发送前估算帧大小，超限拒发（`frame-too-large`）；收到超限 / 非法帧回调 `onProtocolError`
 *   （由 supervisor 判崩溃，D7）；
 * - 处理器拿到的 `AbortSignal` 在对端 `$/cancel` 或端点关闭时 abort；
 * - 流帧交给 `StreamRegistry`（见 `streams.ts`）。
 *
 * **不自动重试**任何请求：对端副作用是否已发生不可知，重试由上层按幂等方法决定。
 * `close(reason)` 让全部在途请求以给定错误码失败（缺省 `extension-crashed`），之后一切发送立即失败。
 */
import {
  EXTENSION_HOST_LIMITS,
  EXTENSION_HOST_METHODS,
  type ExtensionHostFrame,
  type ExtensionHostResponseFrame
} from "@woohaa3/contracts";
import { RpcError, fromWireError, toWireError } from "./errors.js";
import { estimateFrameBytes } from "./frame-size.js";
import { createStreamRegistry, type StreamRegistry } from "./streams.js";

export type RpcLimits = {
  maxFrameBytes: number;
  maxInFlight: number;
  requestTimeoutMs: number;
  maxChunkBytes: number;
  initialStreamCredit: number;
};

export type RpcHandlerContext = { signal: AbortSignal; method: string };
export type RpcHandler = (params: unknown, context: RpcHandlerContext) => unknown | Promise<unknown>;
export type RpcNotificationHandler = (params: unknown) => void;

export type RpcRequestOptions = {
  signal?: AbortSignal;
  /** 覆盖缺省超时；`0` 表示不设超时（仍可被 signal / close 终止）。 */
  timeoutMs?: number;
};

export type RpcEndpoint = {
  request<T = unknown>(method: string, params?: unknown, options?: RpcRequestOptions): Promise<T>;
  notify(method: string, params?: unknown): void;
  handle(method: string, handler: RpcHandler): () => void;
  onNotification(method: string, handler: RpcNotificationHandler): () => void;
  /** 喂入对端帧。非法或超限帧回调 `onProtocolError`，不抛错。 */
  receive(frame: unknown): void;
  /** 关闭：在途请求以 `code` 失败，处理器 signal abort，流全部 abort。幂等。 */
  close(code?: string, message?: string): void;
  readonly closed: boolean;
  /** 本端发出、尚未完成的请求数。 */
  inFlight(): number;
  readonly streams: StreamRegistry;
};

export type RpcEndpointOptions = {
  send: (frame: ExtensionHostFrame) => void;
  onProtocolError?: (error: RpcError) => void;
  limits?: Partial<RpcLimits>;
  /** 测试注入。 */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer?: unknown;
  cleanup: () => void;
};

const CONTROL = new Set<string>([EXTENSION_HOST_METHODS.cancel]);

export function createRpcEndpoint(options: RpcEndpointOptions): RpcEndpoint {
  const limits: RpcLimits = {
    maxFrameBytes: EXTENSION_HOST_LIMITS.maxFrameBytes,
    maxInFlight: EXTENSION_HOST_LIMITS.maxInFlight,
    requestTimeoutMs: EXTENSION_HOST_LIMITS.requestTimeoutMs,
    maxChunkBytes: EXTENSION_HOST_LIMITS.maxChunkBytes,
    initialStreamCredit: EXTENSION_HOST_LIMITS.initialStreamCredit,
    ...options.limits
  };
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => {
    const handle = setTimeout(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  });
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const pending = new Map<number, Pending>();
  const handlers = new Map<string, RpcHandler>();
  const notificationHandlers = new Map<string, Set<RpcNotificationHandler>>();
  /** 对端发来、本端正在处理的请求：id → AbortController。 */
  const incoming = new Map<number, AbortController>();
  let nextId = 1;
  let closed = false;
  let closeError: RpcError | null = null;

  const protocolError = (message: string, data?: unknown) => {
    options.onProtocolError?.(new RpcError("rpc-protocol-error", message, data));
  };

  const rawSend = (frame: ExtensionHostFrame): void => {
    if (closed) throw closeError ?? new RpcError("extension-unavailable", "RPC 端点已关闭");
    const size = estimateFrameBytes(frame, limits.maxFrameBytes);
    if (size > limits.maxFrameBytes) {
      throw new RpcError("frame-too-large", `帧大小超过上限 ${limits.maxFrameBytes} 字节`);
    }
    options.send(frame);
  };

  const streams = createStreamRegistry({
    notify: (method, params) => rawSend({ jsonrpc: "2.0", method, params }),
    maxFrameBytes: limits.maxFrameBytes,
    maxChunkBytes: limits.maxChunkBytes,
    initialCredit: limits.initialStreamCredit,
    onProtocolError: (message) => protocolError(message)
  });

  const settle = (id: number): Pending | undefined => {
    const entry = pending.get(id);
    if (!entry) return undefined;
    pending.delete(id);
    if (entry.timer !== undefined) clearTimer(entry.timer);
    entry.cleanup();
    return entry;
  };

  const sendCancel = (id: number) => {
    try {
      rawSend({ jsonrpc: "2.0", method: EXTENSION_HOST_METHODS.cancel, params: { id } });
    } catch {
      // 端点已关闭或发送失败：对端会随之失去连接，没有可取消的东西。
    }
  };

  const request = <T>(method: string, params?: unknown, requestOptions: RpcRequestOptions = {}): Promise<T> => {
    if (closed) return Promise.reject(closeError ?? new RpcError("extension-unavailable", "RPC 端点已关闭"));
    if (pending.size >= limits.maxInFlight) {
      return Promise.reject(new RpcError("rpc-busy", `在途请求达到上限 ${limits.maxInFlight}`));
    }
    const { signal } = requestOptions;
    if (signal?.aborted) return Promise.reject(new RpcError("rpc-cancelled", "请求已取消"));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (!settle(id)) return;
        sendCancel(id);
        reject(new RpcError("rpc-cancelled", "请求已取消"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const entry: Pending = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort)
      };
      const timeoutMs = requestOptions.timeoutMs ?? limits.requestTimeoutMs;
      if (timeoutMs > 0) {
        entry.timer = setTimer(() => {
          if (!settle(id)) return;
          sendCancel(id);
          reject(new RpcError("rpc-timeout", `${method} 超过 ${timeoutMs}ms 未响应`));
        }, timeoutMs);
      }
      pending.set(id, entry);
      try {
        rawSend({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
      } catch (error) {
        settle(id);
        reject(error);
      }
    });
  };

  const notify = (method: string, params?: unknown) => {
    rawSend({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  };

  const respond = (frame: ExtensionHostResponseFrame) => {
    if (closed) return;
    try {
      rawSend(frame);
    } catch (error) {
      // 结果帧超限：改发错误帧，让调用方得到确定失败而不是一直等到超时。
      if (error instanceof RpcError && error.code === "frame-too-large") {
        try {
          rawSend({ jsonrpc: "2.0", id: frame.id, error: error.toWire() });
        } catch {
          // 连错误帧都发不出去：端点已关闭。
        }
      }
    }
  };

  const dispatchRequest = (id: number, method: string, params: unknown) => {
    const handler = handlers.get(method);
    if (!handler) {
      respond({ jsonrpc: "2.0", id, error: { code: "method-not-found", message: `未知方法：${method}` } });
      return;
    }
    if (incoming.has(id)) {
      protocolError(`重复的请求 id：${id}`);
      return;
    }
    const controller = new AbortController();
    incoming.set(id, controller);
    Promise.resolve()
      .then(() => handler(params, { signal: controller.signal, method }))
      .then(
        (result) => {
          if (incoming.get(id) !== controller) return;
          incoming.delete(id);
          if (controller.signal.aborted) return;
          respond({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
        },
        (error: unknown) => {
          if (incoming.get(id) !== controller) return;
          incoming.delete(id);
          if (controller.signal.aborted) return;
          respond({ jsonrpc: "2.0", id, error: toWireError(error) });
        }
      );
  };

  const dispatchNotification = (method: string, params: unknown) => {
    if (method === EXTENSION_HOST_METHODS.cancel) {
      const id = (params as { id?: unknown } | undefined)?.id;
      if (typeof id === "number") {
        const controller = incoming.get(id);
        incoming.delete(id);
        controller?.abort(new RpcError("rpc-cancelled", "对端已取消"));
      }
      return;
    }
    if (streams.handles(method)) {
      streams.receive(method, params);
      return;
    }
    const listeners = notificationHandlers.get(method);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(params);
      } catch {
        // 通知处理器出错不影响端点。
      }
    }
  };

  const receive = (frame: unknown) => {
    if (closed) return;
    if (estimateFrameBytes(frame, limits.maxFrameBytes) > limits.maxFrameBytes) {
      protocolError("收到超限帧");
      return;
    }
    if (typeof frame !== "object" || frame === null || (frame as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
      protocolError("非法 JSON-RPC 帧");
      return;
    }
    const value = frame as Record<string, unknown>;
    if (typeof value.method === "string") {
      if (value.id === undefined) {
        dispatchNotification(value.method, value.params);
      } else if (typeof value.id === "number" && !CONTROL.has(value.method)) {
        dispatchRequest(value.id, value.method, value.params);
      } else {
        protocolError("请求 id 非法");
      }
      return;
    }
    if (typeof value.id === "number" && ("result" in value || "error" in value)) {
      // 迟到响应（已超时 / 已取消）：请求表里没有，直接丢弃。
      const entry = settle(value.id);
      if (!entry) return;
      if ("error" in value && value.error) {
        const wire = value.error as { code?: unknown; message?: unknown; data?: unknown };
        entry.reject(fromWireError({ code: String(wire.code ?? "internal-error"), message: String(wire.message ?? ""), data: wire.data }));
      } else {
        entry.resolve(value.result);
      }
      return;
    }
    protocolError("无法识别的帧");
  };

  const close = (code = "extension-crashed", message = "对端已断开") => {
    if (closed) return;
    closeError = new RpcError(code, message);
    closed = true;
    for (const id of [...pending.keys()]) settle(id)?.reject(closeError);
    for (const controller of incoming.values()) controller.abort(closeError);
    incoming.clear();
    streams.abortAll(code);
  };

  return {
    request,
    notify,
    handle(method, handler) {
      handlers.set(method, handler);
      return () => {
        if (handlers.get(method) === handler) handlers.delete(method);
      };
    },
    onNotification(method, handler) {
      let set = notificationHandlers.get(method);
      if (!set) notificationHandlers.set(method, (set = new Set()));
      set.add(handler);
      return () => set!.delete(handler);
    },
    receive,
    close,
    get closed() {
      return closed;
    },
    inFlight: () => pending.size,
    streams
  };
}
