/** Extension Host RPC 运行时（宿主与子进程共用）。 */
export { createRpcEndpoint, type RpcEndpoint, type RpcEndpointOptions, type RpcHandler, type RpcHandlerContext, type RpcLimits, type RpcRequestOptions } from "./endpoint.js";
export { RpcError, isRpcError, toWireError, fromWireError } from "./errors.js";
export { estimateFrameBytes } from "./frame-size.js";
export type { IncomingStream, OutgoingStream, StreamRegistry } from "./streams.js";
export { connectIpc, type IpcChannel } from "./ipc.js";
export { encodeLarge, decodeLarge, isLargeMarker, LARGE_STREAM_KIND, type LargeMarker } from "./large.js";
