/**
 * 测试用：一对内存直连的 RPC 端点（不 fork），模拟宿主 ⇄ 子进程。
 * 帧按 IPC advanced 序列化的语义经 structuredClone 传递（Uint8Array 原样保留）。
 */
import { createRpcEndpoint, type RpcEndpoint } from "../rpc/index.js";

export function createRpcPair(): { host: RpcEndpoint; child: RpcEndpoint } {
  let host!: RpcEndpoint;
  let child!: RpcEndpoint;
  host = createRpcEndpoint({ send: (frame) => queueMicrotask(() => child.receive(structuredClone(frame))) });
  child = createRpcEndpoint({ send: (frame) => queueMicrotask(() => host.receive(structuredClone(frame))) });
  return { host, child };
}
