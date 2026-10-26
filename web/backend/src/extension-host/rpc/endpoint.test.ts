import { describe, expect, it } from "vitest";
import { EXTENSION_HOST_METHODS, type ExtensionHostFrame } from "@woohaa3/contracts";
import { createRpcEndpoint, type RpcEndpoint, type RpcEndpointOptions } from "./endpoint.js";
import type { RpcError } from "./errors.js";
import { decodeLarge, encodeLarge, isLargeMarker } from "./large.js";

/** 一对用 microtask 连接的端点；`drop` 为 true 时 a→b 的帧被吞掉（模拟对端不响应）。 */
function pair(options: { a?: Partial<RpcEndpointOptions>; b?: Partial<RpcEndpointOptions> } = {}) {
  const sent: ExtensionHostFrame[] = [];
  const control = { dropToB: false, dropToA: false };
  const protocolErrors: RpcError[] = [];
  let a!: RpcEndpoint;
  let b!: RpcEndpoint;
  a = createRpcEndpoint({
    send: (frame) => {
      sent.push(frame);
      if (!control.dropToB) queueMicrotask(() => b.receive(structuredClone(frame)));
    },
    onProtocolError: (error) => protocolErrors.push(error),
    ...options.a
  });
  b = createRpcEndpoint({
    send: (frame) => {
      if (!control.dropToA) queueMicrotask(() => a.receive(structuredClone(frame)));
    },
    onProtocolError: (error) => protocolErrors.push(error),
    ...options.b
  });
  return { a, b, sent, control, protocolErrors };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("RPC 端点（D3）", () => {
  it("请求往返；处理器错误码透传；未知方法 method-not-found", async () => {
    const { a, b } = pair();
    b.handle("echo", (params) => ({ echoed: params }));
    b.handle("fail", () => {
      throw Object.assign(new Error("坏了"), { code: "permission-denied" });
    });
    await expect(a.request("echo", { x: 1 })).resolves.toEqual({ echoed: { x: 1 } });
    await expect(a.request("fail")).rejects.toMatchObject({ code: "permission-denied", message: "坏了" });
    await expect(a.request("nope")).rejects.toMatchObject({ code: "method-not-found" });
  });

  it("超时：rpc-timeout，并向对端发 $/cancel；迟到响应被丢弃", async () => {
    const { a, b, sent } = pair();
    let release!: (value: unknown) => void;
    let handlerSignal!: AbortSignal;
    b.handle("slow", (_params, { signal }) => {
      handlerSignal = signal;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    await expect(a.request("slow", undefined, { timeoutMs: 20 })).rejects.toMatchObject({ code: "rpc-timeout" });
    expect(sent.some((frame) => "method" in frame && frame.method === EXTENSION_HOST_METHODS.cancel)).toBe(true);
    await tick();
    expect(handlerSignal.aborted).toBe(true);
    release("late");
    await tick();
    expect(a.inFlight()).toBe(0);
  });

  it("调用方 AbortSignal → rpc-cancelled + $/cancel，处理器 signal abort", async () => {
    const { a, b } = pair();
    let handlerSignal!: AbortSignal;
    b.handle("wait", (_params, { signal }) => {
      handlerSignal = signal;
      return new Promise(() => undefined);
    });
    const controller = new AbortController();
    const pending = a.request("wait", undefined, { signal: controller.signal, timeoutMs: 0 });
    await tick();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "rpc-cancelled" });
    await tick();
    expect(handlerSignal.aborted).toBe(true);
  });

  it("在途上限 rpc-busy；超限帧拒发 frame-too-large", async () => {
    const { a, b, control } = pair({ a: { limits: { maxInFlight: 2, maxFrameBytes: 1024 } } });
    control.dropToB = true;
    void a.request("x", undefined, { timeoutMs: 0 }).catch(() => undefined);
    void a.request("x", undefined, { timeoutMs: 0 }).catch(() => undefined);
    await expect(a.request("x")).rejects.toMatchObject({ code: "rpc-busy" });
    a.close();
    const big = pair({ a: { limits: { maxFrameBytes: 1024 } } });
    big.b.handle("x", () => null);
    await expect(big.a.request("x", { blob: new Uint8Array(4096) })).rejects.toMatchObject({ code: "frame-too-large" });
    void b;
  });

  it("收到超限 / 非法帧回调 onProtocolError，不抛错", () => {
    const errors: RpcError[] = [];
    const endpoint = createRpcEndpoint({ send: () => undefined, onProtocolError: (error) => errors.push(error), limits: { maxFrameBytes: 64 } });
    endpoint.receive({ jsonrpc: "2.0", method: "x", params: "y".repeat(200) });
    endpoint.receive({ nope: true });
    endpoint.receive("garbage");
    expect(errors).toHaveLength(3);
    expect(errors.every((error) => error.code === "rpc-protocol-error")).toBe(true);
  });

  it("结果帧超限：调用方收到 frame-too-large 而不是一直等", async () => {
    const { a, b } = pair({ b: { limits: { maxFrameBytes: 1024 } } });
    b.handle("big", () => ({ blob: new Uint8Array(4096) }));
    await expect(a.request("big")).rejects.toMatchObject({ code: "frame-too-large" });
  });

  it("对端消失：close 后全部在途失败（extension-crashed），之后请求立即失败；不自动重试", async () => {
    const { a, b, sent } = pair();
    let calls = 0;
    b.handle("hang", () => {
      calls += 1;
      return new Promise(() => undefined);
    });
    const first = a.request("hang", undefined, { timeoutMs: 0 });
    const second = a.request("hang", undefined, { timeoutMs: 0 });
    await tick();
    a.close();
    await expect(first).rejects.toMatchObject({ code: "extension-crashed" });
    await expect(second).rejects.toMatchObject({ code: "extension-crashed" });
    await expect(a.request("hang")).rejects.toMatchObject({ code: "extension-crashed" });
    await tick();
    expect(calls).toBe(2);
    expect(sent.filter((frame) => "method" in frame && frame.method === "hang")).toHaveLength(2);
  });

  it("通知：onNotification 收到；处理器异常不影响端点", async () => {
    const { a, b } = pair();
    const received: unknown[] = [];
    b.onNotification("ctx.log", () => {
      throw new Error("x");
    });
    b.onNotification("ctx.log", (params) => received.push(params));
    a.notify("ctx.log", { message: "hi" });
    await tick();
    expect(received).toEqual([{ message: "hi" }]);
  });
});

describe("流帧与背压（D3）", () => {
  it("大字节自动切块、按序到达；信用耗尽时发送端等待", async () => {
    const { a, b } = pair({ a: { limits: { maxChunkBytes: 4, initialStreamCredit: 2 } }, b: { limits: { maxChunkBytes: 4 } } });
    let incoming!: import("./streams.js").IncomingStream;
    b.streams.accept("body", (stream) => {
      incoming = stream;
    });
    const out = a.streams.open("body", { contentType: "text/plain" });
    const written = out.write(new TextEncoder().encode("abcdefghijkl")).then(() => out.end());
    await tick();
    // 3 块但只有 2 个信用：写入尚未完成。
    let done = false;
    void written.then(() => {
      done = true;
    });
    await tick();
    expect(done).toBe(false);
    expect(incoming.meta).toEqual({ contentType: "text/plain" });
    const chunks: string[] = [];
    for await (const chunk of incoming) chunks.push(new TextDecoder().decode(chunk));
    await written;
    expect(chunks.join("")).toBe("abcdefghijkl");
    expect(chunks).toEqual(["abcd", "efgh", "ijkl"]);
  });

  it("接收方 cancel → 发送端 write 抛 rpc-cancelled；端点关闭 → 读取方抛 extension-crashed", async () => {
    const { a, b } = pair({ a: { limits: { maxChunkBytes: 2, initialStreamCredit: 1 } } });
    let incoming!: import("./streams.js").IncomingStream;
    b.streams.accept("body", (stream) => {
      incoming = stream;
    });
    const out = a.streams.open("body");
    await tick();
    incoming.cancel();
    await tick();
    await expect(out.write(new Uint8Array(8))).rejects.toMatchObject({ code: "rpc-cancelled" });

    const second = pair();
    let reader!: import("./streams.js").IncomingStream;
    second.b.streams.accept("body", (stream) => {
      reader = stream;
    });
    second.a.streams.open("body");
    await tick();
    second.b.close();
    await expect((async () => {
      for await (const _ of reader) void _;
    })()).rejects.toMatchObject({ code: "extension-crashed" });
  });

  it("pipeFrom AsyncIterable 与 toReadable 适配", async () => {
    const { a, b } = pair();
    const out = a.streams.open("upload");
    const reader = b.streams.take(out.streamId);
    async function* source() {
      yield "hello ";
      yield new TextEncoder().encode("world");
    }
    const piping = out.pipeFrom(source());
    const parts: Buffer[] = [];
    for await (const chunk of reader.toReadable()) parts.push(Buffer.from(chunk as Uint8Array));
    await piping;
    expect(Buffer.concat(parts).toString()).toBe("hello world");
  });
});

describe("大载荷（D3）", () => {
  it("超过半帧走 rpc.large 流，Uint8Array 原样还原；小载荷不变", async () => {
    const { a, b } = pair({ a: { limits: { maxFrameBytes: 4096, maxChunkBytes: 512 } }, b: { limits: { maxFrameBytes: 4096, maxChunkBytes: 512 } } });
    b.handle("image", async (params) => {
      const decoded = await decodeLarge<{ bytes: Uint8Array }>(b, params);
      return encodeLarge(b, { echoed: decoded.bytes, size: decoded.bytes.byteLength });
    });
    const bytes = new Uint8Array(10_000).map((_, index) => index % 251);
    const marker = encodeLarge(a, { bytes });
    expect(isLargeMarker(marker)).toBe(true);
    const result = await decodeLarge<{ echoed: Uint8Array; size: number }>(a, await a.request("image", marker));
    expect(result.size).toBe(10_000);
    expect(result.echoed).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(result.echoed).equals(Buffer.from(bytes))).toBe(true);
    expect(encodeLarge(a, { small: 1 })).toEqual({ small: 1 });
  });
});
