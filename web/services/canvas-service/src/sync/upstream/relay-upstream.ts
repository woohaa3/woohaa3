/**
 * 远端同步上游：本地 sidecar 作为远端 Yjs 中继（`woohaa.canvas.v1` 会话协议）的客户端。
 *
 * 浏览器始终只连本地 room；room 是否同时与远端同步由本模块决定：
 * - 未配置上游：纯本地，room 只写本机存储（默认）。
 * - 配置上游：每个已加载 room 一条到中继的 WebSocket。本机命令 durable 后把 update 推给中继；
 *   中继下发的其它写入者 update 经 `room.applyExternalUpdate` 校验、持久化后再广播给浏览器。
 * - 上游**按画布解析**：接入远端（登录）不等于每张画布都上传；扩展只对「已在远端」或
 *   「用户显式启用了同步」的画布返回链路参数。未被启用的本地画布保持纯本地。
 * - `refresh` 在运行中重新解析所有已加载 room 的上游（会话变化、某张画布刚被启用、
 *   静态配置热重载都走这里），按每个 room 的最新结果建立或断开连接。
 *
 * 中继只存取不透明字节，每个写入者在各自 room 里校验命令，跨机并发由 Yjs 合并。
 *
 * mirror 文档只含中继已确认的内容（收到的 StoredUpdate 与已 ack 的本机 update）。
 * 每次 Synced 后用它与 room 双向求差：中继多出的合入 room，room 多出的（离线期间的命令、
 * 未 ack 的发送）补推给中继，因此重连不需要单独的重发队列。
 */
import * as Y from "yjs";
import { WebSocket } from "ws";
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import {
  ClientFrameSchema,
  ServerFrameSchema,
  SessionProtocolVersion,
  type ServerFrame
} from "../../../../../../api/gen/es/woohaa/canvas/v1/session_pb.js";
import type { ExternalUpdateResult, RoomBroadcast } from "../room-types.js";
import { defaultUpstreamClientInfo, upstreamUserAgent, type UpstreamClientInfo } from "./client-info.js";

export type SyncUpstreamConfig = {
  /** 中继的 ws(s) 基址，例如 `ws://127.0.0.1:8790`；会话路径为 `/ws/canvases/{canvasId}`。 */
  url: string;
  token?: string;
};

/**
 * 扩展提供的上游凭据来源。
 *
 * 远端接入只有这一条路径：由「服务端接入」类扩展在登录后提供动态会话。
 * 静态 `canvas.syncUpstream.*` 配置已移除——它会让「逐画布显式启用」失效（全局地址会
 * 接管所有本地画布），与插件模型冲突。
 *
 * **按画布解析**是刻意的：登录远端只代表「远端可用」，不等于「每张本地画布都上传」。
 * 提供者对没有显式启用同步的本地画布必须返回 `null`。令牌只在本机宿主进程内流动，
 * 不经过浏览器（边界 B1/B3）。
 */
export type SyncUpstreamCredentialSource = {
  /** 为这一张画布解析当前上游；`null` 表示不接管。 */
  resolve: (canvasId: string) => Promise<{ url: string; token: string } | null>;
  /** 面向运维的状态短语（不含令牌）。 */
  describe?: () => string;
};

/**
 * 解析这一张画布的上游：只有扩展提供的动态来源，没有静态配置回落。
 *
 * 没有可用来源（未登录 / 未显式启用 / 扩展故障）时返回 `null`，这张画布保持纯本地。
 */
export async function resolveUpstreamConfig(
  dynamic: SyncUpstreamCredentialSource | null | undefined,
  canvasId: string
): Promise<SyncUpstreamConfig | null> {
  if (!dynamic) return null;
  try {
    const resolved = await dynamic.resolve(canvasId);
    if (resolved !== null && resolved.url !== "" && resolved.token !== "") {
      return { url: resolved.url, token: resolved.token };
    }
  } catch {
    // 扩展故障只让这张画布保持本地；不因远端不可用让画布失去同步能力。
  }
  return null;
}

