/**
 * Canvas Session wire 契约（change: unify-canvas-session-websocket，任务 1.1 / 1.2 / design D1、D3）。
 *
 * 物理连接 `/api/canvases/:canvasId/sync` 不再由 Yjs 独占，而是一条**版本化的 Canvas
 * Session**：所有 canvas-scoped 实时消息走同一个可判别 channel envelope。
 *
 * ```text
 * varUint channelId
 * varUint8Array channelPayload
 *
 * channel 0  session-control
 * channel 1  canvas-yjs     （payload 就是既有 Yjs 协议帧，原样嵌套）
 * channel 2  task-activity  （payload 是对应方向的消息 JSON）
 * ```
 *
 * 本模块只有**无副作用 codec**：版本常量、稳定 channel ID、方向约束、大小限制与
 * 严格解码。它不绑定 socket、room 或 React，因此服务端与浏览器共用同一份判定。
 *
 * 关键约束：
 * - envelope 解码在**进入任何业务 handler 之前**拒绝未知 channel / 畸形 frame / 尾随
 *   bytes / 超限 payload（spec「Canvas Session WebSocket SHALL multiplex canvas-scoped
 *   channels」）；
 * - 每个 channel 的 payload codec 独立演进，`session-control` 不承载 Yjs 或任务记录；
 * - 方向规则是 wire 契约：客户端不得发送服务端方向的 channel，反之亦然。
 */
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { isCanvasTaskActivity } from "../task/activity.js";
import type { CanvasTaskActivity } from "../task/activity.js";
import { isBoundedId, isJsonObject, isNonNegativeInteger } from "../validation.js";

/** 供消费方（channel codec 之外的 DTO 类型）复用。 */
export type { CanvasTaskActivity };

/**
 * Canvas Session 物理 wire 版本。
 *
 * 与 `YJS_SYNC_PROTOCOL_VERSION`（内层 Yjs 协议）**各自独立演进**：外层 envelope 的每次
 * 不兼容变化都提升它；服务端在交换任何业务消息前校验，不兼容直接拒绝并关闭。
 */
export const CANVAS_SESSION_PROTOCOL_VERSION = 1 as const;
export type CanvasSessionProtocolVersion = typeof CANVAS_SESSION_PROTOCOL_VERSION;

/** 稳定 channel ID（数值；改动即破坏兼容）。 */
export const SESSION_CHANNEL = {
  /** 会话控制：ready/error/closing（不承载 Yjs 或任务记录）。 */
  CONTROL: 0,
  /** Yjs 同步：payload 是一条既有 Yjs 协议帧。 */
  CANVAS_YJS: 1,
  /** 画布任务活动：payload 是方向相关的 JSON 消息。 */
  TASK_ACTIVITY: 2
} as const;

export type SessionChannelId = (typeof SESSION_CHANNEL)[keyof typeof SESSION_CHANNEL];

export const SESSION_CHANNEL_NAMES: Record<SessionChannelId, string> = {
  [SESSION_CHANNEL.CONTROL]: "session-control",
  [SESSION_CHANNEL.CANVAS_YJS]: "canvas-yjs",
  [SESSION_CHANNEL.TASK_ACTIVITY]: "task-activity"
};

export function isSessionChannelId(value: unknown): value is SessionChannelId {
  return typeof value === "number" && SESSION_CHANNEL_NAMES[value as SessionChannelId] !== undefined;
}

/** channel 方向（wire 契约；越界方向在业务处理前被拒绝）。 */
export type SessionChannelDirection = "client-to-server" | "server-to-client";

export const SESSION_CHANNEL_DIRECTIONS: Record<SessionChannelId, readonly SessionChannelDirection[]> = {
  // 控制消息双向：服务端发 ready/error/closing，客户端不主动发（保留扩展位）。
  [SESSION_CHANNEL.CONTROL]: ["server-to-client"],
  [SESSION_CHANNEL.CANVAS_YJS]: ["client-to-server", "server-to-client"],
  [SESSION_CHANNEL.TASK_ACTIVITY]: ["client-to-server", "server-to-client"]
};

export function allowsSessionChannelDirection(
  channelId: SessionChannelId,
  direction: SessionChannelDirection
): boolean {
  return SESSION_CHANNEL_DIRECTIONS[channelId].includes(direction);
}

/**
 * 会话大小限制（服务端与浏览器共用的**下界**；具体传输可再收紧）。
 *
 * - 默认上限用于客户端请求；完整 Yjs 文档可能大于单次命令，浏览器接收时使用服务端上限；
 * - frame 在整个 envelope 解码前校验，payload 在交给 channel codec 前校验。
 * - 完整 Yjs 初始快照是单条 frame，随画布增长可轻易超过 1 MiB；服务端上限因此显著大于默认，
 *   浏览器接收侧使用服务端上限，避免较大合法画布握手被拒（表现为画布静止不可动）。
 */
