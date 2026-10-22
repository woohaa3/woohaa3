/**
 * 执行器侧的本机控制通道客户端
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 1.4 / design D2）。
 *
 * 由桌面 supervisor 使用：读取可信启动配置里的 socket 路径与 nonce，注册执行器能力，
 * 续期 lease，并在宿主消失时**自行终止**（不依赖父进程发 kill）。
 *
 * 纯 Node 实现、不含任务调度：调度与状态机在宿主（任务 5）。
 */
import { connect, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import {
  MAX_CONTROL_MESSAGE_BYTES,
  RECORDING_PROTOCOL_VERSION,
  parseControlMessage,
  type ParsedControlMessage
} from "@woohaa3/contracts";

export type RecordingExecutorClientOptions = {
  socketPath: string;
  /** 注册 nonce 文件路径；与 socket 同目录。 */
  noncePath: string;
  capability: Record<string, unknown>;
  /** 心跳间隔；默认 lease/3。 */
  heartbeatMs?: number;
  /** 连续多少次心跳失败后自行退出；默认 2。 */
  maxMissedHeartbeats?: number;
  logger?: (event: Record<string, unknown>) => void;
  /** 收到宿主消息（progress 请求、lease 续期、取消等）。 */
  onMessage?: (message: ParsedControlMessage) => void;
  /** 宿主失联或注册被拒时调用；supervisor 在此停止 worker。 */
  onTerminate: (reason: { code: string; message: string }) => void;
  /** 注入时钟/连接（测试用）。 */
  now?: () => number;
};

export type RecordingExecutorClient = {
  /** 已完成注册（capabilityResponse.accepted）。 */
  registered: Promise<{ ok: boolean; message?: string }>;
  send(message: Record<string, unknown>): boolean;
  close(): Promise<void>;
  /** 本次连接是否仍然存活。 */
  alive(): boolean;
};

/**
 * 连接并注册一个录制执行器。
 *
 * 关键不变量：注册失败（nonce、checkout、协议版本）立即 terminate，且**不重试**——
 * 这些是配置错误，重试只会无限刷日志。
 */
export function connectRecordingExecutor(options: RecordingExecutorClientOptions): RecordingExecutorClient {
  const log = options.logger ?? (() => undefined);
  const heartbeatMs = Math.max(500, options.heartbeatMs ?? 10_000);
  const maxMissed = Math.max(1, options.maxMissedHeartbeats ?? 2);
  let socket: Socket | null = null;
  let alive = false;
  let missed = 0;
  let sequence = 0;
  let closed = false;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let resolveRegistered: (value: { ok: boolean; message?: string }) => void = () => undefined;
  const registered = new Promise<{ ok: boolean; message?: string }>(resolve => {
    resolveRegistered = resolve;
  });

  const finish = (reason: { code: string; message: string }) => {
    if (closed) return;
    closed = true;
    alive = false;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    try {
      socket?.destroy();
    } catch {
      // 已断开。
    }
    resolveRegistered({ ok: false, message: reason.message });
    options.onTerminate(reason);
  };

  let nonce: string;
  try {
    nonce = readFileSync(options.noncePath, "utf8").trim();
  } catch (error) {
    finish({
      code: "executor-unauthorized",
      message: `无法读取执行器注册凭据：${error instanceof Error ? error.message : "unknown"}`
    });
    return { registered, send: () => false, close: async () => undefined, alive: () => false };
  }

  socket = connect(options.socketPath);
  let buffer = Buffer.alloc(0);

  socket.on("connect", () => {
    alive = true;
    missed = 0;
    const requestId = `capability-${process.pid}-${Date.now()}`;
    const capabilityRequest = {
      sequence: String(++sequence),
      requestId,
      protocolVersion: RECORDING_PROTOCOL_VERSION,
      registrationNonce: nonce,
      executorInstanceId: options.capability.executorInstanceId,
      capability: options.capability
    };
    write({ protocolVersion: RECORDING_PROTOCOL_VERSION, sequence: String(sequence), capabilityRequest });
    heartbeatTimer = setInterval(() => {
      if (!alive) return;
      const sent = write({
        protocolVersion: RECORDING_PROTOCOL_VERSION,
        sequence: String(++sequence),
        leaseHeartbeat: {
          sequence: String(sequence),
          executorInstanceId: options.capability.executorInstanceId,
          leaseRemainingMs: String(heartbeatMs * (maxMissed + 1))
        }
      });
      if (!sent) {
        if (++missed >= maxMissed) {
          finish({ code: "executor-lost", message: "宿主失联，执行器自行停止" });
        }
        return;
      }
      // 心跳只证明「写成功」；真正的 lease 由宿主续期。连续未收到宿主任何消息即视为失联。
      missed += 1;
      if (missed > maxMissed) {
        finish({ code: "executor-lost", message: "宿主未续期租约，执行器自行停止" });
      }
    }, heartbeatMs);
  });

  function write(message: Record<string, unknown>): boolean {
    if (!socket || !alive || closed) return false;
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    if (payload.byteLength > MAX_CONTROL_MESSAGE_BYTES) return false;
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.byteLength, 0);
    socket.write(Buffer.concat([header, payload]));
    return true;
  }

  socket.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.byteLength >= 4) {
      const length = buffer.readUInt32BE(0);
      if (length === 0 || length > MAX_CONTROL_MESSAGE_BYTES) {
        finish({ code: "recording-malformed-message", message: "宿主控制帧长度非法" });
        return;
      }
      if (buffer.byteLength < 4 + length) return;
      const text = buffer.subarray(4, 4 + length).toString("utf8");
      buffer = buffer.subarray(4 + length);
      const parsed = parseControlMessage(text);
      if (!parsed.ok) {
        log({ event: "recording-executor-client-rejected", code: parsed.code });
        continue;
      }
      // 任何合法宿主消息都证明宿主还在；重置失联计数。
      missed = 0;
      if (parsed.payloadName === "capabilityResponse") {
        const accepted = parsed.payload.accepted === true;
        resolveRegistered({
          ok: accepted,
          message: accepted ? undefined : String((parsed.payload.error as { message?: string } | undefined)?.message ?? "注册被拒绝")
        });
        if (!accepted) {
          finish({
            code: "executor-unauthorized",
            message: String((parsed.payload.error as { message?: string } | undefined)?.message ?? "执行器注册被拒绝")
          });
          return;
        }
      }
      options.onMessage?.(parsed);
    }
  });

  socket.on("error", error => {
    finish({ code: "executor-lost", message: error.message });
  });
  socket.on("close", () => {
    if (!closed) finish({ code: "executor-lost", message: "宿主连接已关闭" });
  });

  return {
    registered,
    send: write,
    alive: () => alive && !closed,
    async close() {
      closed = true;
      alive = false;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await new Promise<void>(resolve => {
        if (!socket || socket.destroyed) return resolve();
        // `end` 的回调在已析构的 socket 上不会触发；加一次性兜底避免调用方永久等待。
        const timer = setTimeout(resolve, 1_000);
        socket.end(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
}
