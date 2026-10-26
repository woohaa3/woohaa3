/**
 * gateway 请求帧 ↔ Node `IncomingMessage` / `ServerResponse` 兼容对象（D6）。
 *
 * 扩展 handler（含 provider-sdk 的 registerModelRefreshRoute）只用到常见子集：`req.method/url/headers`、
 * 读取请求体（async iterate / `on("data")`）、`res.statusCode / setHeader / writeHead / write / end`、
 * `headersSent / writableEnded`。这里用 `Readable` 与一个轻量响应对象覆盖它们。
 *
 * 响应：第一次 writeHead / write / end 时调用 `onHead({ status, headers })`，之后的字节写入响应体流。
 */
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

export type GatewayRequestInit = {
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  body: Readable;
};

export function createIncomingMessage(init: GatewayRequestInit): IncomingMessage {
  const req = init.body as Readable & Record<string, unknown>;
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(init.headers)) headers[key.toLowerCase()] = value;
  Object.assign(req, {
    method: init.method,
    url: init.url,
    headers,
    httpVersion: "1.1",
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    rawHeaders: Object.entries(headers).flatMap(([key, value]) => (Array.isArray(value) ? value.flatMap((item) => [key, item]) : [key, value])),
    socket: { remoteAddress: "127.0.0.1", encrypted: false },
    connection: { remoteAddress: "127.0.0.1", encrypted: false },
    complete: false
  });
  return req as unknown as IncomingMessage;
}

export type ResponseSink = {
  /** 首次输出时调用一次。 */
  onHead(head: { status: number; headers: Record<string, string | string[]> }): void;
  write(bytes: Uint8Array): Promise<void>;
  end(): void;
};

type Listener = (...args: unknown[]) => void;

export function createServerResponse(sink: ResponseSink): ServerResponse & { readonly finished: Promise<void> } {
  const headers = new Map<string, string | string[]>();
  let headSent = false;
  let ended = false;
  let chain: Promise<void> = Promise.resolve();
  const listeners = new Map<string, Set<Listener>>();
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const emit = (event: string) => {
    for (const listener of listeners.get(event) ?? []) listener();
  };
  const toBytes = (chunk: unknown, encoding?: unknown): Uint8Array | null => {
    if (chunk === undefined || chunk === null) return null;
    if (chunk instanceof Uint8Array) return chunk;
    if (typeof chunk === "string") return Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
    return Buffer.from(String(chunk));
  };
  const sendHead = () => {
    if (headSent) return;
    headSent = true;
    sink.onHead({ status: res.statusCode, headers: Object.fromEntries(headers) });
  };
  const res = {
    statusCode: 200,
    statusMessage: "",
    get headersSent() {
      return headSent;
    },
    get writableEnded() {
      return ended;
    },
    get finished() {
      return finished;
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      if (headSent) throw new Error("响应头已发送");
      headers.set(name.toLowerCase(), Array.isArray(value) ? [...value].map(String) : String(value));
      return res;
    },
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    getHeaders: () => Object.fromEntries(headers),
    hasHeader: (name: string) => headers.has(name.toLowerCase()),
    removeHeader(name: string) {
      headers.delete(name.toLowerCase());
    },
    writeHead(status: number, ...rest: unknown[]) {
      res.statusCode = status;
      const maybeHeaders = rest.find((item) => typeof item === "object" && item !== null) as Record<string, string | string[] | number> | undefined;
      if (maybeHeaders) for (const [key, value] of Object.entries(maybeHeaders)) res.setHeader(key, value as string);
      sendHead();
      return res;
    },
    write(chunk: unknown, encoding?: unknown, callback?: unknown) {
      if (ended) return false;
      sendHead();
      const bytes = toBytes(chunk, encoding);
      if (bytes && bytes.byteLength > 0) chain = chain.then(() => sink.write(bytes));
      if (typeof callback === "function") void chain.then(() => (callback as () => void)());
      if (typeof encoding === "function") void chain.then(() => (encoding as () => void)());
      return true;
    },
    end(chunk?: unknown, encoding?: unknown, callback?: unknown) {
      if (ended) return res;
      if (typeof chunk === "function") {
        callback = chunk;
        chunk = undefined;
      }
      if (chunk !== undefined) res.write(chunk, typeof encoding === "string" ? encoding : undefined);
      sendHead();
      ended = true;
      chain = chain.then(() => sink.end()).finally(() => {
        resolveFinished();
        emit("finish");
        emit("close");
      });
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") void chain.then(() => (done as () => void)());
      return res;
    },
    on(event: string, listener: Listener) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(listener);
      return res;
    },
    once(event: string, listener: Listener) {
      const wrapped: Listener = (...args) => {
        listeners.get(event)?.delete(wrapped);
        listener(...args);
      };
      return res.on(event, wrapped);
    },
    off(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener);
      return res;
    },
    removeListener(event: string, listener: Listener) {
      return res.off(event, listener);
    },
    flushHeaders() {
      sendHead();
    }
  };
  return res as unknown as ServerResponse & { readonly finished: Promise<void> };
}
