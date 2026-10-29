/**
 * Canvas Session WebSocket 接线
 * （change: unify-canvas-session-websocket，任务 2.1–2.5；原 Yjs 专用 upgrade）。
 *
 * 与 HTTP handler 共用同一组合根：dev（Vite middleware）、preview 与 `scripts/serve-web.mjs`
 * 都通过这里挂载 upgrade，因此**协议实现只有一份**。
 *
 * 路径保持 `/api/canvases/:canvasId/sync`（避免 ingress/部署迁移），但它现在是一条
 * **版本化 Canvas Session**：`sessionProtocolVersion` 是必需握手参数，缺失或不受支持的
 * 客户端在交换任何文档内容/任务活动前被拒绝。
 *
 * 安全边界（spec「Canvas Session SHALL version and recover the physical connection
 * independently of channels」）：
 * - 注入认证/资源策略时：在 room acquire/bootstrap **之前**按可信 principal 判定 read，每条
 *   command 在 room 队列/持久 commit 前重查 write，广播前重查 read（change:
 *   2026-10-13-add-enterprise-access-and-production-deployment，任务 4.5/6.2/6.3）；
 * - 未注入时：复用画布 HTTP API 的历史边界（未配置服务令牌时只允许 loopback）；
 * - 校验 Origin；
 * - actorId 由服务端上下文产生（可信 principal 或受信任代理头），绝不信任消息内容；
 * - 限制连接数、frame 大小与速率，并对慢 consumer 有界终止。
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { YJS_CANVAS_FORMAT_VERSION, YJS_SYNC_PROTOCOL_VERSION, type SyncSocket } from "@woohaa3/contracts/canvas-yjs";
import { CanvasRoomRegistry } from "./room-registry.js";
import { CanvasSessionHub, connectRegistryBroadcast } from "./sync-hub.js";
import { CanvasSession, DEFAULT_CANVAS_SESSION_LIMITS } from "./canvas-session.js";
import { createCanvasActivityRelayRegistry, type CanvasActivityRelayRegistry } from "./activity-relay.js";
import type { CanvasTaskClient } from "../clients/task-client.js";
import type { YjsDocumentRepository } from "./yjs-repository.js";
import type { SyncUpstream } from "./upstream/relay-upstream.js";
import type { MediaStorage } from "@woohaa3/contracts";
import type { ServerCanvas } from "@woohaa3/contracts";
import type { PrincipalContext } from "@woohaa3/contracts";

export const DEFAULT_SYNC_BASE_PATH = "/api/canvases";
export const DEFAULT_MAX_SYNC_CONNECTIONS = 256;

/** 内部 relay 默认只读取少量页；单页上限由 Task 侧夹紧。 */
const RELAY_PAGE_SIZE = 200;