/** 上游只需要 room 的这几项能力。 */
export type UpstreamRoom = {
  readonly canvasId: string;
  /**
   * 当前画布标题（published 文档的 `meta.title`，没有时为空串）。
   *
   * 只用于 Hello.title 声明显示名：服务端从不解析 Yjs，管理端要展示可读名称只能
   * 靠客户端在会话里带上；它不参与同步与授权。
   */
  title(): string;
  encodeStateVector(): Uint8Array;
  encodeDiff(stateVector: Uint8Array): Uint8Array;
  applyExternalUpdate(update: Uint8Array): Promise<ExternalUpdateResult>;
};

export type SyncUpstreamPhase = "connecting" | "syncing" | "synced" | "offline" | "failed";

export type SyncUpstreamLinkState = {
  phase: SyncUpstreamPhase;
  canWrite: boolean;
  cursor: bigint;
  error: string | null;
};

export type SyncUpstreamEvent = {
  event: string;
  canvasId: string;
  code?: string;
  message?: string;
};

/**
 * 「这张画布归属远端存储」的持久记录（宿主注入）。
 *
 * 归属是**字节被写进哪个后端**的事实，不是"此刻连没连上"。只放内存时，宿主重启后到
 * room attach 之前（启动期终态对账、画布页还没打开、room 被空闲回收）没有答案，存储层
 * 会把服务端托管存储里确实存在的对象报成不存在——远端任务因此被固化成失败终态。
 *
 * 三条口径：
 * - `initial()` 必须**同步**给答案：第一次存储路由之前就要读到，不能等一次异步加载。
 * - `remember()` 在解析到远端配置时调用；解析为 null 不调用 `forget()`——登出、断线、
 *   未加载都不改变归属，字节不会因为"这次没连上"搬回本地。
 * - 实现自己负责容错：读失败当空、写失败只记日志。记忆丢失退化成旧行为，不能让画布失败。
 */
export type SyncCanvasOwnershipStore = {
  initial(): readonly string[];
  remember(canvasId: string): void;
  forget(canvasId: string): void;
};

export type SyncUpstreamOptions = {
  WebSocketImpl?: new (url: string) => WebSocketLike;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /**
   * 一条链路活到这个时长才算"健康"：只有健康链路的断开才把重连退避归零。
   *
   * 不能按 `synced` 归零：服务端先发 Synced、再读入站帧，容量型失败会在 `synced`
   * 之后才发生，按 `synced` 归零会让退避永远回到基线——2026-10-21 现场因此以
   * 81 次/分钟重连了 13 分钟，一次也没把数据推上去。
   */
  healthyLinkMs?: number;
  /** `fetchSnapshot` 等待 Synced 的上限（毫秒）。 */
  snapshotTimeoutMs?: number;
  logger?: (event: SyncUpstreamEvent) => void;
  /**
   * 某张画布**刚建立**上游链路时回调一次（宿主用它把媒体补传到远端存储）。
   *
   * 与 refresh() 后的批量回调互补：画布是在被打开时才 attach 的，只在 refresh 回调会漏掉
   * 「启动后才打开的画布」。只承诺链路已建立，不保证文档已经 seed 完。
   */
  onLinked?: (canvasId: string) => void;
  /**
   * 会话里自报的客户端元数据（观测用，见 client-info.ts）。省略时取本包版本与当前平台。
   *
   * 它**不参与**连接判定：只影响服务端管理端调试通道看到的"谁、什么版本"，以及握手 UA。
   */
  clientInfo?: UpstreamClientInfo;
  /**
   * 归属的持久记录（宿主注入；省略时只在进程内记，重启即丢）。
   *
   * 省略是兼容旧宿主的降级形态，不是推荐形态：没有它，重启后到房间 attach 之前存储层
   * 不知道这张画布属于远端，会把托管存储里的对象报成不存在。
   */
  ownership?: SyncCanvasOwnershipStore;
};

/**
 * 关闭事件的公共子集：浏览器 `CloseEvent` 与 `ws` 的关闭事件都带 code / reason。
 *
 * 这两个字段是"要不要重连"的依据：`1009`（message too big）说明同一份数据再发一次
 * 仍然会失败，必须停止自动重试；其余断开才按退避重连。
 */
