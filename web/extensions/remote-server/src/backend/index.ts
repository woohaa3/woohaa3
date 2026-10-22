/**
 * remote-server 后端：把远端 woohaa-server 的 Connect 一元接口包成扩展 handler，
 * 并把「服务端掌管的字节」注册成一个存储后端。
 *
 * 为什么这三件事在同一个扩展里：接入服务端是一个完整能力——身份（会话）、同步上游（中继 Bearer）
 * 与媒体字节（存储后端）都是同一份会话的下游。拆成两个扩展会出现两份登录与两套部署配置，
 * 而它们本该一致。
 *
 * 为什么必须在本机宿主里做（而不是浏览器直连）：
 * 1. 远端服务端**零 CORS**（Connect handler 对 OPTIONS 回 405），浏览器跨源连第一个请求都发不出去；
 * 2. 会话令牌必须留在本机（边界规则 B1/B3），浏览器只读状态快照；
 * 3. 画布同步上游与存储字节读写本来就是本机宿主发起的，凭据在同一个进程里才能交给它们。
 *
 * 本模块只依赖 `@woohaa3/contracts` 的宿主纯类型与扩展自有代码；不 import 宿主内部实现，
 * 也不 import 远端 Go 服务端的任何东西——两端只共享生成绑定的字段语义，这里按 Connect 的
 * HTTP/JSON 线格式直接发请求，避免把整个 `@connectrpc/connect` 拖进宿主依赖。
 */
import type {
  ApplicationBackendDiagnosticEntry,
  ApplicationBackendExtensionDefinition,
  ApplicationExtensionRequestContext,
  CanvasAccess,
  CanvasUpstreamLink,
  CanvasUpstreamProvider
} from "@woohaa3/contracts";
import { canvasUpstreamCapabilityId, isBoundedId } from "@woohaa3/contracts";
import {
  CANVAS_SERVICE,
  IDENTITY_SERVICE,
  LOCAL_ONLY_SNAPSHOT,
  OPS_SERVICE,
  REMOTE_SERVER_CANVAS_INVITE_CREATE_ROUTE,
  REMOTE_SERVER_CANVAS_INVITE_REVOKE_ROUTE,
  REMOTE_SERVER_CANVAS_INVITES_ROUTE,
  REMOTE_SERVER_CANVAS_MEMBER_REMOVE_ROUTE,
  REMOTE_SERVER_CANVAS_MEMBER_UPSERT_ROUTE,
  REMOTE_SERVER_CANVAS_MEMBERS_ROUTE,
  REMOTE_SERVER_CANVAS_SHARE_ROUTE,
  REMOTE_SERVER_CANVAS_SHARE_UPDATE_ROUTE,
  REMOTE_SERVER_DEVICE_POLL_ROUTE,
  REMOTE_SERVER_DEVICE_START_ROUTE,
  REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE,
  REMOTE_SERVER_DIAGNOSTICS_ROUTE,
  REMOTE_SERVER_EXTENSION_ID,
  REMOTE_SERVER_GENERATION_REFRESH_ROUTE,
  REMOTE_SERVER_LOGIN_ROUTE,
  REMOTE_SERVER_LOGOUT_ROUTE,
  REMOTE_SERVER_METADATA,
  REMOTE_SERVER_OAUTH_CALLBACK_ROUTE,
  REMOTE_SERVER_OAUTH_DONE_ROUTE,
  REMOTE_SERVER_OAUTH_POLL_ROUTE,
  REMOTE_SERVER_OAUTH_START_ROUTE,
  REMOTE_SERVER_PROBE_ROUTE,
  REMOTE_SERVER_SESSION_ROUTE,
  REMOTE_SERVER_SYNC_ENABLE_ROUTE,
  canvasRoleFromProto,
  canvasRoleToProto,
  canvasShareModeFromProto,
  canvasShareModeToProto,
  connectProcedurePath,
  inviteErrorText,
  memberErrorText,
  normalizeFrontendVersion,
  normalizeRevision,
  parseCanvasInviteCreate,
  parseCanvasInviteTarget,
  parseCanvasMemberMutation,
  parseCanvasMemberTarget,
  parseCanvasShareUpdate,
  parseServerUrl,
  pickLoginAssertionHeaders,
  resolveRemoteEndpoints,
  type RemoteAuthMethod,
  type RemoteCanvasInvite,
  type RemoteCanvasMember,
  type RemoteCanvasShareResult,
  type RemoteCanvasShareUpdateResult,
  type RemoteDiagnosticLevel,
  type RemoteDiagnosticsReportResult,
  type RemoteDiagnosticsSnapshot,
  type RemoteDeviceLoginStart,
  type RemoteServerLoginInput,
  type RemoteServerSnapshot
} from "../shared.js";
import { readRemoteServerDeployment, type RemoteServerDeployment } from "../deployment.js";
import { callConnect, connectErrorText, exchangeLogin } from "./connect.js";
import { createRemoteGenerationBridge, type RemoteGenerationStatus } from "./generation/index.js";
import { createOAuthLogin } from "./oauth-login.js";
import { createRemoteTelemetryExport } from "./telemetry-export.js";
import {
  SESSION_UNCONFIGURED_CODE,
  createMemorySessionStore,
  createRemoteSessionSource,
  isSessionUsable,
  parseSessionExpiry,
  resolveServerUrl,
  type RemoteSession,
  type RemoteSessionStore
} from "./session.js";
import { createDocumentSessionStore } from "./session-store.js";
import {
  createDocumentSyncPendingStore,
  createMemorySyncPendingStore,
  type RemoteSyncScope
} from "./sync-pending-store.js";
import { createServerStorageBackend, type ServerStorageBackendOptions } from "./storage/backend.js";
import { resolveServerStorageConfig, type ServerStorageConfig } from "./storage/config.js";

export type { RemoteSession, RemoteSessionStore };
export { createMemorySessionStore };

export type RemoteServerExtensionOptions = {
  /** 可信部署适配器允许转发的断言头；缺省为空，普通请求头绝不用于远端登录。 */
  loginAssertionHeaders?: readonly string[];
  /** 部署配置读取（缺省读扩展目录 config.local.json + 环境变量）。 */
  deployment?: () => RemoteServerDeployment;
  /** 出站 fetch（测试注入）。 */
  fetchImpl?: typeof globalThis.fetch;
  /** 时钟（测试注入）。 */
  now?: () => number;
  /**
   * 会话持久化端口。
   *
   * 宿主没注入时退化为进程内存：重启即掉登录，但不会把令牌写进任何未声明的载体。
   * 生产装配应注入基于扩展文档存储的实现（owner-scoped），使登录跨重启保留。
   */
  store?: RemoteSessionStore;
  /**
   * 存储后端的传输层覆盖（测试注入 fake fetch / 时钟 / 超时）。
   *
   * 会话**不**在这里传：存储后端与状态 handler 共用同一份会话，否则会再次出现两套登录。
   */
  storageTransport?: Pick<ServerStorageBackendOptions, "fetchImpl" | "hostOrigin" | "timeoutMs" | "transferTimeoutMs">;
  /**
   * 托管生成适配器的覆盖项（测试注入：把轮询间隔调小；超时也走同一处）。
   *
   * 生产不配置：轮询间隔由服务端 `GetCapabilities.pollAfterMs` / pptask 缺省决定。
   */
  generation?: { pollIntervalMs?: number; clientTimeoutMs?: number };
};

/** 从 GetAuthMethods 的响应里抽出展示所需的登录方式。 */
export function decodeAuthMethods(value: unknown): RemoteAuthMethod[] {
  if (value === null || typeof value !== "object") return [];
  const raw = (value as { methods?: unknown }).methods;
  if (!Array.isArray(raw)) return [];
  const out: RemoteAuthMethod[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const kind = readString(record, "kind");
    // 枚举的取值：AUTH_METHOD_KIND_MACHINE_TOKEN / GATEWAY_ASSERTION / TOF_SSO。
    // TOF 是「浏览器跳统一登录页、服务端换身份」的方式，这里只做展示；接入扩展自己
    // 仍以设备码为主路径，不替远端决定人怎么登录。
    if (kind === "AUTH_METHOD_KIND_MACHINE_TOKEN" || kind === "machine-token") {
      out.push({ kind: "machine-token" });
    } else if (kind === "AUTH_METHOD_KIND_GATEWAY_ASSERTION" || kind === "gateway") {
      out.push({ kind: "gateway", ...(record.ambient === true ? { ambient: true } : {}) });
    } else if (kind === "AUTH_METHOD_KIND_TOF_SSO" || kind === "tof" || kind === "tof-sso") {
      out.push({ kind: "tof" });
    }
  }
  return out;
}

function readNumber(value: unknown, key: string): number | null {
  if (value === null || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function readString(value: unknown, key: string): string | null {
  if (value === null || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw !== "" ? raw : null;
}

/**
 * 把 proto 的一条 CanvasMember 折成界面用的两档角色。
 *
 * 形状不符的条目**丢弃**而不是让整次读取失败：名单里出现一条坏数据不该把协作界面
 * 打空；真正需要报错的是"连名单都读不到"（由调用方处理）。
 */
function mapCanvasMember(value: unknown): RemoteCanvasMember | null {
  const actorId = readString(value, "actorId");
  const role = canvasRoleFromProto(readString(value, "role"));
  if (actorId === null || role === null) return null;
  return {
    actorId,
    role,
    grantedBy: readString(value, "grantedBy") ?? "",
    grantedAt: readString(value, "grantedAt") ?? ""
  };
}

function readBoolean(value: unknown, key: string): boolean | null {
  if (value === null || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "boolean" ? raw : null;
}

/** 读一个非负整数（ProtoJSON 的 int32 是数字，字符串形式一并容错）；非法返回 null。 */
function readNonNegativeInteger(value: unknown, key: string): number | null {
  if (value === null || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[key];
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 把 proto 的一条 CanvasInvite 折成界面用的形状。
 *
 * 与成员映射一致：单条坏数据丢弃而不是让整次读取失败。`expiresAt` 由服务端保证非空，
 * 但这里仍允许空串（界面显示「—」），不自己编一个到期时间。
 */
function mapCanvasInvite(value: unknown): RemoteCanvasInvite | null {
  const inviteId = readString(value, "inviteId");
  const role = canvasRoleFromProto(readString(value, "role"));
  if (inviteId === null || role === null) return null;
  return {
    inviteId,
    role,
    createdBy: readString(value, "createdBy") ?? "",
    createdAt: readString(value, "createdAt") ?? "",
    expiresAt: readString(value, "expiresAt") ?? "",
    acceptedCount: readNonNegativeInteger(value, "acceptedCount") ?? 0,
    lastAcceptedAt: readString(value, "lastAcceptedAt") ?? "",
    revoked: readBoolean(value, "revoked") ?? false
  };
}

/**
 * 分享设置的稳定错误短语（远端正文与内部细节不进浏览器）。
 *
 * `aborted` 是并发校验的**正常结果**而不是故障：服务端按 revision 拒绝了这次写入，人需要
 * 重读后再试。`invalid_argument` 在这里特指「服务端还没放开这个分享模式」（everyone_view /
 * everyone_edit 在协议里存在，但部分部署会拒绝设置）——如实说「尚未开放」，不伪装成功。
 */
function shareErrorText(code: string, action: "read" | "update"): string {
  switch (code) {
    case "unauthenticated":
      return "未连接服务端或会话已失效";
    case "permission_denied":
      // 分享设置只属于作者：部署管理员能代管成员（canvas.manage），但不含 canvas.share，
      // 因此这里不能把"管理员也能改"写进文案。
      return action === "update" ? "只有作者能修改分享设置" : "没有权限查看这张画布的分享设置";
    case "not_found":
      return "画布不存在或对你不可见";
    case "failed_precondition":
      return action === "update" ? "画布已删除，不能修改分享设置" : "画布已删除，不能查看分享设置";
    case "aborted":
      return "分享设置已被其他人修改，请重读后重试";
    case "invalid_argument":
      return action === "update" ? "服务端尚未开放这个分享模式" : "服务端返回了不支持的分享设置";
    case "unimplemented":
      return "这台服务端还没有分享设置接口";
    case "unavailable":
      return "远端服务暂不可用";
    case "timeout":
      return "远端响应超时";
    case "unreachable":
      return "无法连接远端服务端";
    default:
      return "分享设置操作失败";
  }
}

/** 读一个受控 HTTP 请求体（有界）；非 JSON 或空体返回空对象，不抛给调用方。 */
async function readBody(req: { on(event: string, listener: (...args: never[]) => void): unknown }): Promise<Record<string, unknown>> {
  const MAX = 64 * 1024;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: Record<string, unknown>) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on("data", ((chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX) return finish({});
      chunks.push(chunk);
    }) as never);
    req.on("end", (() => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text === "") return finish({});
      try {
        const parsed: unknown = JSON.parse(text);
        finish(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {});
      } catch {
        finish({});
      }
    }) as never);
    req.on("error", (() => finish({})) as never);
  });
}

