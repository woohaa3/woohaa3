/**
 * 把 RPC 端点接到 Node IPC 通道（`child_process.fork` 的子进程对象，或子进程内的 `process`）。
 *
 * 通道断开（`disconnect` / `exit`）时关闭端点，在途请求以 `extension-crashed` 失败。
 */
import type { ExtensionHostFrame } from "@woohaa3/contracts";
import { createRpcEndpoint, type RpcEndpoint, type RpcEndpointOptions } from "./endpoint.js";
import type { RpcError } from "./errors.js";

export type IpcChannel = {
  send?: (message: unknown, callback?: (error: Error | null) => void) => boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "disconnect", listener: () => void): unknown;
  off?(event: string, listener: (...args: never[]) => void): unknown;
  readonly connected?: boolean;
};

export function connectIpc(
  channel: IpcChannel,
  options: Omit<RpcEndpointOptions, "send"> & { onSendError?: (error: Error) => void } = {}
): RpcEndpoint {
  const endpoint = createRpcEndpoint({
    ...options,
    send: (frame: ExtensionHostFrame) => {
      if (!channel.send || channel.connected === false) throw new Error("IPC 通道已断开");
      channel.send(frame, (error) => {
        if (error) options.onSendError?.(error);
      });
    },
    onProtocolError: (error: RpcError) => options.onProtocolError?.(error)
  });
  const onMessage = (message: unknown) => endpoint.receive(message);
  const onDisconnect = () => endpoint.close("extension-crashed", "IPC 通道已断开");
  channel.on("message", onMessage);
  channel.on("disconnect", onDisconnect);
  return endpoint;
}