export type WebSocketCloseEvent = { code?: number; reason?: string };

// 用 interface 而不是 type 字面量：addEventListener 需要按事件名重载，字面量不允许同名成员。
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: WebSocketCloseEvent) => void): void;
}

/**
 * 把上游链路状态映射成目录能用的同步状态。
 *
 * 目录只关心"这张画布现在同步到哪一步"，因此这里把链路相位（connecting/syncing/
 * synced/offline/failed）折叠成 `CanvasSyncState`。没有链路时返回 undefined，让目录按
 * `sources` 自己给出缺省结论（仅本机 / 仅远端 / 两边都有 = 已同步）——「没有链路」既可能是
 * 这张画布没被加载过，也可能是它没被同意同步，这里不猜。
 */
export function syncStateOf(
  upstream: SyncUpstream | undefined,
  canvasId: string
): import("@woohaa3/contracts").CanvasSyncState | undefined {
  if (!upstream) return undefined;
  const state = upstream.linkState(canvasId);
  if (state === null) return undefined;
  switch (state.phase) {
    case "synced":
      return "synced";
    case "connecting":
    case "syncing":
      return "syncing";
    case "offline":
      return "offline";
    case "failed":
      return "failed";
  }
}

export type SyncUpstream = {
  /** 挂到 registry 的 `onRoomReady`：为 room 建立上游连接，返回断开函数。 */
  attach(room: UpstreamRoom): () => void;
  /** 挂到 registry 的 broadcast：把本机命令产生的 durable update 推给中继。 */
  publish: RoomBroadcast;
  /** 一次性读取中继上的完整状态；中继为空、不可达或超时返回 null。 */
  fetchSnapshot(canvasId: string): Promise<Uint8Array | null>;
  /**
   * 重新解析所有已加载 room 的上游。
   *
   * 会话登录/登出、某张画布刚被显式启用同步、静态配置热重载都会调用它；每个 room 各自
   * 重新问一次来源，因此可以只让某一张画布开始或停止同步，而不是整体切换。
   */
  refresh(): Promise<void>;
  linkState(canvasId: string): SyncUpstreamLinkState | null;
  /** 当前真正建立了上游链路的画布 id。 */
  linkedCanvasIds(): readonly string[];
  /**
   * **属于远端**的画布 id（持久判据：来自宿主注入的 `ownership` 记录，进程重启后仍在）。
   *
   * 与 `linkedCanvasIds()` 的区别是「归属」vs「此刻连没连上」：某张画布一旦被解析到远端配置，
   * 它就属于远端，断线、重连、房间未加载都不改变这个事实。宿主存储层按它决定媒体读写走
   * 托管存储——用链路状态判会退化成「离线时把远端对象当本地找」，那是错的：对象的归属由
   * 它被写进谁而决定，与当下能不能连上无关。
   */
  remoteCanvasIds(): readonly string[];
  /**
   * 把一张画布补记为归远端（远端目录里已经存在的画布，字节本来就在托管存储里）。
   *
   * `link()` 记的是"这次解析到远端"，这个记的是"目录里已经存在"：登录/启动后目录
   * 能看到的画布都算归属，老版本升级上来的机器靠它补齐，不必等第一次打开画布。
   * 已记过的画布不会重复写盘。
   */
  rememberOwnership(canvasId: string): void;
  /**
   * 收回某张画布的远端归属（画布被删除时调用）。
   *
   * 只有"这张画布不存在了"才能收回：登出、断线、解析为 null 都不算，字节还在托管存储里。
   */
  forgetOwnership(canvasId: string): void;
  close(): void;
};

const OPEN = 1;

type LinkOptions = SyncUpstreamOptions & SyncUpstreamConfig;

/**
 * `SyncUpstreamOptions.clientInfo` 的确定值：在 `createSyncUpstream` 入口算一次，
 * 之后每条链路与快照读取都用同一份，避免"同一台机器不同连接报不同版本"。
 */
type ResolvedLinkOptions = LinkOptions & { clientInfo: UpstreamClientInfo };