/** 客户端诊断上报服务（生成绑定见 `api/gen/es/woohaa/diagnostics/v1alpha1`）。 */
const DIAGNOSTICS_SERVICE = "woohaa.diagnostics.v1alpha1.ClientDiagnosticsService";

/**
 * 诊断窗口上限：读取与上报共用一页。
 *
 * 与服务端 `ReportDiagnostics` 的批上限（200 条）对齐——读取时不造出一个上报不了的大窗口。
 */
const DIAGNOSTIC_WINDOW_LIMIT = 200;

/**
 * 上报分批上限：每批条数，以及请求体 JSON 的 UTF-8 字节数。
 *
 * 为什么必须按字节切：服务端在**解码阶段**用 `connect.WithReadMaxBytes` 卡 32 KiB，
 * 超限连 handler 都进不去，客户端只能拿到 `resource_exhausted`（界面上就是「远端调用失败」）。
 * 实测 200 条带短说明约 36–39 KB，按条数切根本不够。
 *
 * 为什么是 24 KiB 而不是 32 KiB：给反向代理、网关与契约里未来可能新增的字段留余量；
 * 每批多花一次往返的代价远小于一次整批被拒。
 */
const DIAGNOSTIC_BATCH_MAX_ENTRIES = 200;
const DIAGNOSTIC_BATCH_MAX_BYTES = 24 * 1024;

/** 诊断级别 → proto 枚举值。宿主只产出这四种级别；未知值按 info 上报。 */
const DIAGNOSTIC_LEVEL_TO_PROTO: Record<RemoteDiagnosticLevel, string> = {
  debug: "LEVEL_DEBUG",
  info: "LEVEL_INFO",
  warn: "LEVEL_WARN",
  error: "LEVEL_ERROR"
};

/**
 * 「上报成功」的事件名。
 *
 * 它既是写进宿主日志的事件，也是**唯一不能再次上报**的条目：这条事件描述的是上报动作本身，
 * 而宿主 logger 会把它同步投影回诊断缓冲。若把它也发上去就形成自指链条——每次成功都留下
 * 一条新条目，下一次点击永远「恰好有新条目」，「没有新条目」状态再也不出现，连点两次总有东西
 * 可发。服务端虽然会按 `entryId` 去重、不会重复落库，但多发无谓请求没有意义。上报失败事件
 * 刻意不排除：它描述的是接入链路真实发生过的故障，而且失败时不会写成功事件，不会自我维持。
 */
const DIAGNOSTICS_REPORT_OK_EVENT = "remote-diagnostics-report-ok";

/** 一条 `ClientDiagnosticEntry` 的 Connect JSON 形状（proto 字段用 lowerCamelCase）。 */
type DiagnosticReportEntry = {
  /** 幂等键（proto `entry_id`）：服务端按「主体 + entryId」只落一条。 */
  entryId: string;
  time: string;
  level: string;
  category: string;
  event: string;
  code?: string;
  message?: string;
  /**
   * 有界键值细节（proto `attributes`）。
   *
   * 这里只做透传，**不重新解释**：形状（键 `[a-z][a-z0-9._-]{0,31}`、值单行 ≤256 字符、
   * ≤16 对）由宿主投影保证，扩展再校验一遍只会让两处口径分叉。没有细节时不带这个字段。
   */
  attributes?: Record<string, string>;
};

/**
 * 宿主条目 → 上报条目。
 *
 * `id` → `entryId` 必须原样带上：它才是服务端去重的依据。`seq` 是宿主进程内的读取游标，
 * 既不属于契约也不能发出去（扩展重载就归零，服务端不该看见它）。
 */
function toReportEntry(entry: ApplicationBackendDiagnosticEntry): DiagnosticReportEntry {
  return {
    entryId: entry.id,
    time: new Date(entry.time).toISOString(),
    level: DIAGNOSTIC_LEVEL_TO_PROTO[entry.level] ?? "LEVEL_INFO",
    category: entry.category,
    event: entry.event,
    ...(entry.code === undefined ? {} : { code: entry.code }),
    ...(entry.message === undefined ? {} : { message: entry.message }),
    // 空 map 没有信息量，却会给每条 JSON 增加一对无谓字节；空对象与「没有细节」同样处理。
    ...(entry.attributes !== undefined && Object.keys(entry.attributes).length > 0
      ? { attributes: entry.attributes }
      : {})
  };
}

/**
 * 请求体里与条目无关的固定开销。
 *
 * 请求体是 `{"frontendVersion":"<版本>","entries":[...]}`，其余字节全是条目本身加逗号；
 * 把骨架按**本次实际上报的版本**量出来（版本最长 64 字符，不能按空串估），切批时逐条累加即可，
 * 不必反复序列化整个数组。
 */
function reportEnvelopeBytes(frontendVersion: string): number {
  return Buffer.byteLength(JSON.stringify({ frontendVersion, entries: [] }), "utf8");
}

/**
 * 按「条数 + 字节」预算把一批条目切成若干批。
 *
 * 逐条累加：加上这条就越线时先把当前批结掉。单条自身就超预算时让它独占一批——
 * 这时已经无法再切，丢掉它反而会让排障者永远看不到那条事件（契约里 message ≤512 字符，
 * 正常不会发生，这里是防止未来放宽上游限制后静默丢条目）。
 */
