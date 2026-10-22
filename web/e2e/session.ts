/**
 * E2E Canvas Session 协议辅助
 * （change: unify-canvas-session-websocket，任务 6.4 / 7.2）。
 *
 * 物理 `/api/canvases/:canvasId/sync` 现在是版本化 Canvas Session：所有 E2E 协议客户端
 * 必须声明 `sessionProtocolVersion` 并用 channel envelope 承载 Yjs / task-activity 帧。
 * 这里集中 URL 构造与 envelope 包装，避免每个 spec 重复 wire 细节。
 */
import {
  CANVAS_SESSION_PROTOCOL_VERSION,
  SESSION_CHANNEL,
  YJS_CANVAS_FORMAT_VERSION,
  YJS_SYNC_PROTOCOL_VERSION,
  decodeMessage,
  decodeSessionFrame,
  encodeSessionFrame,
  type DecodedMessage
} from "@woohaa3/contracts/canvas-yjs";

/** 同步连接的版本化 query（含内层 Yjs 版本与可选 roomEpoch）。 */
export function sessionQuery(options: { roomEpoch?: string | null } = {}): string {
  const params = new URLSearchParams({
    sessionProtocolVersion: String(CANVAS_SESSION_PROTOCOL_VERSION),
    protocolVersion: String(YJS_SYNC_PROTOCOL_VERSION),
    formatVersion: YJS_CANVAS_FORMAT_VERSION
  });
  if (options.roomEpoch) params.set("roomEpoch", options.roomEpoch);
  return params.toString();
}

/** 构造 WebSocket URL。 */
export function sessionWsUrl(input: {
  wsBase: string;
  canvasId: string;
  roomEpoch?: string | null;
}): string {
  return `${input.wsBase}/api/canvases/${encodeURIComponent(input.canvasId)}/sync?${sessionQuery({
    roomEpoch: input.roomEpoch ?? null
  })}`;
}

/** 把一个内层 Yjs payload 包进 `canvas-yjs` 通道。 */
export function yjsFrame(payload: Uint8Array): Uint8Array {
  return encodeSessionFrame(SESSION_CHANNEL.CANVAS_YJS, payload);
}

/**
 * 解码一条入站物理帧；只返回 `canvas-yjs` 通道的内层消息。
 * control / task-activity / 畸形帧返回 null（调用方可忽略）。
 */
export function decodeYjsFrame(raw: Uint8Array | ArrayBuffer | Buffer): DecodedMessage | null {
  const bytes = raw instanceof Uint8Array
    ? new Uint8Array(raw)
    : raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  try {
    const frame = decodeSessionFrame(bytes);
    if (frame.channelId !== SESSION_CHANNEL.CANVAS_YJS) return null;
    return decodeMessage(frame.payload);
  } catch {
    return null;
  }
}

/** 解码一条入站物理帧的通道（诊断用）。 */
export function frameChannel(raw: Uint8Array | ArrayBuffer | Buffer): number | null {
  const bytes = raw instanceof Uint8Array
    ? new Uint8Array(raw)
    : raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  try {
    return decodeSessionFrame(bytes).channelId;
  } catch {
    return null;
  }
}

export { SESSION_CHANNEL };