/**
 * 建一条按画布解析的上游链路。
 *
 * `resolveConfig` 是**每次连接都会问一次**的异步来源（通常落到扩展会话 + 静态配置回落），
 * 是否返回 null 决定这张画布要不要连远端。这里不缓存结论：会话会过期、用户可能刚点过
 * 「同步远端」、静态配置也可能被改。
 */
export function createSyncUpstream(
  resolveConfig: (canvasId: string) => Promise<SyncUpstreamConfig | null>,
  options: SyncUpstreamOptions = {}
): SyncUpstream {
  // 客户端自报元数据只算一次：同一进程中所有上游连接使用同一份版本与平台。
  const clientInfo = options.clientInfo ?? defaultUpstreamClientInfo();
  const rooms = new Map<string, UpstreamRoom>();
  const links = new Map<string, RelayLink>();
  /** 每张画布上一次实际应用的配置；用来避免 reconfigure 时无谓重连。 */
  const applied = new Map<string, SyncUpstreamConfig | null>();
  /**
   * 属于远端的画布（内存镜像）。
   *
   * 起点是宿主注入的持久记录：宿主重启后存储层第一次路由之前就得有答案。之后每次解析
   * 到远端配置都会写入镜像并回写持久记录；链路断开、房间卸载、登出都**不**移除——
   * 字节已经在托管存储里，归属不会因为"这次没连上"改变。只有画布被删除（宿主调
   * `ownership.forget`）才收回。
   */
  const remoteCanvasIds = new Set<string>(options.ownership?.initial() ?? []);
  /**
   * 解析代次：每次 attach / refresh 递增。
   *
   * 解析要问一次异步来源，期间 room 可能已被释放、用户又改了同步意图；用代次丢弃过期结果，
   * 避免旧答案晚到覆盖新决定。
   */
  let generation = 0;

  /** 记一笔归属（内存镜像 + 持久记录）：解析结果与目录补记共用同一个入口。 */
  const rememberOwnership = (canvasId: string): void => {
    if (canvasId === "" || remoteCanvasIds.has(canvasId)) return;
    remoteCanvasIds.add(canvasId);
    try {
      options.ownership?.remember(canvasId);
    } catch {
      // 记录失败只影响重启后的免解析，不能影响链路或目录补记。
    }
  };

  const link = async (room: UpstreamRoom, attempt: number): Promise<void> => {
    let config: SyncUpstreamConfig | null = null;
    try {
      config = await resolveConfig(room.canvasId);
    } catch {
      // 扩展故障不得让同步消失（与 resolveUpstreamConfig 同一口径）。
      config = null;
    }
    if (attempt !== generation) return;
    if (rooms.get(room.canvasId) !== room) return;
    const hasLink = links.has(room.canvasId);
    // 失败不是终态：refresh（重新登录、重新启用同步、宿主重启后的重新解析）应当允许
    // 再试一次——容量错误可能已经在服务端修好，但同一份超限数据不该自动死循环。
    const failedLink = links.get(room.canvasId)?.state.phase === "failed";
    if (sameConfig(applied.get(room.canvasId), config) && hasLink === (config !== null) && !(hasLink && failedLink)) return;
    applied.set(room.canvasId, config);
    // 归属只增不减：解析到远端配置就是"字节归远端"。解析为 null 只表示"此刻不建立链路"
    // （未登录、扩展故障、用户还没打开），不表示字节搬回过本地——删掉归属会让远端对象
    // 在下次读到之前一直被当作本地，正是"生成成功却报核验失败"的成因。
    if (config !== null) rememberOwnership(room.canvasId);
    links.get(room.canvasId)?.stop();
    links.delete(room.canvasId);
    if (!config) return;
    const next = new RelayLink(room, { ...options, clientInfo, ...config });
    links.set(room.canvasId, next);
    next.start();
    try {
      options.onLinked?.(room.canvasId);
    } catch {
      // 回调失败不得影响同步链路。
    }
  };

  return {
    attach(room) {
      rooms.set(room.canvasId, room);
      void link(room, generation);
      return () => {
        if (rooms.get(room.canvasId) !== room) return;
        rooms.delete(room.canvasId);
        applied.delete(room.canvasId);
        links.get(room.canvasId)?.stop();
        links.delete(room.canvasId);
      };
    },
    publish({ room, update, origin }) {
      if (origin !== "command") {
        // 远端合入可能带着别人的改名：同步过去，让服务端展示名跟上。
        links.get(room.canvasId)?.syncTitle();
        return;
      }
      links.get(room.canvasId)?.publishLocal(update);
    },
    async fetchSnapshot(canvasId) {
      let config: SyncUpstreamConfig | null = null;
      try {
        config = await resolveConfig(canvasId);
      } catch {
        config = null;
      }
      if (!config) return null;
      return fetchSnapshot(canvasId, { ...options, clientInfo, ...config });
    },
    async refresh() {
      const attempt = ++generation;
      await Promise.all([...rooms.values()].map((room) => link(room, attempt)));
    },
    linkState: (canvasId) => links.get(canvasId)?.state ?? null,
    linkedCanvasIds: () => [...links.keys()],
    remoteCanvasIds: () => [...remoteCanvasIds],
    rememberOwnership,
    forgetOwnership(canvasId) {
      if (!remoteCanvasIds.delete(canvasId)) return;
      try {
        options.ownership?.forget(canvasId);
      } catch {
        // 收回失败只留一条陈旧记录，下次解析会覆盖；不能影响删除本身。
      }
    },
    close() {
      generation += 1;
      applied.clear();
      remoteCanvasIds.clear();
      for (const entry of links.values()) entry.stop();
      links.clear();
      rooms.clear();
    }
  };
}

