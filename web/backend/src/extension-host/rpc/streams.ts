/**
 * 流帧（change: 2026-10-21-isolate-extension-host-process，D3）。
 *
 * `stream.open { streamId, kind, meta }` → `stream.chunk { streamId, seq, bytes }`（每块 ≤ maxChunkBytes）→
 * `stream.end` / `stream.abort { reason }`。接收端用 `stream.credit { streamId, n }` 背压：发送端只在有信用时
 * 发块，初始信用 `initialCredit` 块；接收端每消费一块归还一块信用。
 *
 * 发送端：`open(kind, meta)` 返回 `OutgoingStream`，`write(bytes)` 在信用耗尽时等待；也可 `pipeFrom(iterable)`。
 * 接收端：`accept(kind, handler)` 登记某类流的处理器，处理器拿到 `IncomingStream`（AsyncIterable<Uint8Array>）；
 * 也可 `take(streamId)` 按 id 认领（请求参数里带 streamId 时）。
 */
import { Readable } from "node:stream";
import { EXTENSION_HOST_METHODS } from "@woohaa3/contracts";
import { RpcError } from "./errors.js";

export type IncomingStream = AsyncIterable<Uint8Array> & {
  readonly streamId: string;
  readonly kind: string;
  readonly meta: unknown;
  /** 接收方放弃：通知发送端 abort。 */
  cancel(reason?: string): void;
  /** 转成 Node Readable（gateway 请求体等）。 */
  toReadable(): Readable;
};

export type OutgoingStream = {
  readonly streamId: string;
  /** 写入一段字节（自动切块）；信用不足时等待。流已中止时抛错。 */
  write(bytes: Uint8Array): Promise<void>;
  end(): void;
  abort(reason: string): void;
  /** 从 AsyncIterable / Readable 拉取并写完；出错时 abort 并重新抛出。 */
  pipeFrom(source: AsyncIterable<Uint8Array | string>): Promise<void>;
  readonly aborted: boolean;
};

export type StreamRegistry = {
  /** 所属端点的单帧上限（大载荷阈值据此计算）。 */
  readonly maxFrameBytes: number;
  open(kind: string, meta?: unknown): OutgoingStream;
  accept(kind: string, handler: (stream: IncomingStream) => void): () => void;
  /** 按 id 认领一条已到达或即将到达的流。 */
  take(streamId: string): IncomingStream;
  handles(method: string): boolean;
  receive(method: string, params: unknown): void;
  abortAll(reason: string): void;
};

type StreamOptions = {
  notify: (method: string, params: unknown) => void;
  maxFrameBytes: number;
  maxChunkBytes: number;
  initialCredit: number;
  onProtocolError: (message: string) => void;
};

const STREAM_METHODS = new Set<string>([
  EXTENSION_HOST_METHODS.streamOpen,
  EXTENSION_HOST_METHODS.streamChunk,
  EXTENSION_HOST_METHODS.streamEnd,
  EXTENSION_HOST_METHODS.streamAbort,
  EXTENSION_HOST_METHODS.streamCredit
]);

let streamCounter = 0;

