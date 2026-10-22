/**
 * 本机录制执行器的私有 Unix-domain socket 服务端
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 1.4 / design D2）。
 *
 * 帧格式与既有 `model-renderer` 一致：`u32 BE 长度 + UTF-8 JSON`。这样宿主与 worker
 * 两侧都不需要额外框架，也不会把 JSON 大小猜错。
 *
 * 安全边界：
 * - 目录 0700、socket 文件 0600。Unix socket 的 `connect()` 需要对 socket 文件有写权限，
 *   因此「同用户」由内核在连接时强制，无需额外的 `SO_PEERCRED` 系统调用（Node 也不暴露它）；
 * - `registration.nonce` 写在同一个 0700 目录里，只有同一用户可读，用来证明「这是我为本次
 *   宿主启动启动的 supervisor」，而不是同用户的另一个 worktree/旧进程；
 * - `WebView` 与本 socket 无任何关系：关掉页面不会断开已注册执行器。
 *
 * 不实现任务调度与提交；收到控制消息后交给注入的 `dispatch`。
 */
import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_CONTROL_MESSAGE_BYTES,
  parseControlMessage,
  type RecordingProtocolResult
} from "@woohaa3/contracts";
import { ensureRecordingExecutorDirectory, type RecordingExecutorPaths } from "./paths.js";

/** 连接级元数据：宿主用它判断注册来源。 */
export type RecordingExecutorPeer = {
  /** 连接序号（本进程内单调），只用于日志关联。 */
  connectionId: number;
  peerPid: number;
  peerUid: number;
};

/** 一条已解析控制消息 + 来源连接。 */
export type RecordingExecutorInbound = {
  peer: RecordingExecutorPeer;
  /** 原始 JSON 文本（已通过协议校验）。 */
  json: string;
  message: Extract<RecordingProtocolResult, { ok: true }>;
};

export type RecordingExecutorServerOptions = {
  paths: RecordingExecutorPaths;
  /** 注入的消息处理；返回值会按帧写回连接。 */
  handle: (inbound: RecordingExecutorInbound) => Promise<unknown | undefined> | unknown;
  /** 非致命诊断（含连接建立/断开、协议拒绝）。 */
  logger?: (event: Record<string, unknown>) => void;
  onDisconnect?: (connectionId: number) => void;
  /** 注册 nonce；写入 nonce 文件供 supervisor 读取。 */
  registrationNonce: string;
  /**
   * 覆盖 peer 凭据解析（测试用）。默认读取连接上由 `net` 记录的远端信息；
   * 由于 Node 不暴露 uid，缺省值取当前进程用户。
   */
  resolvePeer?: (connectionId: number) => { pid: number; uid: number };
};

export type RecordingExecutorServer = {
  /** 实际监听地址。 */
  address: string;
  /** 当前连接数（不是任务数）。 */
  connectionCount(): number;
  /** 主动断开所有连接并关闭监听。 */
  close(): Promise<void>;
  /** 向某条连接写一条控制消息（例如 progress）；未知连接返回 false。 */
  send(connectionId: number, message: unknown): boolean;
};

export const RECORDING_EXECUTOR_PROTOCOL_FRAME_VERSION = 1;

function writeFrame(socket: Socket, value: unknown): boolean {
  if (!socket.writable) return false;
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.byteLength, 0);
  socket.write(Buffer.concat([header, payload]));
  return true;
}

/**
 * 启动 socket 服务端。路径已存在时先删除（只删除本宿主实例的目录内容）。
 *
 * 失败即抛出：调用方（宿主装配）据此把录制能力标记为 unavailable，而不是静默跳过。
 */
export async function startRecordingExecutorServer(
  options: RecordingExecutorServerOptions
): Promise<RecordingExecutorServer> {
  const { paths } = options;
  const log = options.logger ?? (() => undefined);
  ensureRecordingExecutorDirectory(paths);
  if (process.platform !== "win32" && existsSync(paths.socketPath)) {
    rmSync(paths.socketPath, { force: true });
  }
  writeFileSync(paths.noncePath, options.registrationNonce, { mode: 0o600 });
  if (process.platform === "win32") {
    // supervisor 不能假设自己的 TEMP 与宿主是同一字符串形式（8.3 短路径/长路径）。
    writeFileSync(join(paths.directory, "pipe.name"), paths.socketPath, "utf8");
  }

  const sockets = new Map<number, Socket>();
  let nextConnectionId = 1;
  const resolvePeer = options.resolvePeer ?? (() => ({ pid: process.pid, uid: process.getuid?.() ?? -1 }));

  const server: Server = createServer(socket => {
    const connectionId = nextConnectionId++;
    sockets.set(connectionId, socket);
    if (process.platform !== "win32") {
      try {
        chmodSync(paths.socketPath, 0o600);
      } catch {
        // 平台偶发失败不影响连接；目录已是 0700。
      }
    }
    const peerInfo = resolvePeer(connectionId);
    const peer: RecordingExecutorPeer = { connectionId, peerPid: peerInfo.pid, peerUid: peerInfo.uid };
    log({ event: "recording-executor-connected", connectionId });

    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.byteLength >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0 || length > MAX_CONTROL_MESSAGE_BYTES) {
          log({ event: "recording-executor-frame-rejected", connectionId, length });
          socket.destroy();
          buffer = Buffer.alloc(0);
          return;
        }
        if (buffer.byteLength < 4 + length) return;
        const payload = buffer.subarray(4, 4 + length).toString("utf8");
        buffer = buffer.subarray(4 + length);
        const parsed = parseControlMessage(payload);
        if (!parsed.ok) {
          log({ event: "recording-executor-protocol-rejected", connectionId, code: parsed.code });
          writeFrame(socket, {
            protocolVersion: "RECORDING_PROTOCOL_VERSION_1_ALPHA_1",
            sequence: 0,
            capabilityResponse: {
              accepted: false,
              error: { stage: "RECORDING_ERROR_STAGE_CAPABILITY", code: parsed.code, message: parsed.message }
            }
          });
          continue;
        }
        void Promise.resolve(options.handle({ peer, json: payload, message: parsed }))
          .then(reply => {
            if (reply !== undefined) writeFrame(socket, reply);
          })
          .catch(error => {
            log({
              event: "recording-executor-handler-failed",
              connectionId,
              message: error instanceof Error ? error.message : "unknown"
            });
          });
      }
    });
    socket.on("close", () => {
      sockets.delete(connectionId);
      options.onDisconnect?.(connectionId);
      log({ event: "recording-executor-disconnected", connectionId });
    });
    socket.on("error", error => {
      sockets.delete(connectionId);
      log({ event: "recording-executor-socket-error", connectionId, message: error.message });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") {
    try {
      chmodSync(paths.socketPath, 0o600);
    } catch {
      // 见上：目录权限已经足够。
    }
  }

  return {
    address: paths.socketPath,
    connectionCount: () => sockets.size,
    send(connectionId, message) {
      const socket = sockets.get(connectionId);
      return socket ? writeFrame(socket, message) : false;
    },
    async close() {
      for (const socket of sockets.values()) socket.destroy();
      sockets.clear();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (process.platform !== "win32") rmSync(paths.socketPath, { force: true });
      if (process.platform === "win32") rmSync(join(paths.directory, "pipe.name"), { force: true });
      rmSync(paths.noncePath, { force: true });
    }
  };
}