function sameConfig(a: SyncUpstreamConfig | null | undefined, b: SyncUpstreamConfig | null | undefined): boolean {
  return (a ?? null)?.url === (b ?? null)?.url && (a ?? null)?.token === (b ?? null)?.token;
}

function sessionUrl(options: SyncUpstreamConfig, canvasId: string): string {
  const params = options.token ? `?token=${encodeURIComponent(options.token)}` : "";
  return `${options.url}/ws/canvases/${encodeURIComponent(canvasId)}${params}`;
}

/**
 * 打开一条 WebSocket。
 *
 * 默认路径（Node 的 `ws`）显式带 `User-Agent`：服务端观测通道在握手时就记下 UA，
 * 管理端因此能在不看 Hello 的情况下认出"这是本机宿主"。测试注入的 `WebSocketImpl`
 * 保持原来的单参数构造签名，不被迫处理请求头。
 *
 * 浏览器直连远端不是当前形态（浏览器只连本机宿主），因此这里不处理浏览器无法设置
 * 自定义头的限制；真出现浏览器直连时 UA 会退化成浏览器默认值，版本仍由 Hello 声明。
 */
function openSocket(options: ResolvedLinkOptions, url: string): WebSocketLike {
  if (options.WebSocketImpl) return new options.WebSocketImpl(url);
  return new WebSocket(url, {
    headers: { "User-Agent": upstreamUserAgent(options.clientInfo) }
  }) as unknown as WebSocketLike;
}

function encodeClientFrame(init: MessageInitShape<typeof ClientFrameSchema>): Uint8Array {
  return toBinary(ClientFrameSchema, create(ClientFrameSchema, init));
}

/**
 * `createIfMissing` 是"本地新建的画布第一次推给远端"的显式意图。
 *
 * 只读路径（`fetchSnapshot`）必须传 false：它发的是同样的空 epoch/after_seq，
 * 若也声明创建意图，一次读取就会变成一次认领。
 *
 * `client` 是观测用的自报元数据（`ClientInfo`）：服务端只透传给管理端调试通道，
 * 不参与任何判定；旧服务端忽略未知字段，因此带上它没有兼容性风险。
 */