export type SyncUpgradeOptions = {
  lifecycle?: import("@woohaa3/contracts").ManagedNodeLifecycleResolver;
  repository: YjsDocumentRepository;
  mediaStorage?: MediaStorage;
  /** 与画布 API 相同的受信任代理服务令牌；未配置时只允许 loopback。 */
  serviceToken?: string;
  /** 允许的 Origin 列表；空数组表示不校验（仅本机部署）。 */
  allowedOrigins?: readonly string[];
  maxConnections?: number;
  basePath?: string;
  now?: () => string;
  logger?: (event: {
    event: string;
    status: number;
    code?: string;
    canvasId?: string;
    channel?: string;
    cursor?: number;
    latencyMs?: number;
  }) => void;
  /** 新画布 bootstrap：Yjs 文档不存在时返回其规范聚合（见 `CanvasRoomOptions.bootstrap`）。 */
  bootstrap?: (canvasId: string) => Promise<ServerCanvas | null>;
  /** room epoch 生成器（测试用确定性实现）。 */
  generateRoomEpoch?: () => string;
  /** 命令 durable 成功后的观察者（透传到 room；change: 模型编辑历史）。 */
  onCommitted?: (input: { canvasId: string; canvas: ServerCanvas; commands: readonly unknown[] }) => void;
  /** revision delta 观察者（透传到 room；change: add-agent-canvas-authoring-mcp）。 */
  onDelta?: (input: { canvasId: string; before: ServerCanvas; after: ServerCanvas }) => void;
  /**
   * Canvas → Task 增量读取（task-activity relay 用；change: unify-canvas-session-websocket）。
   * 缺省时 task-activity 通道报告可重试不可用，Yjs 通道不受影响。
   */
  taskClient?: () => CanvasTaskClient | undefined | null;
  /**
   * 写入口门禁（spec「首版 room 服务采用单应用实例」/ writer lock）。
   *
   * 在建立 Canvas Session 之前**同步**判定：宿主未持有部署级 writer lock 时拒绝连接。
   * readiness 早已反映这一点，但写路径过去从不消费它——第二个本机宿主因此能悄悄写同一份
   * 协作存储，把第一个实例 room 的内存 storageSeq 撞成永久过期（客户端卡在「请重试」）。
   */
  gate?: () => { ok: true } | { ok: false; status: number; code: string };
  /**
   * 在线迁移准入（change: 2026-10-12-add-extension-online-canvas-migration，任务 5.3）。
   *
   * 在建立 WS 之前同步判定：未准备 / 已删除的迁移目标在这里以 `PREPARATION_REQUIRED` /
   * `DELETED` 拒绝，**不**进入 CanvasRoom，也不触发 `registry.resolve` 读旧来源。
   */
  admit?: (canvasId: string) => { ok: true } | { ok: false; status: number; code: string; message: string };
  /** 远端同步上游；缺省时 room 只写本机存储。 */
  upstream?: SyncUpstream;
  /**
   * 资源授权接缝（change: 2026-10-13-...，任务 6.2/6.3）：注入后每条 WS 连接在 room acquire
   * **之前**按可信 principal 判定 read；未注入时保持历史服务令牌/loopback 行为。
   */
  accessRuntime?: import("@woohaa3/contracts").AccessRuntime;
  canvasExists?: (canvasId: string) => Promise<boolean>;
  authenticate?: import("../access/resolve-access.js").CanvasRequestAuthenticator;
  access?: import("../access/access-port.js").CanvasAccessPort;
  /**
   * 每条命令在 **room 队列/持久 commit 之前**的 write 复核（任务 4.5/6.2/6.3）：
   * 由**冻结的**可信 principal 派生（含有效期），撤权后立即拒绝且不形成新 revision/不广播。
   */
  authorizeCommand?: (input: { canvasId: string; principal: PrincipalContext }) => Promise<boolean>;
  /**
   * 每次广播（同步 update / 活动记录）前的 read 复核（任务 6.3）：撤 read 后停止后续广播并关闭
   * 会话；基础 policy 故障同样停止受保护广播。返回 false 表示不允许广播。
   */
  authorizeRead?: (input: { canvasId: string; principal: PrincipalContext }) => Promise<boolean>;
};

export type SyncUpgradeHandler = {
  /** 是否为同步 upgrade 路径。 */
  matches: (url: string | undefined) => boolean;
  /** 处理 HTTP upgrade；返回 true 表示已接管。 */
  handle: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  registry: CanvasRoomRegistry;
  hub: CanvasSessionHub;
  /** 每 canvas 一个的 task-activity relay（测试/指标用）。 */
  relay: CanvasActivityRelayRegistry;
  close: () => Promise<void>;
  /** 当前连接数（测试/指标用）。 */
  connectionCount: () => number;
};

/** 从 `/api/canvases/:canvasId/sync` 解析 canvasId；不匹配返回 null。 */
export function parseSyncPath(url: string | undefined, basePath = DEFAULT_SYNC_BASE_PATH): string | null {
  if (!url) return null;
  let pathname: string;
  try {
    pathname = new URL(url, "http://localhost").pathname;
  } catch {
    return null;
  }
  const prefix = `${basePath.replace(/\/$/, "")}/`;
  if (!pathname.startsWith(prefix) || !pathname.endsWith("/sync")) return null;
  const middle = pathname.slice(prefix.length, pathname.length - "/sync".length);
  if (middle.length === 0 || middle.includes("/")) return null;
  try {
    return decodeURIComponent(middle);
  } catch {
    return null;
  }
}