export const SESSION_LIMITS = {
  /** 客户端单条物理 frame（含 channel 头）上限。 */
  maxFrameBytes: 1024 * 1024,
  /** 客户端单 channel payload 上限。 */
  maxChannelPayloadBytes: 1024 * 1024,
  /** 服务端完整文档 frame 上限：8 MiB payload 加 envelope 头部空间。 */
  maxServerFrameBytes: 8 * 1024 * 1024 + 8,
  /** 与服务端默认发送队列容量一致，容纳完整 Yjs 文档与增量。 */
  maxServerChannelPayloadBytes: 8 * 1024 * 1024,
  /** `task-activity` payload 上限（record + 元数据，远小于 Yjs frame）。 */
  maxTaskActivityPayloadBytes: 256 * 1024
} as const;

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export type SessionProtocolErrorCode =
  | "malformed-frame"
  | "unknown-channel"
  | "trailing-bytes"
  | "payload-too-large"
  | "invalid-direction"
  | "invalid-json"
  | "malformed-message";

export class SessionProtocolError extends Error {
  readonly code: SessionProtocolErrorCode;

  constructor(code: SessionProtocolErrorCode, message: string) {
    super(message);
    this.name = "SessionProtocolError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Envelope codec（纯函数）
// ---------------------------------------------------------------------------

export type DecodedSessionFrame = {
  channelId: SessionChannelId;
  payload: Uint8Array;
};

/** 编码一条 session envelope frame。 */
export function encodeSessionFrame(channelId: SessionChannelId, payload: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, channelId);
  encoding.writeVarUint8Array(encoder, payload);
  return encoding.toUint8Array(encoder);
}

/**
 * 解码一条 session envelope frame。
 *
 * 未知 channel、畸形输入、尾随 bytes 与超限 payload 都抛 `SessionProtocolError`，**不返回
 * null** —— 静默丢弃会让协议违规看起来像网络抖动（与既有 Yjs codec 同策略）。
 */
export function decodeSessionFrame(
  data: Uint8Array,
  limits: { maxFrameBytes?: number; maxChannelPayloadBytes?: number } = {}
): DecodedSessionFrame {
  const maxFrameBytes = limits.maxFrameBytes ?? SESSION_LIMITS.maxFrameBytes;
  const maxChannelPayloadBytes = limits.maxChannelPayloadBytes ?? SESSION_LIMITS.maxChannelPayloadBytes;
  if (data.byteLength > maxFrameBytes) {
    throw new SessionProtocolError("payload-too-large", `frame 超过上限（${data.byteLength} > ${maxFrameBytes}）`);
  }

  const decoder = decoding.createDecoder(data);
  let channelId: number;
  try {
    channelId = decoding.readVarUint(decoder);
  } catch {
    throw new SessionProtocolError("malformed-frame", "缺少 channel id");
  }
  if (!isSessionChannelId(channelId)) {
    throw new SessionProtocolError("unknown-channel", `未知 channel：${channelId}`);
  }

  let payload: Uint8Array;
  try {
    payload = decoding.readVarUint8Array(decoder);
  } catch {
    throw new SessionProtocolError("malformed-frame", "缺少 channel payload");
  }
  if (decoding.hasContent(decoder)) {
    throw new SessionProtocolError("trailing-bytes", "envelope 后有多余字节");
  }
  if (payload.byteLength > maxChannelPayloadBytes) {
    throw new SessionProtocolError("payload-too-large", `channel payload 超过上限（${payload.byteLength}）`);
  }
  return { channelId, payload };
}

/** 判定一条入站 frame 的 channel 是否允许该方向；不允许时抛稳定错误。 */
export function assertSessionChannelDirection(
  channelId: SessionChannelId,
  direction: SessionChannelDirection
): void {
  if (!allowsSessionChannelDirection(channelId, direction)) {
    throw new SessionProtocolError(
      "invalid-direction",
      `${SESSION_CHANNEL_NAMES[channelId]} 不允许方向 ${direction}`
    );
  }
}

// ---------------------------------------------------------------------------
// session-control payload（channel 0）
// ---------------------------------------------------------------------------

export type SessionControlMessage =
  | { type: "ready" }
  /** 通道级依赖错误（例如 task activity 下游不可用）；不表示 session framing 损坏。 */
  | { type: "error"; code: string; message?: string; retryable?: boolean }
  | { type: "closing"; reason?: string };

export function encodeSessionControlMessage(message: SessionControlMessage): Uint8Array {
  return encodeSessionJson(message);
}

/** 严格解码 session-control payload；未知 type/字段形态非法即抛错。 */
export function decodeSessionControlMessage(payload: Uint8Array): SessionControlMessage {
  const value = decodeSessionJson(payload);
  if (!isJsonObject(value)) throw new SessionProtocolError("malformed-message", "session-control 必须是对象");
  if (value.type === "ready") return { type: "ready" };
  if (value.type === "closing") {
    const reason = typeof value.reason === "string" ? value.reason : undefined;
    return { type: "closing", ...(reason !== undefined ? { reason } : {}) };
  }
  if (value.type === "error") {
    if (!isBoundedId(value.code)) throw new SessionProtocolError("malformed-message", "error 缺少 code");
    const message = typeof value.message === "string" ? value.message : undefined;
    const retryable = value.retryable === true ? true : undefined;
    return {
      type: "error",
      code: value.code,
      ...(message !== undefined ? { message } : {}),
      ...(retryable !== undefined ? { retryable } : {})
    };
  }
  throw new SessionProtocolError("malformed-message", `未知 session-control 类型：${String(value.type)}`);
}

// ---------------------------------------------------------------------------
// task-activity payload（channel 2）
// ---------------------------------------------------------------------------

/**
 * 客户端 → 服务端：按持久化 cursor 订阅/替换订阅。
 *
 * 只携带 `after`（单调非负整数）；**不允许**携带 canvasId —— 订阅绑定在已认证的
 * WebSocket 路径上，防止消息切换 room（design D3）。
 */
export type TaskActivitySubscribe = { type: "subscribe"; after: number };

/** 服务端 → 客户端：订阅就绪（当前高水位）、可幂等合并的持久化记录、或可重试错误。 */
export type TaskActivityReady = { type: "ready"; cursor: number };
export type TaskActivityRecord = { type: "record"; cursor: number; record: CanvasTaskActivity };
export type TaskActivityError = { type: "error"; code: string; retryable: boolean };

export type TaskActivityClientMessage = TaskActivitySubscribe;
export type TaskActivityServerMessage = TaskActivityReady | TaskActivityRecord | TaskActivityError;

function checkTaskActivitySize(payload: Uint8Array): void {
  if (payload.byteLength > SESSION_LIMITS.maxTaskActivityPayloadBytes) {
    throw new SessionProtocolError("payload-too-large", "task-activity payload 超过上限");
  }
}

export function encodeTaskActivitySubscribe(message: TaskActivitySubscribe): Uint8Array {
  return encodeSessionJson(message);
}

export function encodeTaskActivityReady(message: TaskActivityReady): Uint8Array {
  return encodeSessionJson(message);
}

export function encodeTaskActivityRecord(message: TaskActivityRecord): Uint8Array {
  return encodeSessionJson(message);
}

export function encodeTaskActivityError(message: TaskActivityError): Uint8Array {
  return encodeSessionJson(message);
}

/** 严格解码客户端订阅消息；非法 cursor/未知 type/超限 payload 都抛错。 */
export function decodeTaskActivityClientMessage(payload: Uint8Array): TaskActivityClientMessage {
  checkTaskActivitySize(payload);
  const value = decodeSessionJson(payload);
  if (!isJsonObject(value) || value.type !== "subscribe") {
    throw new SessionProtocolError("malformed-message", "未知 task-activity 客户端消息");
  }
  if (!isNonNegativeInteger(value.after)) {
    throw new SessionProtocolError("malformed-message", "subscribe.after 必须是非负整数");
  }
  // 拒绝任何额外身份字段，防止调用方试图切换 canvas。
  if (value.canvasId !== undefined) {
    throw new SessionProtocolError("malformed-message", "subscribe 不得携带 canvasId");
  }
  return { type: "subscribe", after: value.after };
}

/** 严格解码服务端消息；record 必须是安全活动投影。 */
export function decodeTaskActivityServerMessage(payload: Uint8Array): TaskActivityServerMessage {
  checkTaskActivitySize(payload);
  const value = decodeSessionJson(payload);
  if (!isJsonObject(value)) throw new SessionProtocolError("malformed-message", "task-activity 消息必须是对象");
  if (value.type === "ready") {
    if (!isNonNegativeInteger(value.cursor)) throw new SessionProtocolError("malformed-message", "ready.cursor 非法");
    return { type: "ready", cursor: value.cursor };
  }
  if (value.type === "record") {
    if (!isNonNegativeInteger(value.cursor)) throw new SessionProtocolError("malformed-message", "record.cursor 非法");
    if (!isCanvasTaskActivity(value.record)) {
      throw new SessionProtocolError("malformed-message", "record 不是安全活动项");
    }
    return { type: "record", cursor: value.cursor, record: value.record };
  }
  if (value.type === "error") {
    if (!isBoundedId(value.code)) throw new SessionProtocolError("malformed-message", "error 缺少 code");
    return { type: "error", code: value.code, retryable: value.retryable === true };
  }
  throw new SessionProtocolError("malformed-message", `未知 task-activity 服务端消息：${String(value.type)}`);
}

// ---------------------------------------------------------------------------
// 共享 JSON 辅助
// ---------------------------------------------------------------------------

function encodeSessionJson(payload: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

function decodeSessionJson(payload: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    throw new SessionProtocolError("malformed-message", "payload 不是合法 UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SessionProtocolError("invalid-json", "payload 不是合法 JSON");
  }
}