function helloFrame(
  roomEpoch: string,
  afterSeq: bigint,
  createIfMissing: boolean,
  title: string,
  clientInfo: UpstreamClientInfo
): Uint8Array {
  return encodeClientFrame({
    frame: {
      case: "hello",
      value: {
        version: SessionProtocolVersion.SESSION_PROTOCOL_VERSION_1,
        roomEpoch,
        afterSeq,
        createIfMissing,
        // 空标题不发：proto3 里默认值本来就不会上线，显式省掉也让"没有可声明"
        // 与"声明了空串"在阅读代码时仅有一种写法。
        ...(title === "" ? {} : { title }),
        client: {
          name: clientInfo.name,
          version: clientInfo.version,
          platform: clientInfo.platform
        }
      }
    }
  });
}

async function fetchSnapshot(canvasId: string, options: ResolvedLinkOptions): Promise<Uint8Array | null> {
  const log = options.logger ?? (() => undefined);
  const timeoutMs = options.snapshotTimeoutMs ?? 5_000;
  return new Promise((resolve) => {
    const doc = new Y.Doc();
    let received = false;
    let settled = false;
    let ws: WebSocketLike | null = null;
    const finish = (value: Uint8Array | null, code?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code) log({ event: "sync-upstream-snapshot-unavailable", canvasId, code });
      try {
        ws?.close(1000, "snapshot-done");
      } catch {
        // ignore
      }
      doc.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null, "timeout"), timeoutMs);
    let socket: WebSocketLike;
    try {
      socket = openSocket(options, sessionUrl(options, canvasId));
    } catch {
      finish(null, "connect-failed");
      return;
    }
    ws = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => socket.send(helloFrame("", 0n, false, "", options.clientInfo)));
    socket.addEventListener("message", (event) => {
      const bytes = toBytes(event.data);
      if (!bytes) return;
      let frame: ServerFrame;
      try {
        frame = fromBinary(ServerFrameSchema, bytes);
      } catch {
        finish(null, "bad-frame");
        return;
      }
      const f = frame.frame;
      if (f.case === "update") {
        Y.applyUpdate(doc, f.value.update);
        received = true;
      } else if (f.case === "synced") {
        finish(received ? Y.encodeStateAsUpdate(doc) : null);
      } else if (f.case === "error") {
        finish(null, f.value.code);
      }
    });
    socket.addEventListener("close", () => finish(null, "closed"));
    socket.addEventListener("error", () => finish(null, "connect-failed"));
  });
}

class RelayLink {
  state: SyncUpstreamLinkState = { phase: "connecting", canWrite: false, cursor: 0n, error: null };

  private readonly room: UpstreamRoom;
  private readonly url: string;
  /** 链路级选项（含确定的 clientInfo）：握手头与 Hello 都从这里取。 */
  private readonly options: ResolvedLinkOptions;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly healthyLinkMs: number;
  /** 本次连接建立时刻（Date.now()）；0 表示尚未 open。 */
  private openedAt = 0;
  private readonly log: (event: SyncUpstreamEvent) => void;