export function createSyncUpgradeHandler(options: SyncUpgradeOptions): SyncUpgradeHandler {
  const basePath = options.basePath ?? DEFAULT_SYNC_BASE_PATH;
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_SYNC_CONNECTIONS;
  const allowedOrigins = options.allowedOrigins ?? [];
  const log = options.logger ?? (() => undefined);
  const now = options.now ?? (() => new Date().toISOString());

  const hub = new CanvasSessionHub();
  const toHub = connectRegistryBroadcast(hub);
  const upstream = options.upstream;
  const registry = new CanvasRoomRegistry({
    repository: options.repository,
    lifecycle: options.lifecycle,
    mediaStorage: options.mediaStorage,
    now,
    broadcast: upstream
      ? (input) => {
          toHub(input);
          upstream.publish(input);
        }
      : toHub,
    ...(upstream
      ? {
          // 只有真的被客户端打开过才挂上游（内部对账/历史加载不算），见 onClientAcquired 的说明。
          onClientAcquired: (room) => upstream.attach(room),
          seedFromUpstream: (canvasId: string) => upstream.fetchSnapshot(canvasId)
        }
      : {}),
    ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
    ...(options.generateRoomEpoch ? { generateRoomEpoch: options.generateRoomEpoch } : {}),
    ...(options.onCommitted ? { onCommitted: options.onCommitted } : {}),
    ...(options.onDelta ? { onDelta: options.onDelta } : {}),
    // 冲突自动恢复只记诊断；恢复本身在 room 内完成，不依赖日志成功。
    onStorageSeqRecovered: (input) =>
      log({ event: "storage-seq-recovered", status: input.recovered ? 200 : 500, canvasId: input.canvasId })
  });

  const resolveTaskClient = options.taskClient ?? (() => undefined);
  // 每个有订阅者的 canvas 一个 relay（registry 内部 ref-count）。
  const relay = createCanvasActivityRelayRegistry({
    readChanges: async (canvasId, after) => {
      const client = resolveTaskClient();
      if (!client) throw new Error("task-client-unavailable");
      return client.canvasActivityChanges(canvasId, after, RELAY_PAGE_SIZE);
    },
    onRecord: (canvasId, record, cursor) => hub.publishActivity({ canvasId, record, cursor }),
    logger: (event) => log({ event: event.event, status: 200, ...(event.code ? { code: event.code } : {}), canvasId: event.canvasId })
  });

  // `ws` 需要显式 `noServer`：upgrade 由我们自己的 HTTP server 处理。
  const wss = new WebSocketServer({ noServer: true });
  let connections = 0;

  /**
   * 接受一条已通过访问边界与（可选）资源授权的连接：进入 room、装配 CanvasSession。
   * principal 由调用方提供（可信认证结果或历史解析的 synthetic principal），绝不读客户端消息内容。
   */
  const acceptConnection = (req: IncomingMessage, socket: Duplex, head: Buffer, canvasId: string, sessionProtocolVersion: number, principal?: PrincipalContext): void => {
    connections += 1;
    wss.handleUpgrade(req, socket, head, (ws) => {
      let lease: Awaited<ReturnType<typeof registry.acquire>> | null = null;
      let unregister: (() => void) | null = null;
      let unsubscribeActivity: (() => void) | null = null;
      let session: CanvasSession | null = null;
      // 身份有效期到期定时器（任务 2.6）；连接关闭时清除。
      let expiryTimer: ReturnType<typeof setTimeout> | null = null;
      void (async () => {
        try {
          lease = await registry.acquire(canvasId);
          session = new CanvasSession({
            room: lease.room,
            socket: toSyncSocket(ws),
            clientSessionProtocolVersion: sessionProtocolVersion,
            // 内层 Yjs 协议版本；客户端声明（握手参数，不是消息体）。
            clientProtocolVersion: readIntQuery(req, "protocolVersion") ?? YJS_SYNC_PROTOCOL_VERSION,
            clientFormatVersion: readStringQuery(req, "formatVersion") ?? YJS_CANVAS_FORMAT_VERSION,
            clientRoomEpoch: readStringQuery(req, "roomEpoch"),
            clientStateVector: new Uint8Array(0),
            actorId: principal?.subject ?? resolveActorId(req),
            onCommandComplete: ({ status, latencyMs }) => log({
              event: status === "accepted" ? "command-accepted" : status === "duplicate" ? "command-duplicate" : "command-rejected",
              status: status === "accepted" || status === "duplicate" ? 200 : 400,
              canvasId, latencyMs
            }),
            limits: { ...DEFAULT_CANVAS_SESSION_LIMITS },
            // 每条命令在 room 队列/持久 commit 前 write 复核（任务 4.5/6.2/6.3）；未注入时不传。
            ...(principal && options.authorizeCommand ? { authorizeCommand: () => options.authorizeCommand!({ canvasId, principal }) } : {}),
            // 每次广播的 read 复核（任务 6.3）；撤 read 后停止发送。未注入时不传。
            ...(principal && options.authorizeRead ? { authorizeRead: () => options.authorizeRead!({ canvasId, principal }) } : {}),
            onActivitySubscribe: (after) => {
              // 每次 subscribe 都替换订阅：先退订旧的，再以新 cursor 登记（至多一个）。
              unsubscribeActivity?.();
              if (!session) return;
              unsubscribeActivity = relay.subscribe(canvasId, after);
              session.sendActivityReady(after);
              log({ event: "channel-message", status: 200, canvasId, channel: "task-activity", cursor: after });
            },
            onSessionDispose: () => {
              unsubscribeActivity?.();
              unsubscribeActivity = null;
            }
          });
          unregister = hub.register(canvasId, session);
          log({ event: "session-connected", status: 101, canvasId });
          // 身份到期主动断连（任务 2.6）：不等到下一条命令/广播才拒绝；到期即关闭连接。
          if (principal?.validUntil !== undefined && Number.isFinite(principal.validUntil)) {
            const delay = principal.validUntil - Date.now();
            if (delay <= 0) {
              log({ event: "session-expired", status: 4401, canvasId });
              session.close(4401, "session-expired");
            } else {
              expiryTimer = setTimeout(() => {
                log({ event: "session-expired", status: 4401, canvasId });
                session?.close(4401, "session-expired");
              }, delay);
              expiryTimer.unref?.();
            }
          }
          ws.on("close", () => {
            if (expiryTimer) {
              clearTimeout(expiryTimer);
              expiryTimer = null;
            }
            unsubscribeActivity?.();
            unsubscribeActivity = null;
            unregister?.();
            lease?.release();
            connections = Math.max(0, connections - 1);
            log({ event: "session-disconnected", status: 100, canvasId });
          });
        } catch (error) {
          log({ event: "session-attach-failed", status: 500, canvasId });
          ws.close(1011, "attach-failed");
          lease?.release();
          connections = Math.max(0, connections - 1);
          void error;
        }
      })();
    });
  };

  const handler: SyncUpgradeHandler = {
    registry,
    hub,
    relay,
    matches: (url) => parseSyncPath(url, basePath) !== null,
    connectionCount: () => connections,
    handle: (req, socket, head) => {
      const canvasId = parseSyncPath(req.url, basePath);
      if (!canvasId) return false;

      // --- Canvas Session 版本闸门（业务数据之前）---
      const sessionProtocolVersion = readIntQuery(req, "sessionProtocolVersion");
      if (sessionProtocolVersion === null) {
        // 旧 Yjs-only 客户端：没有外层版本声明，直接拒绝并提示刷新。
        log({ event: "session-version-missing", status: 426, canvasId });
        rejectUpgrade(socket, 426, "Upgrade Required");
        return true;
      }

      // --- 单实例门禁（writer lock；不进入 registry，不读文档）---
      if (options.gate) {
        const gated = options.gate();
        if (!gated.ok) {
          log({ event: "sync-not-ready", status: gated.status, code: gated.code, canvasId });
          rejectUpgrade(socket, gated.status, gated.code);
          return true;
        }
      }

      // --- 访问边界（与 HTTP 画布 API 语义一致）---
      // 注入资源授权（`accessRuntime` 已装配）时由下面的 principal 判定接管；否则保持历史边界。
      if (options.accessRuntime === undefined && !options.serviceToken && !isLoopback(req)) {
        log({ event: "sync-non-loopback-rejected", status: 403, canvasId });
        rejectUpgrade(socket, 403, "Forbidden");
        return true;
      }
      if (options.serviceToken && !hasValidToken(req, options.serviceToken)) {
        log({ event: "sync-token-rejected", status: 401, canvasId });
        rejectUpgrade(socket, 401, "Unauthorized");
        return true;
      }
      if (allowedOrigins.length > 0 && !isAllowedOrigin(req, allowedOrigins)) {
        log({ event: "sync-origin-rejected", status: 403, canvasId });
        rejectUpgrade(socket, 403, "Forbidden");
        return true;
      }
      if (connections >= maxConnections) {
        log({ event: "sync-connection-limited", status: 503, canvasId });
        rejectUpgrade(socket, 503, "Too Many Connections");
        return true;
      }

      // --- 在线迁移准入（不进入 CanvasRoom；不触发 registry.resolve）---
      if (options.admit) {
        const admitted = options.admit(canvasId);
        if (!admitted.ok) {
          log({ event: "sync-migration-blocked", status: admitted.status, code: admitted.code, canvasId });
          rejectUpgrade(socket, admitted.status, admitted.code);
          return true;
        }
      }

      // 资源授权（任务 6.2）：注入认证+策略时在 room acquire 之前判定 read；未注入时保持历史行为。
      if (options.authenticate && options.access) {
        void (async () => {
          let principal: PrincipalContext | null;
          try {
            principal = await options.authenticate!(req, "ws");
          } catch {
            log({ event: "sync-auth-unavailable", status: 503, canvasId });
            rejectUpgrade(socket, 503, "Authorization Unavailable");
            return;
          }
          if (!principal) {
            log({ event: "sync-unauthorized", status: 401, canvasId });
            rejectUpgrade(socket, 401, "Unauthorized");
            return;
          }
          let decision;
          try { decision = await options.access!.authorize({ principal, canvasId, permission: "read" }); }
          catch { rejectUpgrade(socket, 503, "Authorization Unavailable"); return; }
          if (!decision.allowed) {
            const status = decision.code === "unauthenticated" ? 401 : decision.code === "provider-unavailable" ? 503 : decision.code === "not-found" ? 404 : 403;
            log({ event: "sync-forbidden", status, canvasId });
            rejectUpgrade(socket, status, "Forbidden");
            return;
          }
          acceptConnection(req, socket, head, canvasId, sessionProtocolVersion, principal);
        })();
        return true;
      }
      if (options.canvasExists) {
        void (async () => {
          try {
            if (!await options.canvasExists!(canvasId)) {
              log({ event: "sync-canvas-missing", status: 404, canvasId });
              rejectUpgrade(socket, 404, "Canvas Not Found");
              return;
            }
            acceptConnection(req, socket, head, canvasId, sessionProtocolVersion);
          } catch { rejectUpgrade(socket, 503, "Storage Unavailable"); }
        })();
      } else acceptConnection(req, socket, head, canvasId, sessionProtocolVersion);
      return true;
    },
    close: async () => {
      relay.stopAll();
      hub.closeAll();
      await registry.destroyAll();
      upstream?.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  };

  return handler;
}

/** 把 `ws` 的 socket 适配成传输无关的 `SyncSocket`。 */
export function toSyncSocket(ws: WebSocket): SyncSocket {
  return {
    send(data) {
      ws.send(data);
    },
    close(code, reason) {
      ws.close(code, reason);
    },
    bufferedAmount() {
      return ws.bufferedAmount;
    },
    onMessage(handler) {
      const listener = (data: unknown) => {
        // `ws` 默认给 Buffer（或字符串）；统一成 Uint8Array 供协议层使用。
        if (data instanceof Uint8Array) {
          handler(new Uint8Array(data));
        } else if (Buffer.isBuffer(data)) {
          handler(new Uint8Array(data));
        } else if (typeof data === "string") {
          handler(new TextEncoder().encode(data));
        } else if (data instanceof ArrayBuffer) {
          handler(new Uint8Array(data));
        }
      };
      ws.on("message", listener as never);
      return () => ws.off("message", listener as never);
    },
    onClose(handler) {
      ws.on("close", handler);
      return () => ws.off("close", handler);
    }
  };
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  return address === "::1"
    || address === "127.0.0.1"
    || address.startsWith("127.")
    || address.startsWith("::ffff:127.");
}

function hasValidToken(req: IncomingMessage, expected: string): boolean {
  const header = req.headers["x-woohaa3-service-token"];
  const value = Array.isArray(header) ? header[0] : header;
  return value === expected;
}

function isAllowedOrigin(req: IncomingMessage, allowed: readonly string[]): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return false;
  return allowed.includes(origin);
}

/** actorId 由服务端上下文产生；绝不接受客户端消息里的自报值。 */
function resolveActorId(req: IncomingMessage): string {
  const header = req.headers["x-woohaa3-actor"];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 128) : "local";
}

function readStringQuery(req: IncomingMessage, key: string): string | null {
  try {
    const value = new URL(req.url ?? "/", "http://localhost").searchParams.get(key);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function readIntQuery(req: IncomingMessage, key: string): number | null {
  const raw = readStringQuery(req, key);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : null;
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  // 必须在写任何字节前决定：upgrade 被拒绝时按 HTTP 响应结束。
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