function splitDiagnosticBatches(
  entries: ApplicationBackendDiagnosticEntry[],
  envelopeBytes: number
): ApplicationBackendDiagnosticEntry[][] {
  const batches: ApplicationBackendDiagnosticEntry[][] = [];
  let current: ApplicationBackendDiagnosticEntry[] = [];
  /** 当前批已占用的「条目字节 + 批内逗号」字节数（不含骨架）。 */
  let used = 0;

  for (const entry of entries) {
    const entryBytes = Buffer.byteLength(JSON.stringify(toReportEntry(entry)), "utf8");
    // 不是第一条时还要一个 1 字节的逗号分隔符。
    const added = entryBytes + (current.length === 0 ? 0 : 1);
    const overflow =
      current.length > 0 &&
      (current.length >= DIAGNOSTIC_BATCH_MAX_ENTRIES || envelopeBytes + used + added > DIAGNOSTIC_BATCH_MAX_BYTES);
    if (overflow) {
      batches.push(current);
      current = [];
      used = 0;
    }
    used += entryBytes + (current.length === 0 ? 0 : 1);
    current.push(entry);
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * 一条诊断日志事件（写进 `host.logger` 的形状）。
 *
 * 字段刻意收得很窄：这里**没有**能装令牌、设备码、请求体或完整 URL 的位置。远端地址只以
 * `serverUrl` 传入，由 `log()` 折成 `serverHost`；宿主再按白名单投影进诊断缓冲。
 */
type RemoteLogInput = {
  /** 稳定事件名（宿主只接受 `^[a-z][a-z0-9-]{0,63}$`）。 */
  event: string;
  level?: RemoteDiagnosticLevel;
  /** 稳定结果/错误码（远端 Connect code 或本地约定）。 */
  code?: string;
  /** 短说明；不得含凭据或远端正文。 */
  reason?: string;
  /** 接入阶段用的稳定标识（例如凭证路径），可选。 */
  phase?: string;
  /** 凭证形态：gateway / token / none。 */
  method?: string;
  /** 远端基址；**只用于折出 `serverHost`**，不会原样进日志。 */
  serverUrl?: string | null;
  status?: number;
  /** 上报被服务端接受的条数（非秘密，便于落盘日志核对）。 */
  acceptedCount?: number;
  /** 服务端托管生成的目录事实（数量/修订号；不含模型名与正文）。 */
  modelCount?: number;
  skippedModels?: number;
  catalogRevision?: number;
};

/**
 * 远端目录里一张画布的摘要。
 *
 * 目录合并（`listCanvases`）与同步门控（`resolve` 的「已在远端」判定）读的是同一份数据，
 * 因此形状只定义一处——否则两处对 `id` 的过滤口径迟早会分叉。
 */
type RemoteCanvasSummary = {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
  createdAt?: string;
  /** 调用者在这张画布上的内容权限；省略表示这次没有答案（不当作只读）。 */
  access?: CanvasAccess;
};

/**
 * 从服务端 `Canvas` 的 `allowed_actions` 读出调用者的内容权限。
 *
 * 服务端已经在 `Canvas` 上回填 `role` / `is_owner` / `allowed_actions`，并注明"客户端据此
 * 渲染"（proto 注释）；这里只做一一映射，不自己再推一遍判定。
 *
 * 同时接受 `canvas.read` / `canvas.write` 两种动作名；两个动作**都不在**列表里说明这次
 * 响应没有带权限字段（旧服务端），返回 `undefined` 而不是"只读"——把"没答案"当只读会让
 * 所有本地画布在旧服务端上突然不可写。
 */
function accessFromCanvas(canvas: Record<string, unknown>): CanvasAccess | undefined {
  const raw = canvas.allowedActions;
  if (!Array.isArray(raw)) return undefined;
  const actions = raw.filter((item): item is string => typeof item === "string");
  if (actions.length === 0) return undefined;
  return {
    canRead: actions.includes("canvas.read"),
    canWrite: actions.includes("canvas.write")
  };
}


export function createRemoteServerExtension(options: RemoteServerExtensionOptions = {}): ApplicationBackendExtensionDefinition {
  return {
    extensionId: REMOTE_SERVER_EXTENSION_ID,
    capabilities: REMOTE_SERVER_METADATA.capabilities,
    async activate(host) {
      // 部署配置每次现读：`config.local.json` 与设置面的非秘密项都可能被改，
      // 而地址是热重载的语义（与 canvas.syncUpstream.url 一致），不该锁在启动值上。
      const readDeployment =
        options.deployment ?? (() => readRemoteServerDeployment({ values: host.config.values() }));
      /**
       * 进行中的设备码登录。**设备码只存在于本进程**：它是能换会话的凭据，等价于口令，
       * 因此不进浏览器、不写日志、不落盘。
       */
      let pendingDeviceLogin: { serverUrl: string; deviceCode: string; expiresAt: number } | null = null;
      /**
       * 重发优化用的「已发到哪」水位，**不是去重依据**。
       *
       * 正确性来自条目的 `entryId` 幂等键：服务端按「主体 + entryId」只落一条，所以重试、
       * 扩展重载、并发点击、多批重发都不会产生重复行。这里记 `seq` 只是为了少发无谓的请求
       * （宿主缓冲是环形、`seq` 单调递增，重复上报只会看到「同样的旧条目 + 新增条目」）。
       *
       * 因此不能宣称「服务端不会重复」依赖它：水位只在本进程内存里，扩展重载/宿主重启后会
       * 归零，届时整窗会重发一次——那一次的正确性由服务端按 entryId 去重兜住。
       *
       * 水位随批次推进（不是整次上报成功才推进），某批失败时它停在上一个成功批之后，
       * 重试只补后续条目（同样只是优化；即使重发已成功批次也不会造成重复落库）。
       *
       * 为什么记着 `serverUrl`：换一个服务端就等于「那边还没收到过任何东西」，沿用旧水位会让
       * 切服后的上报静默变成空操作。
       */
      let reportWatermark: { serverUrl: string; seq: number } = { serverUrl: "", seq: 0 };
      const fetchImpl = options.fetchImpl ?? globalThis.fetch;
      const now = options.now ?? (() => Date.now());
      /**
       * 记录一条**接入过程**诊断事件。
       *
       * 为什么集中在这一层而不是各处直接调 `host.logger`：
       * 1. 事件名与字段形状只有一处，避免某处「顺手」把令牌/设备码/短码/URL query 写进日志；
       * 2. 远端地址一律折成 `serverHost`（`host[:port]`，同源挂载只留路径）——诊断要回答
       *    「连的是哪台」，不需要完整地址（它可能带部署路径甚至临时参数）；
       * 3. `level` 缺省 info：宿主把 `module=application & extensionId=remote-server` 的
       *    事件投影进诊断缓冲，级别决定界面上的提示强度。
       *
       * **本函数不接受、也不该接受任何凭据字段**：调用方一旦拿不到能装秘密的键，就不会写错。
       */
      const log = (input: RemoteLogInput): void => {
        const { serverUrl, ...rest } = input;
        const serverHost = typeof serverUrl === "string" && serverUrl !== "" ? serverHostOf(serverUrl) : "";
        host.logger({
          level: "info",
          ...rest,
          ...(serverHost === "" ? {} : { serverHost })
        });
      };
      // 会话优先落宿主的 owner-scoped 文档存储（跨重启保留）；没有该能力时退化为内存，
      // 而不是伪造一个「看起来持久」的实现。
      const documents = host.services.documents;
      const store = options.store ?? (documents ? createDocumentSessionStore(documents) : createMemorySessionStore());
      /**
       * 「显式启用同步」的待同步集合：与**会话**同一入口（宿主 owner-scoped 文档存储），
       * 没有文档存储时退化为内存。登录不等于上传——只有用户点过「同步远端」的画布才在这里。
       */
      const syncPending = documents ? createDocumentSyncPendingStore(documents) : createMemorySyncPendingStore();

      /** 当前配置的远端基址；未配置返回 null（= 纯本地，不是错误）。 */
      const configuredServerUrl = (): string | null => readDeployment().serverUrl;

      const snapshotOf = (session: RemoteSession | null, extra: Partial<RemoteServerSnapshot> = {}): RemoteServerSnapshot => {
        if (!session) return { ...LOCAL_ONLY_SNAPSHOT, ...extra };
        return {
          phase: "connected",
          serverUrl: session.serverUrl,
          subject: session.subject,
          displayName: session.displayName,
          expiresAt: session.expiresAt,
          methods: [],
          error: null,
          ...extra
        };
      };

      /**
       * **唯一**的会话来源：状态 handler、同步上游、存储后端都读这一份。
       *
       * `ensure()` 允许「没有会话时用部署凭证换一份」——存储后端没有交互入口，而部署凭证本来就是
       * 无人值守场景的凭据；并发调用共享同一次登录（冷启动时三个 RPC 不该换三份会话）。
       */
      const sessionSource = createRemoteSessionSource({
        store,
        configuredServerUrl,
        now,
        loginWithDeviceToken: async (serverUrl) => {
          const deviceToken = readDeployment().deviceToken;
          // 没有部署凭证就**没有**自动换会话的路径：这是配置状态，不是认证失败。
          if (!deviceToken) return { ok: false, code: SESSION_UNCONFIGURED_CODE };
          const result = await exchangeLogin(fetchImpl, now, { serverUrl, credential: deviceToken });
          return result.ok ? { ok: true, session: result.session } : { ok: false, code: result.code };
        },
        /**
         * 会话一变就通知宿主重新解析画布同步上游。
         *
         * 否则「连接成功」只更新了界面状态：宿主在启动时解析过一次上游，之后不会轮询扩展，
         * 画布会继续走静态配置或纯本地——这正是最难排查的一类故障（UI 已连接、画布没同步）。
         * 宿主没提供该能力（纯本地宿主/旧版本）时静默跳过，不影响登录本身。
         */
        onSessionChanged: () => {
          void host.services.canvas.refreshSyncUpstream?.().catch(() => undefined);
          // 服务端托管生成的目录随会话变化收敛（登录后拉目录、登出/切服清空）。
          // 刷新自身绝不抛错；这里再兜一层，避免未处理的 rejection。
          void generationBridge.refresh().catch(() => undefined);
          // 存储后端跟着会话走：登录成功前没有地址（注册被跳过），登录后才该出现；
          // 登出后地址随会话消失（部署配置没配时），后端要撤掉，别留一个打不通的实现。
          void syncStorageBackendWithSession().catch(() => undefined);
        }
      });

      /**
       * 当前**可用**的远端地址：部署配置优先，其次已登录会话（与存储后端同一个判据）。
       *
       * 直接复用 `resolveServerUrl`：地址回落只该有一处定义。凡是「要一个默认目标地址」的入口
       * （登录 / 设备码 / 浏览器登录 / 探测）都走这里——只认部署配置的话，`config.local.json` 一丢
       * 这些入口就以「还没有配置服务端地址」失败，而人明明已经登录过、同步也还在走远端。
       */
      const effectiveServerUrl = async (): Promise<string | null> =>
        resolveServerUrl(readDeployment().serverUrl, await sessionSource.current());

      /**
       * 服务端托管生成的注册与生命周期（change: 2026-10-20-reserve-remote-generation-provider）。
       *
       * 就绪顺序：占位注册（available=false、空目录）→ 有会话后 GetCapabilities/GetCatalog →
       * 原地替换模型。宿主没有生成扩展点时安静跳过（纯本地宿主/旧版本），不影响接入本身。
       */
      const generationBridge = createRemoteGenerationBridge({
        ...(host.registerGeneration ? { registerGeneration: host.registerGeneration } : {}),
        session: () => sessionSource.current(),
        fetchImpl,
        log,
        ...(options.generation?.pollIntervalMs !== undefined ? { pollIntervalMs: options.generation.pollIntervalMs } : {}),
        ...(options.generation?.clientTimeoutMs !== undefined ? { clientTimeoutMs: options.generation.clientTimeoutMs } : {})
      });
      generationBridge.activate();
      // 已有会话（本进程登录过或从文档存储恢复）时立即拉一次目录；没有会话就是安静休眠。
      void generationBridge.refresh().catch(() => undefined);

      // 遥测上报出口（change: 2026-10-20-add-local-client-telemetry，tasks 7.3/7.4）。
      // 与存储后端同形：谁注册谁收回。宿主没有遥测能力时（纯本地宿主/旧版本）静默跳过，
      // 不把它当成激活失败——上报本来就只是 best-effort。
      // 开关在宿主设置 `telemetry.export.enabled`（core 只管发不发），目的地就是这里的部署地址。
      host.registerTelemetryExport?.(
        createRemoteTelemetryExport({
          sessionSource,
          fetchImpl,
          log
        })
      );

      /** 当前会话的同步范围：远端地址 + 主体。待同步集合与远端目录缓存都按它隔离。 */
      const syncScopeOf = (session: RemoteSession): RemoteSyncScope => ({
        serverUrl: session.serverUrl,
        subject: session.subject
      });

      /**
       * 远端目录缓存（按会话维度隔离）。
       *
       * 为什么要缓存：`resolve()` 对每个已加载 room 都会调用，命中缓存才不必每张画布都发一次
       * `ListMyCanvases`；而「目录没列过、直接打开画布」时又必须自己能列一次，否则会把
       * 「未知」误判成「不在远端」，让本该自动同步的远端画布掉回本地。
       */
      let remoteCatalog: { scopeKey: string; ids: Set<string> } | null = null;
      /** 进行中的目录列举：多个 room 同时解析时共享同一次请求。 */
      let remoteCatalogInFlight: { scopeKey: string; promise: Promise<Set<string> | null> } | null = null;

      const catalogScopeKey = (scope: RemoteSyncScope): string => JSON.stringify([scope.serverUrl, scope.subject]);

      /**
       * 列一次远端目录。
       *
       * 失败返回 `null` 而不是空数组：调用方要能区分「远端确实没有画布」与「这次没列到」——
       * 后者必须保持旧缓存（远端暂时不可达不等于画布被删了）。
       */
      const fetchRemoteCanvases = async (session: RemoteSession): Promise<RemoteCanvasSummary[] | null> => {
        const result = await callConnect<{
          canvases?: Array<{
            canvasId?: string;
            title?: string;
            state?: string;
            createdAt?: string;
            updatedAt?: string;
            allowedActions?: string[];
            role?: string;
            isOwner?: boolean;
          }>;
        }>(fetchImpl, session.serverUrl, connectProcedurePath(CANVAS_SERVICE, "ListMyCanvases"), {}, { token: session.token });
        if (!result.ok) return null;
        return (result.value.canvases ?? [])
          .filter((canvas) => typeof canvas.canvasId === "string" && canvas.canvasId !== "")
          .map((canvas) => {
            const access = accessFromCanvas(canvas as Record<string, unknown>);
            return {
              id: canvas.canvasId as string,
              title: canvas.title ?? "",
              // 远端不提供本地 revision 的确切含义；目录只用它做展示与乐观校验，
              // 内容以同步链路为准。
              revision: 0,
              updatedAt: canvas.updatedAt ?? canvas.createdAt ?? new Date(0).toISOString(),
              ...(canvas.createdAt === undefined ? {} : { createdAt: canvas.createdAt }),
              ...(access === undefined ? {} : { access })
            };
          });
      };

      /**
       * 把远端目录已经确认存在的画布从待同步集合里移除（并持久化）。
       *
       * 一旦目录里有这个 id，它就已经是普通远端画布：自动同步不再需要「显式启用」这层标记。
       * 写失败不影响调用方——最坏只是多留一条已无意义的标记，下次成功列目录时再清。
       */
      const pruneConfirmedSynced = async (scope: RemoteSyncScope, remoteIds: Iterable<string>): Promise<void> => {
        try {
          await syncPending.removeMany(scope, remoteIds);
        } catch {
          // 集合写不进存储不该让目录或同步解析失败。
        }
      };

      /** 记住一次成功的目录结果：更新缓存并清理已确认同步的标记。 */
      const rememberRemoteCatalog = async (
        session: RemoteSession,
        canvases: readonly RemoteCanvasSummary[]
      ): Promise<ReadonlySet<string>> => {
        const scope = syncScopeOf(session);
        const ids = new Set(canvases.map((canvas) => canvas.id));
        remoteCatalog = { scopeKey: catalogScopeKey(scope), ids };
        await pruneConfirmedSynced(scope, ids);
        return ids;
      };

      /**
       * 当前会话的远端 id 集合。
       *
       * 缓存为空 / 换了会话 / 还没列过时自己列一次；列失败保持旧缓存并给出空集合，
       * 由调用方回落到待同步集合判断。
       */
      const remoteCanvasIds = async (session: RemoteSession): Promise<ReadonlySet<string>> => {
        const scope = syncScopeOf(session);
        const key = catalogScopeKey(scope);
        if (remoteCatalog !== null && remoteCatalog.scopeKey === key && remoteCatalog.ids.size > 0) {
          return remoteCatalog.ids;
        }
        const inFlight =
          remoteCatalogInFlight !== null && remoteCatalogInFlight.scopeKey === key
            ? remoteCatalogInFlight
            : (remoteCatalogInFlight = {
                scopeKey: key,
                promise: (async () => {
                  const canvases = await fetchRemoteCanvases(session);
                  // 列举失败保持旧缓存：远端暂时不可达，不等于画布被删了。
                  if (canvases === null) return null;
                  return new Set(await rememberRemoteCatalog(session, canvases));
                })()
              });
        let listed: Set<string> | null = null;
        try {
          listed = await inFlight.promise;
        } catch {
          // 列举异常按「这次没答案」处理：`resolve` 的契约是不得抛错，宿主据此回落静态配置。
          listed = null;
        } finally {
          if (remoteCatalogInFlight === inFlight) remoteCatalogInFlight = null;
        }
        if (listed !== null) return listed;
        return remoteCatalog !== null && remoteCatalog.scopeKey === key ? remoteCatalog.ids : new Set<string>();
      };

      /**
       * 把已登录会话交给画布同步上游（capability 交接面）。
       *
       * 这是「一键接入」真正生效的一步：只登录不改同步链路，用户会以为接上了却什么都没变。
       * 宿主按 `canvas-upstream:<id>` 声明解析，不认识本扩展 id；没有会话时返回 null，
       * 宿主回落到 `canvas.syncUpstream.*` 静态配置（= 纯本地），不会因为没登录就断了同步。
       *
       * 但**登录不等于上传**：解析按画布逐个回答，只有「已在远端目录里」或「用户显式启用过」
       * 的画布才拿到链路；其余本地画布返回 null，宿主保持纯本地。
       */
      const upstreamProvider: CanvasUpstreamProvider = {
        providerId: REMOTE_SERVER_EXTENSION_ID,
        async resolve(canvasId: string): Promise<CanvasUpstreamLink | null> {
          const session = await sessionSource.current();
          if (!session) {
            // 没有会话是正常形态（= 纯本地），不是错误：用 debug 级别，别在界面上冒充故障。
            log({
              event: "remote-upstream-unavailable",
              level: "debug",
              reason: "没有可用会话，同步上游回落到本地配置",
              serverUrl: configuredServerUrl()
            });
            return null;
          }
          const scope = syncScopeOf(session);
          const remoteIds = await remoteCanvasIds(session);
          // a) 画布已经在远端目录里：它就是一张普通远端画布，重连时自动同步，无需再次确认。
          if (remoteIds.has(canvasId)) {
            // 顺手清掉「显式启用」标记：首次推送已经完成，这条标记不再有信息量。
            await pruneConfirmedSynced(scope, new Set([canvasId]));
            log({ event: "remote-upstream-resolved", serverUrl: session.serverUrl });
            return { url: toWsBase(session.serverUrl), token: session.token };
          }
          // b) 用户显式启用过这张本地画布：远端目录里可能还没出现（首次推送尚未完成）。
          //
          // 从链接打开的共享画布走的也是这条：按 id 取摘要时（getCanvas）已经把 id 写进
          // 同一份待同步集合——「拿到链接并主动打开」就是用户对这张画布使用上游的明确
          // 同意，与点「同步远端」同义。因此这里不需要第三条「链接画布」通道。
          //
          // 撤销分享后这条本地标记仍然可能存在（待同步集合按会话持久化，登出不删），
          // 但授权是服务端**逐帧现判**的，不缓存结论：中继会拒绝后续读写帧，本地这份
          // 标记变旧不会绕过权限。
          if (await syncPending.has(scope, canvasId)) {
            log({ event: "remote-upstream-resolved", serverUrl: session.serverUrl });
            return { url: toWsBase(session.serverUrl), token: session.token };
          }
          // c) 缺省：登录 ≠ 上传。这张画布保持本地，宿主按静态配置/纯本地同步。
          log({
            event: "remote-upstream-local",
            level: "debug",
            reason: "画布未启用远端同步，保持本地",
            serverUrl: session.serverUrl
          });
          return null;
        },
        describe(): string {
          const serverUrl = configuredServerUrl();
          // 来源名会经宿主进入浏览器目录（显示"这份列表还包含谁"），因此只放主机名，
          // 不带令牌、不带路径。
          if (serverUrl === null) return "远端";
          try {
            return `远端 ${new URL(serverUrl).host}`;
          } catch {
            return "远端";
          }
        },
        /**
         * 远端可见的画布（目录合并用）。
         *
         * 失败返回空数组而不是抛错：目录是"有哪些画布"，远端不可达不该让整份列表
         * 消失——本地部分仍然可用。这与同步上游"不可用就回落静态配置"同一口径。
         */
        async listCanvases(): Promise<RemoteCanvasSummary[]> {
          const session = await sessionSource.current();
          if (!session) return [];
          const canvases = await fetchRemoteCanvases(session);
          // 失败只影响这次目录，**不**动旧缓存：远端暂时不可达不等于画布被删了。
          if (canvases === null) return [];
          // 成功才更新缓存：目录同时是同步门控的事实来源，顺手清理已确认同步的标记。
          await rememberRemoteCatalog(session, canvases);
          return canvases;
        },
        /**
         * 按 id 取一张**不在我目录里**的远端画布摘要（链接打开的入口）。
         *
         * 链接分享不会让画布进入对方目录（ListMyCanvases 仍然只认作者与协作者），所以
         * 「拿到链接的人按 id 打开」必须有一条独立的按 id 读取路径，否则目录里补不出条目、
         * 中继也不知道该不该为它连上游。
         *
         * 失败一律返回 null 而不是抛错（契约要求）：链接过期、作者撤销分享、画布被删、
         * 远端抖动都会走到这里，界面把它当成「这张画布打不开」，不是一次服务故障。
         *
         * **成功后把 id 写进待同步集合**：这次按 id 的访问就是用户对这张画布使用上游的
         * 明确同意（与点「同步远端」同义）。集合与「显式启用同步」共用、按会话持久化，
         * 因此重启后 resolve 仍然放行——若只记内存，重启后这张画布会被当成本地画布，
         * 静默停在陈旧内容上。写入失败只记诊断、不影响打开：最坏是多打开一次。
         */
        /**
         * 回答「调用者能不能读/写这张画布」。
         *
         * 单独一条而不是让宿主从 `getCanvas` 里猜：没权限时 `GetCanvas` 直接返回
         * permission_denied，而 `getCanvas` 的契约是"取不到就是 null"——宿主需要知道
         * "被拒绝"和"这次没答案"的区别，否则进入画布时只能沉默。
         *
         * 只读链接 / viewer 协作者能读不能写（`allowedActions` 不含 canvas.write），
         * 这也是一种"有答案的只读"，同样返回 canWrite=false。
         */
        async access(canvasId: string): Promise<CanvasAccess | null> {
          const session = await sessionSource.current();
          if (!session) return null;
          if (!isBoundedId(canvasId)) return null;
          const fetched = await callConnect<{ canvas?: Record<string, unknown> }>(
            fetchImpl,
            session.serverUrl,
            connectProcedurePath(CANVAS_SERVICE, "GetCanvas"),
            { canvasId },
            { token: session.token }
          );
          if (!fetched.ok) {
            // 明确被拒绝：这是"能回答"的答案（读不到，自然也写不了），不是"没答案"。
            if (fetched.code === "permission_denied") return { canRead: false, canWrite: false };
            if (fetched.code === "not_found") return null;
            log({
              event: "remote-canvas-access-unavailable",
              level: "debug",
              code: fetched.code,
              reason: "读取画布权限失败",
              serverUrl: session.serverUrl,
              status: fetched.status
            });
            return null;
          }
          return accessFromCanvas(fetched.value?.canvas ?? {}) ?? null;
        },
        async getCanvas(canvasId: string): Promise<RemoteCanvasSummary | null> {
          const session = await sessionSource.current();
          if (!session) return null;
          const fetched = await callConnect<{ canvas?: Record<string, unknown> }>(
            fetchImpl,
            session.serverUrl,
            connectProcedurePath(CANVAS_SERVICE, "GetCanvas"),
            { canvasId },
            { token: session.token }
          );
          if (!fetched.ok) {
            log({
              event: "remote-canvas-link-failed",
              level: "debug",
              code: fetched.code,
              reason: "按 id 取远端画布失败",
              serverUrl: session.serverUrl,
              status: fetched.status
            });
            return null;
          }
          const canvas = fetched.value?.canvas ?? {};
          const createdAt = readString(canvas, "createdAt");
          try {
            await syncPending.add(syncScopeOf(session), canvasId);
          } catch {
            // 待同步集合是同步意图的载体而不是打开动作的前提：写不进存储时仍然返回摘要。
            log({
              event: "remote-canvas-link-persist-failed",
              level: "warn",
              code: "storage",
              reason: "链接画布写入待同步集合失败",
              serverUrl: session.serverUrl
            });
          }
          log({ event: "remote-canvas-link-open", level: "debug", serverUrl: session.serverUrl });
          const access = accessFromCanvas(canvas);
          return {
            id: canvasId,
            title: readString(canvas, "title") ?? "",
            // 远端不提供本地 revision 的确切含义；目录只用它做展示与乐观校验，
            // 内容以同步链路为准。
            revision: 0,
            updatedAt: readString(canvas, "updatedAt") ?? createdAt ?? new Date(0).toISOString(),
            ...(createdAt === null ? {} : { createdAt }),
            ...(access === undefined ? {} : { access })
          };
        }
      };
      host.registerCapability({
        id: canvasUpstreamCapabilityId(REMOTE_SERVER_EXTENSION_ID),
        value: upstreamProvider
      });

      host.registerHandler({
        route: REMOTE_SERVER_SESSION_ROUTE,
        auth: "authenticated",
        purpose: "read",
        handle: async () => {
          const session = await sessionSource.current();
          const serverUrl = configuredServerUrl();
          if (!session) {
            return {
              status: 200,
              body: { ...snapshotOf(null, { serverUrl }), ...(serverUrl === null ? {} : { phase: "local" as const }) }
            };
          }
          return { status: 200, body: snapshotOf(session) };
        }
      });

      host.registerHandler({
        route: REMOTE_SERVER_PROBE_ROUTE,
        auth: "authenticated",
        purpose: "read",
        handle: async (input) => {
          // 探测可以带一个临时地址（「先试试再保存」），也可以不给——那就用「当前在用的地址」，
          // 已登录时它是会话里那个服务端，而不是要求人先把地址写进配置文件。
          const requested = readString(input.body, "serverUrl");
          const parsed = parseServerUrl(requested ?? (await effectiveServerUrl()));
          if (!parsed.ok) {
            log({ event: "remote-probe-failed", level: "warn", code: "invalid_argument", reason: parsed.message });
            return { status: 400, body: { ok: false, error: parsed.message } };
          }
          const serverUrl = parsed.value;
          log({ event: "remote-probe-start", serverUrl });

          const info = await callConnect(fetchImpl, serverUrl, connectProcedurePath(OPS_SERVICE, "GetServerInfo"), {});
          if (!info.ok) {
            log({
              event: "remote-probe-failed",
              level: "warn",
              code: info.code,
              reason: info.message,
              serverUrl,
              status: info.status
            });
            return { status: 200, body: { ok: false, error: info.message } };
          }
          const methods = await callConnect(fetchImpl, serverUrl, connectProcedurePath(IDENTITY_SERVICE, "GetAuthMethods"), {});
          if (!methods.ok) {
            log({
              event: "remote-probe-failed",
              level: "warn",
              code: methods.code,
              reason: methods.message,
              serverUrl,
              status: methods.status
            });
            return { status: 200, body: { ok: false, error: methods.message } };
          }
          log({ event: "remote-probe-ok", serverUrl });
          return {
            status: 200,
            body: {
              ok: true,
              serverUrl,
              version: readString(info.value, "version") ?? "",
              commit: readString(info.value, "commit") ?? "",
              methods: decodeAuthMethods(methods.value)
            }
          };
        }
      });

      /**
       * 登录：**用接入端已有的身份**换远端会话。
       *
       * 凭证来源按「环境替你决定」优先于「你手填」排序——这与远端 `resolveLogin` 的注释一致，
       * 但方向相反，原因是产品意图不同：接入服务端时人已经在企业网关后面，要求他再手填
       * 一个部署令牌是多余的门槛。真值顺序：
       *   1. 浏览器带来的**网关断言**（适配器显式允许的头）→ 原样转发给远端 `Login`；
       *   2. 请求体里的一次性令牌（用户显式输入，优先于部署配置）；
       *   3. 部署配置里的设备凭证（无人值守/自动化场景）。
       * 远端对三者用同一条解析路径，我们只负责把可信的那份递过去。
       */
      const performLogin = async (input: {
        serverUrl: string;
        gatewayHeaders: Record<string, string>;
        bodyToken?: string;
      }): Promise<{ ok: true; snapshot: RemoteServerSnapshot } | { ok: false; error: string }> => {
        const configuredToken = readDeployment().deviceToken;
        const bodyToken = typeof input.bodyToken === "string" && input.bodyToken.trim() !== ""
          ? input.bodyToken.trim()
          : undefined;
        // 用户显式输入优先于部署配置：前者表达「我现在就要用这个」，后者只是缺省值。
        const credential = bodyToken ?? configuredToken ?? undefined;
        // 只记「用了哪条凭证路径」，不记凭证本身——网关断言与令牌都是凭据。
        const method =
          Object.keys(input.gatewayHeaders).length > 0 ? "gateway" : credential !== undefined ? "token" : "none";
        log({ event: "remote-login-start", serverUrl: input.serverUrl, method });
        const result = await exchangeLogin(fetchImpl, now, {
          serverUrl: input.serverUrl,
          ...(credential !== undefined ? { credential } : {}),
          ...(Object.keys(input.gatewayHeaders).length > 0 ? { gatewayHeaders: input.gatewayHeaders } : {})
        });
        if (!result.ok) {
          log({
            event: "remote-login-failed",
            level: "warn",
            code: result.code,
            reason: result.message,
            serverUrl: input.serverUrl,
            method
          });
          return { ok: false, error: result.message };
        }
        await sessionSource.save(result.session);

        const methodsResult = await callConnect<unknown>(
          fetchImpl,
          input.serverUrl,
          connectProcedurePath(IDENTITY_SERVICE, "GetAuthMethods"),
          {}
        );
        log({ event: "remote-login-ok", serverUrl: input.serverUrl, method });
        return {
          ok: true,
          snapshot: snapshotOf(result.session, {
            methods: methodsResult.ok ? decodeAuthMethods(methodsResult.value) : []
          })
        };
      };

      /**
       * 从请求体与「当前可用地址」解析目标地址（两者都没有时给稳定错误）。
       *
       * 缺省值取部署配置或已登录会话：会话里的地址是登录时由人认可、随后持久化的那个，
       * 在配置文件丢失（换 checkout、被清理）时仍然是对的默认目标。
       */
      const resolveTarget = async (rawServerUrl: unknown): Promise<{ ok: true; value: string } | { ok: false; status: number; error: string }> => {
        const explicit = typeof rawServerUrl === "string" && rawServerUrl.trim() !== "" ? rawServerUrl : undefined;
        const parsed = parseServerUrl(explicit ?? (await effectiveServerUrl()));
        return parsed.ok ? parsed : { ok: false, status: 400, error: parsed.message };
      };

      /**
       * 原始 HTTP 入口：**一键登录**走这条。
       *
       * 只有原始 handler 能读到请求头（DTO handler 的 context 不带 headers），而网关断言就在头里。
       * 浏览器不需要任何输入，宿主把它已有的断言转发给远端即可。
       */
      host.registerRawHttpHandler?.({
        route: REMOTE_SERVER_LOGIN_ROUTE,
        method: "POST",
        auth: "authenticated",
        purpose: "new-work",
        handle: async (req, res) => {
          const wrote = (status: number, payload: unknown): void => {
            res.statusCode = status;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify(payload));
          };
          const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
          const target = await resolveTarget((body as { serverUrl?: unknown }).serverUrl);
          if (!target.ok) return wrote(target.status, { ok: false, error: target.error });

          const result = await performLogin({
            serverUrl: target.value,
            gatewayHeaders: pickLoginAssertionHeaders(req.headers, options.loginAssertionHeaders),
            ...(typeof (body as { token?: unknown }).token === "string"
              ? { bodyToken: (body as { token: string }).token }
              : {})
          });
          wrote(200, result);
        }
      });

      // DTO 入口保留：没有网关的环境（本机自测、自动化）用请求体令牌登录。
      host.registerHandler({
        route: REMOTE_SERVER_LOGIN_ROUTE,
        auth: "authenticated",
        purpose: "new-work",
        handle: async (input) => {
          const body = (input.body ?? {}) as RemoteServerLoginInput;
          const target = await resolveTarget(body.serverUrl);
          if (!target.ok) return { status: target.status, body: { ok: false, error: target.error } };
          // DTO 入口拿不到 headers，因此只可能是「配置凭证 / 请求体令牌」两条路。
          const result = await performLogin({
            serverUrl: target.value,
            gatewayHeaders: {},
            ...(typeof body.token === "string" ? { bodyToken: body.token } : {})
          });
          return { status: 200, body: result };
        }
      });

      /**
       * 发起设备码登录（「一键接入」的主路径）。
       *
       * 客户端拿不到浏览器里的登录态，服务端也没有开放的登录入口给客户端用——所以走
       * 设备码：客户端发起并显示短码，人在**服务端的登录页**上批准，客户端轮询拿到会话。
       *
       * 令牌全程只在本机宿主与服务端之间；浏览器只会看到短码与批准页地址。
       */
      host.registerHandler({
        route: REMOTE_SERVER_DEVICE_START_ROUTE,
        auth: "authenticated",
        purpose: "new-work",
        handle: async (input) => {
          const target = await resolveTarget(readString(input.body, "serverUrl"));
          if (!target.ok) {
            log({
              event: "remote-device-start-failed",
              level: "warn",
              code: "invalid_argument",
              reason: target.error
            });
            return { status: target.status, body: { ok: false, error: target.error } };
          }
          log({ event: "remote-device-start", serverUrl: target.value });

          const started = await callConnect<unknown>(
            fetchImpl,
            target.value,
            connectProcedurePath(IDENTITY_SERVICE, "StartDeviceLogin"),
            {}
          );
          if (!started.ok) {
            // 服务端未启用设备码登录时这里是 `unimplemented`。把它翻成一句可行动的话，
            // 而不是把远端的状态码直接丢给界面。
            const disabled = started.code === "unimplemented" || started.status === 501;
            log({
              event: "remote-device-start-failed",
              level: "warn",
              code: disabled ? "unimplemented" : started.code,
              reason: started.message,
              serverUrl: target.value,
              status: started.status
            });
            return {
              status: 200,
              body: {
                ok: false,
                error: disabled
                  ? "这台服务端没有启用设备码登录（需要配置对外地址）"
                  : started.message
              }
            };
          }

          const deviceCode = readString(started.value, "deviceCode");
          const userCode = readString(started.value, "userCode");
          const verificationUri = readString(started.value, "verificationUri");
          if (!deviceCode || !userCode || !verificationUri) {
            log({
              event: "remote-device-start-failed",
              level: "warn",
              code: "invalid_response",
              reason: "远端返回的设备码形状不符",
              serverUrl: target.value
            });
            return { status: 200, body: { ok: false, error: "远端返回的设备码形状不符" } };
          }

          const expiresAt = parseSessionExpiry(readString(started.value, "expiresAt"), now());
          // 先记下设备码再返回：轮询要靠它，而它绝不回给浏览器。
          pendingDeviceLogin = { serverUrl: target.value, deviceCode, expiresAt };
          log({ event: "remote-device-pending", serverUrl: target.value, reason: "已发出设备码，等待批准" });

          return {
            status: 200,
            body: {
              ok: true,
              userCode,
              verificationUri,
              intervalMs: Math.max(1, readNumber(started.value, "intervalSeconds") ?? 5) * 1000,
              expiresAt
            } satisfies RemoteDeviceLoginStart & { ok: true }
          };
        }
      });

      /**
       * 轮询一次设备码登录。
       *
       * 已批准时服务端**恰好交付一次**会话：这里立刻落库并把状态收敛成 `connected`，
       * 之后同一份设备码再也取不到令牌（远端会回 `expired`）。
       */
      host.registerHandler({
        route: REMOTE_SERVER_DEVICE_POLL_ROUTE,
        auth: "authenticated",
        purpose: "read",
        handle: async () => {
          const pending = pendingDeviceLogin;
          if (!pending) {
            log({ event: "remote-device-expired", level: "debug", reason: "没有进行中的设备码登录" });
            return { status: 200, body: { state: "expired" } };
          }
          if (pending.expiresAt <= now()) {
            pendingDeviceLogin = null;
            log({ event: "remote-device-expired", level: "warn", reason: "设备码已过期", serverUrl: pending.serverUrl });
            return { status: 200, body: { state: "expired" } };
          }

          const polled = await callConnect<unknown>(
            fetchImpl,
            pending.serverUrl,
            connectProcedurePath(IDENTITY_SERVICE, "PollDeviceLogin"),
            { deviceCode: pending.deviceCode }
          );
          if (!polled.ok) {
            // 网络失败不是终态：让调用方继续按间隔轮询，别把一次抖动说成登录失败。
            log({
              event: "remote-device-pending",
              level: "debug",
              code: polled.code,
              reason: polled.message,
              serverUrl: pending.serverUrl,
              status: polled.status
            });
            return { status: 200, body: { state: "pending" } };
          }

          const state = readString(polled.value, "state") ?? "";
          if (state === "DEVICE_LOGIN_STATE_PENDING" || state === "DEVICE_LOGIN_STATE_UNSPECIFIED") {
            log({ event: "remote-device-pending", level: "debug", serverUrl: pending.serverUrl });
            return { status: 200, body: { state: "pending" } };
          }
          if (state === "DEVICE_LOGIN_STATE_DENIED") {
            pendingDeviceLogin = null;
            log({ event: "remote-device-denied", level: "warn", serverUrl: pending.serverUrl });
            return { status: 200, body: { state: "denied" } };
          }
          if (state !== "DEVICE_LOGIN_STATE_APPROVED") {
            pendingDeviceLogin = null;
            log({
              event: "remote-device-expired",
              level: "warn",
              reason: "设备码状态未知，按过期处理",
              serverUrl: pending.serverUrl
            });
            return { status: 200, body: { state: "expired" } };
          }

          // 已批准：会话在这一刻才签发，且只来一次。
          pendingDeviceLogin = null;
          const token = readString(polled.value, "sessionToken");
          if (!token) {
            log({
              event: "remote-device-expired",
              level: "warn",
              code: "invalid_response",
              reason: "远端批准了设备码却没有返回会话",
              serverUrl: pending.serverUrl
            });
            return { status: 200, body: { state: "expired" } };
          }

          const who = await callConnect<unknown>(
            fetchImpl,
            pending.serverUrl,
            connectProcedurePath(IDENTITY_SERVICE, "WhoAmI"),
            {},
            { token }
          );
          if (!who.ok) {
            log({
              event: "remote-device-expired",
              level: "warn",
              code: who.code,
              reason: who.message,
              serverUrl: pending.serverUrl,
              status: who.status
            });
            return { status: 200, body: { state: "expired" } };
          }

          const session: RemoteSession = {
            serverUrl: pending.serverUrl,
            token,
            subject: readString(who.value, "subjectId") ?? "",
            displayName: null,
            expiresAt: parseSessionExpiry(readString(who.value, "expiresAt"), now())
          };
          await sessionSource.save(session);
          log({ event: "remote-device-approved", serverUrl: pending.serverUrl });
          return { status: 200, body: { state: "approved", snapshot: snapshotOf(session) } };
        }
      });

      /**
       * 浏览器授权码登录（OAuth 授权码 + PKCE + loopback 回调）。
       *
       * 与设备码的关系：浏览器与本机宿主同机时这是默认路径（一步完成统一登录），设备码保留为
       * 兜底。宿主没有公开 HTTP 回调接缝（旧版本）时 oauth-start 直接回 unsupported，面板据此
       * 立刻改走短码——不把「宿主没这个能力」表现成一次登录失败。
       *
       * 授权码、state 与 verifier 都只在本进程内：回调在服务端换码、落会话，页面拿不到任何凭据。
       */
      const oauthLogin = createOAuthLogin({
        now,
        fetchImpl,
        // 浏览器登录同样要能在「部署文件丢了、但已经登录过」时重新走一遍。
        configuredServerUrl: effectiveServerUrl,
        sessionSource,
        snapshotOf: (session) => snapshotOf(session),
        basePath: () => host.deployment?.basePath ?? "",
        rawHttpAvailable: typeof host.registerRawHttpHandler === "function",
        log
      });

      host.registerHandler({
        route: REMOTE_SERVER_OAUTH_START_ROUTE,
        auth: "authenticated",
        purpose: "new-work",
        handle: async (input) => oauthLogin.start(input.body)
      });

      host.registerHandler({
        route: REMOTE_SERVER_OAUTH_POLL_ROUTE,
        auth: "authenticated",
        purpose: "read",
        handle: async (input) => oauthLogin.poll(input.body)
      });

      /**
       * 公开回调路由（extension.json 的 publicRoutes 把 /api/remote-server 映射到这里）。
       *
       * auth 必须是 public：浏览器被服务端 302 过来时是顶层导航，不带宿主的会话凭据。
       * 这条路由的安全性来自 state（一次性、进程内）与 PKCE，而不是宿主会话。
       */
      host.registerRawHttpHandler?.({
        route: REMOTE_SERVER_OAUTH_CALLBACK_ROUTE,
        method: "GET",
        auth: "public",
        purpose: "read",
        handle: (req, res) => oauthLogin.handleCallback(req, res)
      });
      host.registerRawHttpHandler?.({
        route: REMOTE_SERVER_OAUTH_DONE_ROUTE,
        method: "GET",
        auth: "public",
        purpose: "read",
        handle: (req, res) => oauthLogin.handleDone(req, res)
      });

      host.registerHandler({
        route: REMOTE_SERVER_LOGOUT_ROUTE,
        auth: "authenticated",
        purpose: "work-control",
        handle: async () => {
          const session = await store.load();
          // 幂等：没有会话也算登出成功——调用方要的是「现在不在登录态」。
          if (!isSessionUsable(session, now())) {
            await sessionSource.save(null);
            log({ event: "remote-logout-ok", level: "debug", reason: "本来就没有可用会话" });
            return { status: 200, body: { ok: true } };
          }
          // 先尽力撤销远端会话；撤销失败仍然清本地，否则界面会卡在一个撤不掉的登录态。
          const result = await callConnect(fetchImpl, session.serverUrl, connectProcedurePath(IDENTITY_SERVICE, "Logout"), {
            // proto 字段是 session_token；Connect 的 JSON 编解码用 lowerCamelCase。
            sessionToken: session.token
          }, { token: session.token });
          await sessionSource.save(null);
          if (!result.ok) {
            log({
              event: "remote-logout-failed",
              level: "warn",
              code: result.code,
              reason: result.message,
              serverUrl: session.serverUrl,
              status: result.status
            });
            return { status: 200, body: { ok: false, error: result.message } };
          }
          log({ event: "remote-logout-ok", serverUrl: session.serverUrl });
          return { status: 200, body: { ok: true } };
        }
      });

      /**
       * 显式把一张**本地**画布启用为「同步到远端」。
       *
       * 这是「登录 ≠ 上传」的出口：登录只说明远端可用，上传哪张画布由用户逐张决定。启用后
       * 宿主收到一次重新解析通知，该画布的中继连接由纯本地切到远端；首次推送完成、远端目录
       * 出现这个 id 后，待同步标记被清掉，此后按普通远端画布自动同步。
       *
       * 集合按会话（serverUrl + subject）隔离并持久化：登出**不删除**（同一账号重连后还要
       * 继续完成首次同步），换账号/换地址则不串用。文档里只有画布 id，没有凭据。
       */
      host.registerHandler({
        route: REMOTE_SERVER_SYNC_ENABLE_ROUTE,
        auth: "authenticated",
        purpose: "new-work",
        handle: async (input) => {
          const canvasId = readString(input.body, "canvasId");
          // 浏览器可控输入：空值/超长 id 在写进文档存储之前就拒绝。
          if (!isBoundedId(canvasId)) {
            log({
              event: "remote-sync-enable-rejected",
              level: "warn",
              code: "invalid_argument",
              reason: "画布 id 非法"
            });
            return { status: 400, body: { ok: false, error: "画布 id 非法" } };
          }
          const session = await sessionSource.current();
          if (!session) {
            // 没连接不是 5xx：这是可以照做的状态（先去连服务端），与上报/登出同一口径。
            log({
              event: "remote-sync-enable-rejected",
              level: "warn",
              code: "unconfigured",
              reason: "没有可用的服务端会话"
            });
            return { status: 200, body: { ok: false, error: "未连接服务端" } };
          }
          try {
            await syncPending.add(syncScopeOf(session), canvasId);
          } catch {
            // 写不进存储就不能说「已启用」：否则界面显示成功、重启后画布又回到本地。
            log({
              event: "remote-sync-enable-failed",
              level: "warn",
              code: "storage",
              reason: "待同步集合写入失败",
              serverUrl: session.serverUrl
            });
            return { status: 200, body: { ok: false, error: "无法保存同步状态" } };
          }
          log({ event: "remote-sync-enable", serverUrl: session.serverUrl });
          // 立刻让宿主重新解析：点了「同步远端」就必须真的切过去，不能等下次登录/重启。
          // 宿主没提供该能力时静默跳过；刷新失败也不回滚启用意图（它已持久化，下次解析会补上）。
          try {
            await host.services.canvas.refreshSyncUpstream?.();
          } catch {
            // 刷新失败只影响这一次生效时机，不影响「已启用」这个事实。
          }
          // 文档链路建立后显式对账一次媒体字节：这是「同步远端」这个动作的另一半。
          // 进度由目录徽标（syncing → synced/failed）表达，接口本身不阻塞等资产传完。
          try {
            host.services.canvas.syncCanvasMedia?.(canvasId);
          } catch {
            // 媒体补传失败不影响「已启用同步」；状态与重试由宿主侧负责。
          }
          return { status: 200, body: { ok: true } };
        }
      });

      /**
       * 画布协作者的读写（画布维度 ACL）。
       *
       * 为什么由宿主代发：令牌只在宿主（B1/B3），远端零 CORS。这里只做形状校验、错误短语与
       * 字段裁剪，**不重算授权**——谁能改成员由服务端按「作者 canvas.share 或部署管理员
       * canvas.manage」现算，界面只按返回的 `canManage` 决定是否显示写操作。作者身份同理：
       * 以 GetCanvas 的 createdBy / isOwner 为准，不靠名单里有没有自己推断。
       */
      const readCanvasAccess = async (
        session: RemoteSession,
        canvasId: string
      ): Promise<
        | {
            ok: true;
            access: { owner: string; isOwner: boolean; role: "viewer" | "editor"; canManage: boolean; canShare: boolean };
          }
        | { ok: false; error: string }
      > => {
        const fetched = await callConnect<{ canvas?: Record<string, unknown> }>(
          fetchImpl,
          session.serverUrl,
          connectProcedurePath(CANVAS_SERVICE, "GetCanvas"),
          { canvasId },
          { token: session.token }
        );
        if (!fetched.ok) return { ok: false, error: memberErrorText(fetched.code) };
        const canvas = fetched.value?.canvas ?? {};
        const allowed = Array.isArray(canvas.allowedActions)
          ? canvas.allowedActions.filter((action): action is string => typeof action === "string")
          : [];
        const isOwner = canvas.isOwner === true;
        const role = canvasRoleFromProto(canvas.role) ?? (isOwner ? "editor" : "viewer");
        return {
          ok: true,
          access: {
            owner: readString(canvas, "createdBy") ?? "",
            isOwner,
            role,
            // 成员代管：作者或部署管理员（canvas.share / canvas.manage）。
            canManage: allowed.includes("canvas.share") || allowed.includes("canvas.manage"),
            // 分享设置：只属于作者。管理员有 canvas.manage，但没有 canvas.share——服务端
            // 的 UpdateCanvasShare 也只认作者，界面不能把"能代管成员"画成"能改分享"。
            canShare: allowed.includes("canvas.share")
          }
        };
      };

      host.registerHandler({
        route: REMOTE_SERVER_CANVAS_MEMBERS_ROUTE,
        auth: "authenticated",
        purpose: "read",
        handle: async (input) => {
          const canvasId = readString(input.body, "canvasId");
          if (!isBoundedId(canvasId)) return { status: 400, body: { ok: false, error: "画布 id 非法" } };
          const session = await sessionSource.current();
          if (!session) return { status: 200, body: { ok: false, error: "未连接服务端" } };
          const access = await readCanvasAccess(session, canvasId);
          if (!access.ok) return { status: 200, body: { ok: false, error: access.error } };
          const listed = await callConnect<{ owner?: string; members?: unknown[] }>(
            fetchImpl,
            session.serverUrl,
            connectProcedurePath(CANVAS_SERVICE, "ListCanvasMembers"),
            { canvasId },
            { token: session.token }
          );
          if (!listed.ok) return { status: 200, body: { ok: false, error: memberErrorText(listed.code) } };
          const members = (Array.isArray(listed.value?.members) ? listed.value.members : [])
            .map(mapCanvasMember)
            .filter((member): member is RemoteCanvasMember => member !== null);
          return {
            status: 200,
            body: {
              ok: true,
              canvasId,
              // 名单里的 owner 在"非作者视角"下可能被服务端省略，因此以 GetCanvas 的
              // createdBy 为准；两者都空才是真的无属主。
              owner: access.access.owner || (readString(listed.value, "owner") ?? ""),
              isOwner: access.access.isOwner,
              role: access.access.role,
              canManage: access.access.canManage,
              complete: access.access.canManage,
              members
            }
          };
        }
      });

      host.registerHandler({
        route: REMOTE_SERVER_CANVAS_MEMBER_UPSERT_ROUTE,
        auth: "authenticated",
        purpose: "work-control",
        handle: async (input) => {
          const parsed = parseCanvasMemberMutation(input.body);
          if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } };
          const session = await sessionSource.current();
          if (!session) return { status: 200, body: { ok: false, error: "未连接服务端" } };
          const result = await callConnect<{ member?: unknown }>(
            fetchImpl,
            session.serverUrl,
            connectProcedurePath(CANVAS_SERVICE, "UpsertCanvasMember"),
            { canvasId: parsed.canvasId, actorId: parsed.actorId, role: canvasRoleToProto(parsed.role) },
            { token: session.token }
          );
          if (!result.ok) {
            log({
              event: "remote-canvas-member-upsert-failed",
              level: "warn",
              code: result.code,
              reason: "协作者写入失败"
            });
            return { status: 200, body: { ok: false, error: memberErrorText(result.code) } };
          }
          log({ event: "remote-canvas-member-upsert", code: "ok" });
          return { status: 200, body: { ok: true, member: mapCanvasMember(result.value?.member) } };
        }
      });

      host.registerHandler({
        route: REMOTE_SERVER_CANVAS_MEMBER_REMOVE_ROUTE,
        auth: "authenticated",
        purpose: "work-control",
        handle: async (input) => {
          const parsed = parseCanvasMemberTarget(input.body);
          if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } };
          const session = await sessionSource.current();
          if (!session) return { status: 200, body: { ok: false, error: "未连接服务端" } };
          const result = await callConnect<unknown>(
            fetchImpl,
            session.serverUrl,
            connectProcedurePath(CANVAS_SERVICE, "RemoveCanvasMember"),
            { canvasId: parsed.canvasId, actorId: parsed.actorId },
            { token: session.token }
          );
          if (!result.ok) {
            log({
              event: "remote-canvas-member-remove-failed",
              level: "warn",
              code: result.code,
              reason: "协作者移除失败"
            });
            return { status: 200, body: { ok: false, error: memberErrorText(result.code) } };
          }
          log({ event: "remote-canvas-member-remove", code: "ok" });
          return { status: 200, body: { ok: true, member: null } };
        }
      });

      /**
       * 链接分享设置的读取（作者/协作者看模式与 revision）。
       *
       * 与成员接口同一口径：浏览器不持令牌、远端零 CORS，宿主只做代发与字段裁剪；
       * 能不能改由服务端 GetCanvas 的 allowed_actions 现算，这里不自己推「我是不是作者」。
       *
       * revision 是 int64，ProtoJSON 用字符串传：原样保留可避免 JS number 精度问题；
       * 默认分享（restricted / revision 0）在 proto3 JSON 里会被省略，按协议语义补缺省，
       * 而不是把缺字段当成响应损坏。
       */
      host.registerHandler({
        route: REMOTE_SERVER_CANVAS_SHARE_ROUTE,
        auth: "authenticated",
        purpose: "read",
        handle: async (input) => {
          const canvasId = readString(input.body, "canvasId");
          if (!isBoundedId(canvasId)) return { status: 400, body: { ok: false, error: "画布 id 非法" } };
          const session = await sessionSource.current();
          if (!session) return { status: 200, body: { ok: false, error: "未连接服务端" } };
          const share = await callConnect<{ mode?: unknown; revision?: unknown }>(
            fetchImpl,
            session.serverUrl,
            connectProcedurePath(CANVAS_SERVICE, "GetCanvasShare"),
            { canvasId },
            { token: session.token }
          );
          if (!share.ok) {
            log({
              event: "remote-canvas-share-read-failed",
              level: "warn",
              code: share.code,
              reason: "分享设置读取失败",
              serverUrl: session.serverUrl,
              status: share.status
            });
            return {
              status: 200,
              body: { ok: false, error: shareErrorText(share.code, "read") } satisfies RemoteCanvasShareResult
            };
          }
          // 枚举 UNSPECIFIED / 缺省就是 restricted（proto 里 0 表示未指定，语义等同默认）。
          const mode = canvasShareModeFromProto(share.value?.mode) ?? "restricted";
          const revision = normalizeRevision(share.value?.revision) ?? "0";
          // canManage 是服务端结论；读分享成功但 GetCanvas 失败时按不可管理处理——
          // 界面只会因此少一个选择器，不会把「看得到」误画成「改得了」。
          const access = await readCanvasAccess(session, canvasId);
          const canManage = access.ok ? access.access.canShare : false;
          return {
            status: 200,
            body: { ok: true, mode, revision, canManage } satisfies RemoteCanvasShareResult
          };
        }
      });

      /**
       * 链接分享设置的写入（只有作者能改，服务端判定）。
       *
       * expectedRevision 原样带上（int64 字符串）：服务端用它做乐观并发校验，不一致回
       * ABORTED——这不是故障，而是「别人先改了」，界面应提示重读后再试。
       */
      host.registerHandler({
        route: REMOTE_SERVER_CANVAS_SHARE_UPDATE_ROUTE,
        auth: "authenticated",
        purpose: "work-control",
        handle: async (input) => {
          const parsed = parseCanvasShareUpdate(input.body);
          if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } };
          const session = await sessionSource.current();
          if (!session) return { status: 200, body: { ok: false, error: "未连接服务端" } };
          const updated = await callConnect<{ mode?: unknown; revision?: unknown }>(
            fetchImpl,
            session.serverUrl,
            connectProcedurePath(CANVAS_SERVICE, "UpdateCanvasShare"),
            {
              canvasId: parsed.canvasId,
              mode: canvasShareModeToProto(parsed.mode),
              expectedRevision: parsed.expectedRevision
            },
            { token: session.token }
          );
          if (!updated.ok) {
            log({
              event: "remote-canvas-share-update-failed",
              level: "warn",
              code: updated.code,
              reason: "分享设置写入失败",
              serverUrl: session.serverUrl,
              status: updated.status
            });
            return {
              status: 200,
              body: { ok: false, error: shareErrorText(updated.code, "update") } satisfies RemoteCanvasShareUpdateResult
            };
          }
          // 以服务端回填为准：它可能做了归一（例如把未知值折成 restricted），界面显示的
          // 必须是生效值，而不是我们请求的那个值。缺省同样按 proto 语义补。
          const mode = canvasShareModeFromProto(updated.value?.mode) ?? parsed.mode;
          const revision = normalizeRevision(updated.value?.revision) ?? "0";
          log({ event: "remote-canvas-share-update", code: "ok" });
          return {
            status: 200,
            body: { ok: true, mode, revision } satisfies RemoteCanvasShareUpdateResult
          };
        }
      });

      /**
       * 协作邀请的读取（作者/部署管理员）。
       *
       * 服务端只对能管理成员的人给出完整邀请列表（普通协作者回 permission_denied）；这里
       * 如实转达，不自己判断权限——界面按成员读模型的 canManage 决定是否渲染邀请区，所以
       * 读不到时只需给一句可读原因。列表里**没有链接**（token 只在创建时返回一次），需要
       * 再分享就重新创建一条。
       */
      host.registerHandler({
        route: REMOTE_SERVER_CANVAS_INVITES_ROUTE,
        auth: "authenticated",
        purpose: "read",
        handle: async (input) => {
          const canvasId = readString(input.body, "canvasId");
          if (!isBoundedId(canvasId)) return { status: 400, body: { ok: false, error: "画布 id 非法" } };
          const session = await sessionSource.current();
          if (!session) return { status: 200, body: { ok: false, error: "未连接服务端" } };
          const listed = await callConnect<{ invites?: unknown[] }>(
            fetchImpl,
            session.serverUrl,
            connectProcedurePath(CANVAS_SERVICE, "ListCanvasInvites"),
            { canvasId },
            { token: session.token }
          );
          if (!listed.ok) {
            log({
              event: "remote-canvas-invites-read-failed",
              level: "warn",
              code: listed.code,
              reason: "协作邀请读取失败",
              serverUrl: session.serverUrl,
              status: listed.status
            });
            return { status: 200, body: { ok: false, error: inviteErrorText(listed.code, "list") } };
          }
          const invites = (Array.isArray(listed.value?.invites) ? listed.value.invites : [])
            .map(mapCanvasInvite)
            .filter((invite): invite is RemoteCanvasInvite => invite !== null);
          return { status: 200, body: { ok: true, canvasId, invites } };
        }
      });

      /**
       * 创建一条协作邀请（作者/部署管理员）。
       *
       * url **原样透传**：服务端按部署配置拼好绝对地址，客户端不自己用 location.origin 拼。
       * 空串表示部署没配对外地址——照样返回 ok（邀请可能已签发），由界面提示「无法生成链接」，
       * 而不是在这里假装失败或编一个地址。链接里带 token，**不进日志**。
       */
      host.registerHandler({
        route: REMOTE_SERVER_CANVAS_INVITE_CREATE_ROUTE,
        auth: "authenticated",
        purpose: "work-control",
        handle: async (input) => {
          const parsed = parseCanvasInviteCreate(input.body);
          if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } };
          const session = await sessionSource.current();
          if (!session) return { status: 200, body: { ok: false, error: "未连接服务端" } };
          const created = await callConnect<{ inviteId?: unknown; role?: unknown; expiresAt?: unknown; url?: unknown }>(
            fetchImpl,
            session.serverUrl,
            connectProcedurePath(CANVAS_SERVICE, "CreateCanvasInvite"),
            {
              canvasId: parsed.canvasId,
              role: canvasRoleToProto(parsed.role),
              // int64 在 ProtoJSON 里是字符串：按线格式传十进制字符串。
              expiresInSeconds: String(parsed.expiresInSeconds)
            },
            { token: session.token }
          );
          if (!created.ok) {
            log({
              event: "remote-canvas-invite-create-failed",
              level: "warn",
              code: created.code,
              reason: "协作邀请创建失败",
              serverUrl: session.serverUrl,
              status: created.status
            });
            return { status: 200, body: { ok: false, error: inviteErrorText(created.code, "create") } };
          }
          const inviteId = readString(created.value, "inviteId");
          if (inviteId === null) {
            log({
              event: "remote-canvas-invite-create-failed",
              level: "warn",
              code: "invalid-response",
              reason: "服务端返回的邀请缺少 id"
            });
            return { status: 200, body: { ok: false, error: "服务端返回的邀请形状不符" } };
          }
          const role = canvasRoleFromProto(readString(created.value, "role")) ?? parsed.role;
          // 只记「创建成功」，不记 url / token。
          log({ event: "remote-canvas-invite-create", code: "ok", serverUrl: session.serverUrl });
          return {
            status: 200,
            body: {
              ok: true,
              inviteId,
              role,
              expiresAt: readString(created.value, "expiresAt") ?? "",
              url: readString(created.value, "url") ?? ""
            }
          };
        }
      });

      /** 撤销一条协作邀请（作者/部署管理员）。撤销不删除已接受的人：那只影响后续接受。 */
      host.registerHandler({
        route: REMOTE_SERVER_CANVAS_INVITE_REVOKE_ROUTE,
        auth: "authenticated",
        purpose: "work-control",
        handle: async (input) => {
          const parsed = parseCanvasInviteTarget(input.body);
          if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } };
          const session = await sessionSource.current();
          if (!session) return { status: 200, body: { ok: false, error: "未连接服务端" } };
          const result = await callConnect<unknown>(
            fetchImpl,
            session.serverUrl,
            connectProcedurePath(CANVAS_SERVICE, "RevokeCanvasInvite"),
            { canvasId: parsed.canvasId, inviteId: parsed.inviteId },
            { token: session.token }
          );
          if (!result.ok) {
            log({
              event: "remote-canvas-invite-revoke-failed",
              level: "warn",
              code: result.code,
              reason: "协作邀请撤销失败",
              serverUrl: session.serverUrl,
              status: result.status
            });
            return { status: 200, body: { ok: false, error: inviteErrorText(result.code, "revoke") } };
          }
          log({ event: "remote-canvas-invite-revoke", code: "ok" });
          return { status: 200, body: { ok: true } };
        }
      });

      /**
       * 重新探测服务端托管生成目录（「刷新模型」）。
       *
       * 返回受控状态快照：可用性、模型数量与目录修订号。浏览器只读这几个数，不接触模型细节
       * 与任何凭据；刷新不要求整页重载（change: 2026-10-20-reserve-remote-generation-provider）。
       */
      host.registerHandler({
        route: REMOTE_SERVER_GENERATION_REFRESH_ROUTE,
        auth: "authenticated",
        purpose: "read",
        handle: async () => {
          const status: RemoteGenerationStatus = await generationBridge.refresh();
          return {
            status: 200,
            body: {
              available: status.available,
              modelCount: status.modelCount,
              catalogRevision: status.catalogRevision,
              ...(status.error !== null ? { error: status.error } : {})
            }
          };
        }
      });

      /**
       * 读取宿主诊断缓冲（已脱敏、有界）。
       *
       * 这是「浏览器能看到的接入过程」：令牌永远不在这条链路上，宿主只交出投影后的条目。
       * 宿主没有该能力（纯本地宿主/旧版本）时**必须**明说 unavailable，而不是给一份空列表
       * 让人误以为「最近确实什么都没发生」。
       */
      host.registerHandler({
        route: REMOTE_SERVER_DIAGNOSTICS_ROUTE,
        auth: "authenticated",
        purpose: "read",
        handle: async () => {
          const capturedAt = now();
          const diagnostics = host.diagnostics;
          const snapshot: RemoteDiagnosticsSnapshot = diagnostics
            ? {
                entries: diagnostics.snapshot({ limit: DIAGNOSTIC_WINDOW_LIMIT }),
                capturedAt,
                // 宿主不暴露真实缓冲容量；这里报告读取窗口上限，界面只把它当说明。
                capacity: DIAGNOSTIC_WINDOW_LIMIT,
                available: true
              }
            : { entries: [], capturedAt, capacity: 0, available: false };
          // 读取本身**不**留痕：调试窗口按秒轮询，把每次读取写成一条事件会让缓冲自我放大，
          // 几秒内就把真正的接入事件挤掉。读是界面动作，不是接入过程。
          return { status: 200, body: snapshot };
        }
      });

      /**
       * 把诊断缓冲上报到当前连接的服务端（排障用，尽力而为）。
       *
       * 为什么由宿主代发：令牌只在本机宿主里，浏览器触发上报但拿不到它。失败只回稳定短语，
       * 不影响编辑或同步——诊断上报失败绝不能变成一次功能故障。
       *
       * 为什么按字节切批 + 记水位：服务端按 32 KiB 解码上限硬拒超大请求，而 200 条带短说明
       * 就会超；只按条数发等于「一上报就失败」。水位只是少发无谓请求的优化（重载后归零），
       * 重复落库由载荷里的 `entryId` 幂等键兜底。
       *
       * 响应正文与令牌都不进返回体、也不进日志：只把 `acceptedCount` 这一个事实带回去。
       *
       * 浏览器自报的 `frontendVersion` 由请求体带进来，这里只做形状校验再原样转给服务端：
       * 版本属于**浏览器那份 bundle**，宿主没有别的来源可以知道它（见 `normalizeFrontendVersion`）。
       */
      host.registerHandler({
        route: REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE,
        auth: "authenticated",
        purpose: "new-work",
        handle: async ({ body }) => {
          // 浏览器没带、带空或形状不对都归一成 `""`：这是辅助信息，不该让上报失败。
          const frontendVersion = normalizeFrontendVersion(
            (body as { frontendVersion?: unknown } | null | undefined)?.frontendVersion
          );
          const session = await sessionSource.current();
          if (!session) {
            log({
              event: "remote-diagnostics-report-failed",
              level: "warn",
              code: "unconfigured",
              reason: "没有可用的服务端会话"
            });
            return { status: 200, body: { ok: false, error: "未连接服务端" } satisfies RemoteDiagnosticsReportResult };
          }

          const diagnostics = host.diagnostics;
          if (!diagnostics) {
            log({
              event: "remote-diagnostics-report-failed",
              level: "warn",
              code: "unavailable",
              reason: "宿主没有提供诊断缓冲"
            });
            return {
              status: 200,
              body: { ok: false, error: "宿主没有提供诊断缓冲" } satisfies RemoteDiagnosticsReportResult
            };
          }

          const snapshot = diagnostics.snapshot({ limit: DIAGNOSTIC_WINDOW_LIMIT });
          // 水位只是优化：跳过本进程里已经发过的条目，少发无谓请求。它不承担去重正确性——
          // 正确性来自每条载荷带的 entryId，服务端按「主体 + entryId」只落一条。
          // 同时排除上次上报成功留下的那条自指事件，否则每次成功都会给自己制造一条新条目，
          // 「没有新条目」状态永远不会出现（见常量注释）。
          if (reportWatermark.serverUrl !== session.serverUrl) {
            reportWatermark = { serverUrl: session.serverUrl, seq: 0 };
          }
          const entries = snapshot.filter(
            (entry) => entry.seq > reportWatermark.seq && entry.event !== DIAGNOSTICS_REPORT_OK_EVENT
          );
          if (entries.length === 0) {
            // 没有新条目就一个请求都不发（少一次往返，也不给服务端制造无谓负载）。
            // 也不写日志：每次点击都往诊断缓冲里塞一条「没东西可报」会让窗口自我放大。
            return { status: 200, body: { ok: true, acceptedCount: 0 } satisfies RemoteDiagnosticsReportResult };
          }

          // 跨批累加服务端计数；某批失败时水位停在最后一个成功批之后，重试只补后续条目
          // （重发已成功批次也不会重复落库——服务端按 entryId 幂等）。
          let acceptedCount = 0;
          const envelopeBytes = reportEnvelopeBytes(frontendVersion);
          for (const batch of splitDiagnosticBatches(entries, envelopeBytes)) {
            // Connect JSON：字段名按 proto 的 lowerCamelCase，级别用 proto 枚举名。
            const result = await callConnect<unknown>(
              fetchImpl,
              session.serverUrl,
              connectProcedurePath(DIAGNOSTICS_SERVICE, "ReportDiagnostics"),
              {
                // 空串是契约允许的「未知」；上报端没带或形状非法时就是它。
                frontendVersion,
                entries: batch.map(toReportEntry)
              },
              { token: session.token }
            );
            if (!result.ok) {
              // 404/501/`unimplemented` 都是「这台服务端还没有这个接口」：给一句可行动的话，
              // 而不是让界面看到「远端调用失败」这种什么都说不清的状态。
              const unimplemented = result.code === "unimplemented" || result.status === 404 || result.status === 501;
              const error = unimplemented ? "服务端尚未实现诊断上报接口" : connectErrorText(result.code);
              log({
                event: "remote-diagnostics-report-failed",
                level: "warn",
                code: unimplemented ? "unimplemented" : result.code,
                reason: error,
                serverUrl: session.serverUrl,
                status: result.status,
                // 部分批次已成功时把计数带回去，便于对照服务端落库情况；它不是秘密。
                ...(acceptedCount > 0 ? { acceptedCount } : {})
              });
              return { status: 200, body: { ok: false, error } satisfies RemoteDiagnosticsReportResult };
            }

            // 以服务端的计数为准。**缺失按 0 处理**：proto3 的 JSON 编码省略零值字段，
            // 「一条都没新增」在线上就是 `{}` 而不是 `{"acceptedCount":0}`。这不能退化成
            // 本批条数——引入 entryId 幂等键之后「整批都是重复、新增 0 条」是常态
            // （扩展重载后重发整窗、连点、多批重试都会发生），退化成批大小等于凭空编造一个
            // 更大的数，界面会显示 200 条实际新增 0 的假象。
            acceptedCount += readNumber(result.value, "acceptedCount") ?? 0;
            // 只有整批被接受后才推进水位。条目按 seq 升序（宿主契约保证），批末即本批最大 seq。
            reportWatermark.seq = batch[batch.length - 1].seq;
          }

          log({ event: DIAGNOSTICS_REPORT_OK_EVENT, serverUrl: session.serverUrl, acceptedCount });
          return { status: 200, body: { ok: true, acceptedCount } satisfies RemoteDiagnosticsReportResult };
        }
      });

      /**
       * 把「服务端掌管的字节」注册成存储后端（`storage.primary = server` 即可选用）。
       *
       * **地址是「连哪台服务端」这一个指针，被两处共用**：交互式登录用它连一次，存储后端用它
       * 读写字节。因此地址有两个来源，优先级固定——部署配置（`config.local.json` /
       * `WOOHAA3_REMOTE_SERVER_URL` / 设置面）**权威**，其次才是**已登录会话自带的地址**
       * （人登录时认可过它，随后随会话一起持久化）。只认部署配置会让「登录过、但没写配置文件」
       * 的部署在下次启动时注册不上这个后端，媒体静默回落主存储：同一个客户端，同步走远端、
       * 字节走本地。
       *
       * 以下情况只记日志、不注册——存储后端可以由 local / cos 顶上，缺配置不该让宿主启动失败：
       * 1. 两个来源都没有地址（= 纯本地，也还没登录过）；
       * 2. 宿主没提供 `registerStorage` 接缝（纯本地宿主没有存储扩展点时本来就没有这个后端）。
       *
       * 设备凭证**不是**门槛：没有凭证也注册，调用期由共享会话报 `unconfigured` /
       * `unauthenticated`，运行期还能靠网关断言或设备码登录补上。
       *
       * 生命周期：**同一个 id 只有一份实现**。首次注册后，地址变化（首次登录补上、改部署）只
       * 原地改配置对象；地址消失（登出，且部署配置本来没配）时注销。不重建后端是为了不打断
       * 在途请求，也不给「同 id 两份注册」留窗口（宿主的 `register` 对重复 id 直接抛错）。
       */
      /**
       * 后端持有的**活引用**：`createServerStorageBackend` 只读这个对象，客户端每次调用现算
       * 基址，所以换地址是改字段，不换实例。
       */
      const storageBackendConfig: ServerStorageConfig = { serverUrl: "", keyPrefix: "" };
      /** 已注册的后端实例（惰性创建）；`null` 表示当前没注册。 */
      let registeredStorageBackend: ReturnType<typeof createServerStorageBackend> | null = null;

      /**
       * 按当前「部署配置 + 会话」把存储后端对齐到正确目标。
       *
       * - 没有地址（纯本地 / 未登录）：只记 `server-storage-unconfigured`，不注册；
       * - 地址出现且未注册：注册一份；
       * - 已注册但地址变了：原地改活引用（客户端每次调用现算基址）；
       * - 已注册但地址消失（登出且部署配置本来没配）：注销——留着一个空地址的实现，
       *   每次调用都会抛，界面只能看到一串「存储不可用」，说不清是没登录还是没配置。
       */
      const registerStorageBackend = async (): Promise<void> => {
        const deployment = readDeployment();
        const session = await sessionSource.current();
        const serverUrl = resolveServerUrl(deployment.serverUrl, session);
        const resolved = resolveServerStorageConfig(deployment, serverUrl);
        if (!resolved.ok) {
          if (registeredStorageBackend !== null) {
            host.unregisterStorage?.(registeredStorageBackend.backendId);
            registeredStorageBackend = null;
            storageBackendConfig.serverUrl = "";
            host.logger({ event: "server-storage-released", reason: "地址已不可用（登出且部署未配地址）" });
            return;
          }
          // 日志只写缺哪个字段，绝不写值（deviceToken 是凭据）。
          host.logger({
            event: "server-storage-unconfigured",
            ...(resolved.missing.length > 0 ? { missing: [...resolved.missing] } : {}),
            ...(resolved.invalid ? { invalid: resolved.invalid } : {})
          });
          return;
        }
        if (!host.registerStorage) {
          host.logger({ event: "server-storage-unavailable", reason: "宿主没有提供存储扩展点" });
          return;
        }
        const source = deployment.serverUrl === null ? "session" : "deployment";
        if (registeredStorageBackend !== null) {
          if (storageBackendConfig.serverUrl === resolved.config.serverUrl) return;
          storageBackendConfig.serverUrl = resolved.config.serverUrl;
          storageBackendConfig.keyPrefix = resolved.config.keyPrefix;
          host.logger({ event: "server-storage-retargeted", source, serverHost: serverHostOf(resolved.config.serverUrl) });
          return;
        }
        storageBackendConfig.serverUrl = resolved.config.serverUrl;
        storageBackendConfig.keyPrefix = resolved.config.keyPrefix;
        const transport = options.storageTransport ?? {};
        const backend = createServerStorageBackend({
          config: storageBackendConfig,
          session: sessionSource,
          now,
          ...(transport.fetchImpl ?? options.fetchImpl
            ? { fetchImpl: transport.fetchImpl ?? options.fetchImpl }
            : {}),
          ...(transport.hostOrigin ? { hostOrigin: transport.hostOrigin } : {}),
          ...(transport.timeoutMs ? { timeoutMs: transport.timeoutMs } : {}),
          ...(transport.transferTimeoutMs ? { transferTimeoutMs: transport.transferTimeoutMs } : {})
        });
        host.registerStorage(backend);
        registeredStorageBackend = backend;
        host.logger({
          event: "server-storage-activated",
          backendId: backend.backendId,
          // 地址来自部署配置还是已登录会话：排障时这是「配置有没有生效」的第一问。
          source,
          // 只记「有没有部署凭证」这个事实（与登录日志的 `method` 同口径），不记值。
          credential: deployment.deviceToken === null ? "none" : "device-token"
        });
      };

      /**
       * 会话变化后的存储后端同步（`onSessionChanged` 的第二种用途）。
       *
       * 登录成功 → 地址从无到有 → 注册；登出 → 地址可能随会话消失 → 注销。
       */
      const syncStorageBackendWithSession = async (): Promise<void> => {
        await registerStorageBackend();
      };

      // 激活末尾就注册一次：activate 返回的 Promise 会被宿主 await，因此这一步是确定的，
      // 不依赖「ready 之后」的时序猜测。此时文档存储已可用，能读到上次持久化的会话。
      await registerStorageBackend();
    }
  };
}

/**
 * 由基址推出中继的 ws(s) 基址。
 *
 * 同源挂载路径（`/remote`）保持原样：`canvas-service` 的 relay 客户端接受相对基址，
 * 由它自己按当前 origin 解析——宿主这边的 `ws` 实现需要绝对地址，因此在那种部署下
 * 中继仍须走绝对地址配置。这里只做「http→ws / https→wss」这一件事。
 */
function toWsBase(serverUrl: string): string {
  const { wsBase } = resolveRemoteEndpoints(serverUrl);
  return wsBase.replace(/\/+$/, "");
}

/**
 * 诊断里能出现的「远端是谁」：只有 `host[:port]`（绝对基址）或站内挂载路径。
 *
 * 为什么不记完整地址：部署路径可能带环境名，query 可能带一次性参数——两者都不该进日志。
 * 同源挂载（`/remote`）保留路径本身：它不含 origin，无法折成 host，而路径是排查必需的。
 */
function serverHostOf(serverUrl: string): string {
  if (serverUrl.startsWith("/")) return serverUrl;
  try {
    return new URL(serverUrl).host;
  } catch {
    return "";
  }
}

export type { ApplicationExtensionRequestContext };