  private ws: WebSocketLike | null = null;
  private mirror = new Y.Doc();
  private epoch = "";
  private clientSeq = 0n;
  /** 本次连接里已经声明过的标题；null 表示"还没声明过"。 */
  private sentTitle: string | null = null;
  private readonly pending = new Map<bigint, Uint8Array>();
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(room: UpstreamRoom, options: ResolvedLinkOptions) {
    this.room = room;
    this.url = sessionUrl(options, room.canvasId);
    this.options = options;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 500;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 10_000;
    this.healthyLinkMs = options.healthyLinkMs ?? 10_000;
    this.log = options.logger ?? (() => undefined);
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, "room-disposed");
    } catch {
      // ignore
    }
    this.mirror.destroy();
  }

  publishLocal(update: Uint8Array): void {
    // 未同步完成或不可写时不发：下一次 Synced 的求差会补推。
    if (this.state.phase !== "synced" || !this.state.canWrite) return;
    this.sendUpdate(update);
    // 改名命令也会走到这里：published 文档的 meta.title 已经前进，顺带把新标题
    // 声明给服务端（管理端靠它展示可读名称）。
    this.syncTitle();
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocketLike;
    try {
      ws = openSocket(this.options, this.url);
    } catch (error) {
      this.setState({ phase: "offline", error: errorMessage(error) });
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    // 新连接要重新声明标题：服务端不解析 Yjs，只有这条通道能把展示名交上去。
    this.sentTitle = null;
    this.setState({ phase: "connecting", error: null });

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.openedAt = Date.now();
      this.setState({ phase: "syncing" });
      // epoch 为空且游标为 0 = 手里没有这条中继线路的任何记录。此时本地内容若存在，
      // 就是"远端第一次见到这张画布"，声明创建意图；远端据此登记并把本机主体记为作者。
      const firstContact = this.epoch === "" && this.state.cursor === 0n;
      // 标题随 Hello 声明：服务端只在"登记新画布"或"已有画布标题为空且我是作者"时
      // 采用它（见 canvasacl.Claim），不会用旧设备上的陈旧名字覆盖已有标题。
      this.sendRaw(helloFrame(this.epoch, this.state.cursor, firstContact, this.room.title(), this.options.clientInfo));
    });
    ws.addEventListener("message", (event) => {
      if (this.ws !== ws) return;
      const bytes = toBytes(event.data);
      if (!bytes) return;
      let frame: ServerFrame;
      try {
        frame = fromBinary(ServerFrameSchema, bytes);
      } catch (error) {
        this.log({ event: "sync-upstream-bad-frame", canvasId: this.room.canvasId, message: errorMessage(error) });
        return;
      }
      this.handle(frame);
    });
    ws.addEventListener("close", (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      // 未 ack 的发送靠下一次 Synced 求差补推。
      this.pending.clear();
      const code = event?.code ?? 0;
      this.log({
        event: "sync-upstream-closed",
        canvasId: this.room.canvasId,
        ...(code === 0 ? {} : { code: String(code) })
      });
      if (this.state.phase === "failed") return;
      if (code === 1009) {
        // 对端读上限：同一份文档重发的字节数不会变小，重连只是把同一条路再走一遍。
        this.stopForPayloadTooLarge();
        return;
      }
      // 刚连上就断（容量型拒绝、握手后被踢、代理抖动）不重置退避，否则会打成重连风暴；
      // 只有活过 healthyLinkMs 的链路才算恢复，下次断开才回到基线。
      if (this.openedAt !== 0 && Date.now() - this.openedAt >= this.healthyLinkMs) this.attempt = 0;
      this.setState({ phase: "offline" });
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      if (this.ws !== ws) return;
      this.setState({ error: "连接错误" });
    });
  }

  private handle(frame: ServerFrame): void {
    const f = frame.frame;
    switch (f.case) {
      case "welcome":
        if (this.epoch !== "" && f.value.roomEpoch !== this.epoch) {
          // 中继数据被重建：服务端会从头补发，mirror 随之重建。
          this.mirror.destroy();
          this.mirror = new Y.Doc();
          this.setState({ cursor: 0n });
        }
        this.epoch = f.value.roomEpoch;
        this.setState({ canWrite: f.value.canWrite });
        return;
      case "update":
        Y.applyUpdate(this.mirror, f.value.update);
        this.advance(f.value.seq);
        if (this.state.phase === "synced") void this.mergeIntoRoom(f.value.update);
        return;
      case "ack": {
        const update = this.pending.get(f.value.clientSeq);
        this.pending.delete(f.value.clientSeq);
        if (update) Y.applyUpdate(this.mirror, update);
        this.advance(f.value.seq);
        // 数据完整往返是被服务端接受的直接证据，比连接时长更可靠。
        this.attempt = 0;
        return;
      }
      case "synced":
        this.advance(f.value.seq);
        // 注意：这里**不**重置退避。Synced 只说明服务端接受了 Hello，不说明它接受得了
        // 随后的大帧；容量型失败正是在 Synced 之后才发生的。
        this.setState({ phase: "synced", error: null });
        void this.reconcile();
        return;
      case "awareness":
        return;
      case "error":
        this.log({ event: "sync-upstream-error", canvasId: this.room.canvasId, code: f.value.code, message: f.value.message });
        this.setState({ error: `${f.value.code}: ${f.value.message}` });
        if (!f.value.retryable) {
          this.setState({ phase: "failed" });
          this.stopped = true;
        }
        return;
      default:
        return;
    }
  }

  /** Synced 后双向求差：先把中继多出的合入 room，再把 room 多出的补推给中继。 */
  private async reconcile(): Promise<void> {
    const incoming = Y.encodeStateAsUpdate(this.mirror, this.room.encodeStateVector());
    await this.mergeIntoRoom(incoming);
    if (this.stopped || this.state.phase !== "synced" || !this.state.canWrite) return;
    const outgoing = this.room.encodeDiff(Y.encodeStateVector(this.mirror));
    if (wouldChange(this.mirror, outgoing)) this.sendUpdate(outgoing);
    // 同步完成后再声明：此时 room 的标题已经合入远端的最新值，不会把本地陈旧标题推上去。
    this.syncTitle();
  }

  /**
   * 把当前画布标题声明给服务端（展示元数据，不产生记录、不广播）。
   *
   * 只在可写连接上发：服务端同样按写权限判定，只读连接发了也是丢弃。空标题只在
   * "之前声明过非空标题"时发送（表示清空），首次同步的空标题不必声明。
   */
  syncTitle(): void {
    if (this.state.phase !== "synced" || !this.state.canWrite) return;
    const title = this.room.title();
    if (title === this.sentTitle) return;
    if (this.sentTitle === null && title === "") {
      this.sentTitle = "";
      return;
    }
    this.sendRaw(encodeClientFrame({ frame: { case: "title", value: { title } } }));
    this.sentTitle = title;
  }

  private async mergeIntoRoom(update: Uint8Array): Promise<void> {
    const result = await this.room.applyExternalUpdate(update);
    if (!result.ok) {
      this.log({ event: "sync-upstream-merge-rejected", canvasId: this.room.canvasId, code: result.code, message: result.message });
    }
  }

  private sendUpdate(update: Uint8Array): void {
    this.clientSeq += 1n;
    this.pending.set(this.clientSeq, update);
    this.sendRaw(encodeClientFrame({ frame: { case: "update", value: { clientSeq: this.clientSeq, update } } }));
  }

  private sendRaw(frame: Uint8Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return;
    ws.send(frame);
  }

  private advance(seq: bigint): void {
    if (seq > this.state.cursor) this.setState({ cursor: seq });
  }

  /**
   * 服务端以 1009（message too big）关闭：单帧超过对端读上限。
   *
   * 重试没有意义——同一份文档会以同样的大小再发一次。这里转成不可重试的失败态，
   * 让界面给出明确提示，而不是把带宽和连接数耗在无限重连上。
   */
  private stopForPayloadTooLarge(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.log({
      event: "sync-upstream-payload-too-large",
      canvasId: this.room.canvasId,
      code: "payload-too-large",
      message: "单帧超过服务端接收上限，已停止自动重试"
    });
    this.setState({ phase: "failed", error: "同步数据超过服务端接收上限，已停止自动重试" });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(this.reconnectBaseMs * 2 ** this.attempt, this.reconnectMaxMs);
    this.attempt += 1;
    this.log({
      event: "sync-upstream-reconnect",
      canvasId: this.room.canvasId,
      message: `retry in ${Math.round(delay)}ms`
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay * (0.8 + Math.random() * 0.4));
  }

  private setState(patch: Partial<SyncUpstreamLinkState>): void {
    const before = this.state.phase;
    this.state = { ...this.state, ...patch };
    if (patch.phase && patch.phase !== before) {
      this.log({ event: `sync-upstream-${patch.phase}`, canvasId: this.room.canvasId, ...(this.state.error ? { message: this.state.error } : {}) });
    }
  }
}

/** update 合入 base 后是否会改变文档（包括只含删除的 update）。 */
function wouldChange(base: Y.Doc, update: Uint8Array): boolean {
  const probe = new Y.Doc();
  Y.applyUpdate(probe, Y.encodeStateAsUpdate(base));
  let changed = false;
  probe.on("update", () => {
    changed = true;
  });
  Y.applyUpdate(probe, update);
  probe.destroy();
  return changed;
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data) && data.every((part) => part instanceof Uint8Array)) return new Uint8Array(Buffer.concat(data));
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