export function createStreamRegistry(options: StreamOptions): StreamRegistry {
  const outgoing = new Map<string, { credit: number; waiters: Array<() => void>; aborted: string | null }>();
  const incoming = new Map<string, ReturnType<typeof createIncoming>>();
  const acceptors = new Map<string, (stream: IncomingStream) => void>();
  const prefix = `s${process.pid}-${Date.now().toString(36)}`;

  function createIncoming(streamId: string) {
    const queue: Uint8Array[] = [];
    let ended = false;
    let failure: RpcError | null = null;
    let wake: (() => void) | null = null;
    let kind = "";
    let meta: unknown;
    let nextSeq = 0;
    let opened = false;
    /** 已被 take / accept 认领。未认领的流结束后仍留在表里，等待认领（请求帧可能晚于流帧到达）。 */
    let claimed = false;
    const notifyWake = () => {
      const fn = wake;
      wake = null;
      fn?.();
    };
    const stream: IncomingStream = {
      streamId,
      get kind() {
        return kind;
      },
      get meta() {
        return meta;
      },
      cancel(reason = "receiver-cancelled") {
        if (ended || failure) return;
        failure = new RpcError("rpc-cancelled", reason);
        incoming.delete(streamId);
        try {
          options.notify(EXTENSION_HOST_METHODS.streamAbort, { streamId, reason });
        } catch {
          // 端点已关闭。
        }
        notifyWake();
      },
      toReadable() {
        return Readable.from(stream, { objectMode: false });
      },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (queue.length > 0) {
            const chunk = queue.shift()!;
            // 消费一块即归还一块信用。
            try {
              options.notify(EXTENSION_HOST_METHODS.streamCredit, { streamId, n: 1 });
            } catch {
              // 端点关闭：后续由 failure 收尾。
            }
            yield chunk;
            continue;
          }
          if (failure) throw failure;
          if (ended) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      }
    };
    return {
      stream,
      open(nextKind: string, nextMeta: unknown) {
        opened = true;
        kind = nextKind;
        meta = nextMeta;
      },
      get opened() {
        return opened;
      },
      claim() {
        claimed = true;
        if (ended || failure) incoming.delete(streamId);
      },
      chunk(seq: number, bytes: Uint8Array) {
        if (seq !== nextSeq) {
          options.onProtocolError(`流 ${streamId} 序号错乱：期望 ${nextSeq}，收到 ${seq}`);
          return;
        }
        if (bytes.byteLength > options.maxChunkBytes) {
          options.onProtocolError(`流 ${streamId} 单块超限`);
          return;
        }
        nextSeq += 1;
        queue.push(bytes);
        notifyWake();
      },
      end() {
        ended = true;
        if (claimed) incoming.delete(streamId);
        notifyWake();
      },
      abort(reason: string) {
        failure = new RpcError(reason === "extension-crashed" || reason === "extension-replaced" ? reason : "rpc-cancelled", `流已中止：${reason}`);
        if (claimed) incoming.delete(streamId);
        notifyWake();
      }
    };
  }

  const incomingFor = (streamId: string) => {
    let entry = incoming.get(streamId);
    if (!entry) incoming.set(streamId, (entry = createIncoming(streamId)));
    return entry;
  };

  const open = (kind: string, meta?: unknown): OutgoingStream => {
    const streamId = `${prefix}-${++streamCounter}`;
    const state = { credit: options.initialCredit, waiters: [] as Array<() => void>, aborted: null as string | null };
    outgoing.set(streamId, state);
    let seq = 0;
    let ended = false;
    options.notify(EXTENSION_HOST_METHODS.streamOpen, { streamId, kind, ...(meta !== undefined ? { meta } : {}) });
    const waitCredit = async () => {
      while (state.credit <= 0 && !state.aborted) {
        await new Promise<void>((resolve) => state.waiters.push(resolve));
      }
      if (state.aborted) throw new RpcError("rpc-cancelled", `流已中止：${state.aborted}`);
    };
    const stream: OutgoingStream = {
      streamId,
      get aborted() {
        return state.aborted !== null;
      },
      async write(bytes) {
        if (ended) throw new RpcError("rpc-protocol-error", "流已结束");
        for (let offset = 0; offset < bytes.byteLength; offset += options.maxChunkBytes) {
          await waitCredit();
          state.credit -= 1;
          const slice = bytes.subarray(offset, Math.min(bytes.byteLength, offset + options.maxChunkBytes));
          // 复制一份：结构化克隆前调用方可能复用缓冲区。
          options.notify(EXTENSION_HOST_METHODS.streamChunk, { streamId, seq: seq++, bytes: new Uint8Array(slice) });
        }
      },
      end() {
        if (ended || state.aborted) return;
        ended = true;
        outgoing.delete(streamId);
        options.notify(EXTENSION_HOST_METHODS.streamEnd, { streamId });
      },
      abort(reason) {
        if (ended || state.aborted) return;
        state.aborted = reason;
        outgoing.delete(streamId);
        for (const waiter of state.waiters.splice(0)) waiter();
        try {
          options.notify(EXTENSION_HOST_METHODS.streamAbort, { streamId, reason });
        } catch {
          // 端点已关闭。
        }
      },
      async pipeFrom(source) {
        try {
          for await (const chunk of source) {
            await stream.write(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
          }
          stream.end();
        } catch (error) {
          stream.abort(error instanceof RpcError ? error.code : "source-error");
          throw error;
        }
      }
    };
    return stream;
  };

  const receive = (method: string, params: unknown) => {
    const value = (params ?? {}) as Record<string, unknown>;
    const streamId = value.streamId;
    if (typeof streamId !== "string") {
      options.onProtocolError("流帧缺少 streamId");
      return;
    }
    switch (method) {
      case EXTENSION_HOST_METHODS.streamOpen: {
        const entry = incomingFor(streamId);
        entry.open(String(value.kind ?? ""), value.meta);
        const acceptor = acceptors.get(entry.stream.kind);
        if (acceptor) {
          entry.claim();
          acceptor(entry.stream);
        }
        return;
      }
      case EXTENSION_HOST_METHODS.streamChunk: {
        const bytes = value.bytes;
        if (!(bytes instanceof Uint8Array) || typeof value.seq !== "number") {
          options.onProtocolError(`流 ${streamId} 块格式非法`);
          return;
        }
        incoming.get(streamId)?.chunk(value.seq, bytes);
        return;
      }
      case EXTENSION_HOST_METHODS.streamEnd:
        incoming.get(streamId)?.end();
        return;
      case EXTENSION_HOST_METHODS.streamAbort: {
        incoming.get(streamId)?.abort(String(value.reason ?? "aborted"));
        const out = outgoing.get(streamId);
        if (out) {
          out.aborted = String(value.reason ?? "aborted");
          outgoing.delete(streamId);
          for (const waiter of out.waiters.splice(0)) waiter();
        }
        return;
      }
      case EXTENSION_HOST_METHODS.streamCredit: {
        const out = outgoing.get(streamId);
        const n = typeof value.n === "number" && value.n > 0 ? Math.floor(value.n) : 0;
        if (!out || n === 0) return;
        out.credit += n;
        for (const waiter of out.waiters.splice(0)) waiter();
        return;
      }
      default:
        return;
    }
  };

  return {
    maxFrameBytes: options.maxFrameBytes,
    open,
    accept(kind, handler) {
      acceptors.set(kind, handler);
      return () => {
        if (acceptors.get(kind) === handler) acceptors.delete(kind);
      };
    },
    take: (streamId) => {
      const entry = incomingFor(streamId);
      entry.claim();
      return entry.stream;
    },
    handles: (method) => STREAM_METHODS.has(method),
    receive,
    abortAll(reason) {
      for (const entry of [...incoming.values()]) entry.abort(reason);
      incoming.clear();
      for (const [, out] of outgoing) {
        out.aborted = reason;
        for (const waiter of out.waiters.splice(0)) waiter();
      }
      outgoing.clear();
    }
  };
}
