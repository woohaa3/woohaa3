/**
 * 大载荷（change: 2026-10-21-isolate-extension-host-process，D3）。
 *
 * 结果或参数估算超过单帧上限一半时，不进 JSON-RPC 帧，而是 `v8.serialize` 后走 `rpc.large` 流：
 * 帧里只放 `{ $large: streamId }` 标记。发送端在后台写流（不等写完，否则接收端拿不到标记就不会消费，
 * 信用永远不回来）。接收端 `decodeLarge` 认领流、拼接、反序列化。
 *
 * v8 序列化支持 Uint8Array / Map / Date / Error；函数与 symbol 会抛错——这正是跨进程边界该暴露的错误。
 */
import v8 from "node:v8";
import type { RpcEndpoint } from "./endpoint.js";
import { estimateFrameBytes } from "./frame-size.js";

export const LARGE_STREAM_KIND = "rpc.large";

export type LargeMarker = { $large: string };

export function isLargeMarker(value: unknown): value is LargeMarker {
  return typeof value === "object" && value !== null && typeof (value as { $large?: unknown }).$large === "string" && Object.keys(value).length === 1;
}

/** 超过阈值时改走流，返回标记；否则原样返回。阈值缺省为单帧上限的一半。 */
export function encodeLarge(endpoint: RpcEndpoint, value: unknown, threshold = endpoint.streams.maxFrameBytes / 2): unknown {
  if (estimateFrameBytes(value, threshold) <= threshold) return value;
  const bytes = v8.serialize(value);
  const out = endpoint.streams.open(LARGE_STREAM_KIND, { bytes: bytes.byteLength });
  void out.write(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)).then(
    () => out.end(),
    () => out.abort("large-write-failed")
  );
  return { $large: out.streamId } satisfies LargeMarker;
}

/** 标记 → 认领流并反序列化；非标记原样返回。 */
export async function decodeLarge<T = unknown>(endpoint: RpcEndpoint, value: unknown): Promise<T> {
  if (!isLargeMarker(value)) return value as T;
  const stream = endpoint.streams.take(value.$large);
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    parts.push(chunk);
    total += chunk.byteLength;
  }
  const joined = Buffer.concat(parts.map((part) => Buffer.from(part.buffer, part.byteOffset, part.byteLength)), total);
  return v8.deserialize(joined) as T;
}
