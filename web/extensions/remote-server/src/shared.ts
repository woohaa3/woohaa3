/**
 * remote-server 共享定义（前后端 + 测试共用；不含运行时实现与秘密）。
 *
 * 本扩展把「接入远端 woohaa-server」做成客户端的一等能力：登录、连接状态、断开，
 * 以及把远端会话交给画布同步上游。它不改远端服务端，也不改变「纯本地可用」的缺省形态：
 * 没有配置远端时一切照旧，本扩展只显示「本地模式」。
 *
 * 边界（change: 2026-10-19-add-remote-server-extension）：
 * - 会话令牌只在**本机宿主**里存在，浏览器只读状态快照，永远拿不到令牌（B1/B3）；
 * - 远端服务端零 CORS，因此所有远端调用都由本机宿主发出，浏览器不跨源；
 * - 本模块只放常量、DTO 与纯校验，可被浏览器 bundle 安全引用。
 */
import { isBoundedId } from "@woohaa3/contracts";
import type { ApplicationExtensionMetadata } from "@woohaa3/contracts";

export const REMOTE_SERVER_EXTENSION_ID = "remote-server";

/** 受控 handler 路由（宿主挂在 `/api/plugins/remote-server/handlers/<route>` 下）。 */
export const REMOTE_SERVER_SESSION_ROUTE = "session";
export const REMOTE_SERVER_LOGIN_ROUTE = "login";
export const REMOTE_SERVER_LOGOUT_ROUTE = "logout";
export const REMOTE_SERVER_PROBE_ROUTE = "probe";
/** 发起一次设备码登录：返回批准页地址与给人看的短码。 */
export const REMOTE_SERVER_DEVICE_START_ROUTE = "device-start";
/** 轮询一次设备码登录：返回状态，获批时一次性交出会话。 */
export const REMOTE_SERVER_DEVICE_POLL_ROUTE = "device-poll";
/** 读取宿主诊断缓冲（服务端接入与同步上游事件，已脱敏）。 */
export const REMOTE_SERVER_DIAGNOSTICS_ROUTE = "diagnostics";
/** 把当前诊断缓冲上报到已连接的服务端（宿主代发，令牌不出宿主）。 */
export const REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE = "diagnostics-report";
/**
 * 显式把一张本地画布启用为「同步到远端」。
 *
 * 登录远端只代表「远端可用」；本地画布默认不上传，必须由用户逐张显式启用。启用后这张
 * 画布就是远端画布：首次推送完成远端登记，之后在远端目录里出现，重新连接时按普通远端
 * 画布自动同步。
 */
export const REMOTE_SERVER_SYNC_ENABLE_ROUTE = "canvas-sync-enable";
/**
 * 重新探测服务端托管生成目录并返回模型状态（available / modelCount / catalogRevision）。
 *
 * 刷新不要求整页重载：宿主返回受控状态快照，前端只更新这两三个数（change:
 * 2026-10-20-reserve-remote-generation-provider，tasks 5.5/6.2）。
 */
export const REMOTE_SERVER_GENERATION_REFRESH_ROUTE = "generation-refresh";
/**
 * 发起一次**浏览器授权码**登录：返回服务端授权入口地址。
 *
 * 与设备码的分工（change: 2026-10-20-add-local-oauth-login，D6）：浏览器与本机宿主同机时
 * 这是默认路径（一步：打开浏览器 → 企业统一登录 → 回调到本机）；设备码保留为兜底。
 */
export const REMOTE_SERVER_OAUTH_START_ROUTE = "oauth-start";
/** 轮询一次浏览器授权登录：`pending` / `approved`（一次性交出快照）/ `failed`。 */
export const REMOTE_SERVER_OAUTH_POLL_ROUTE = "oauth-poll";
/**
 * 画布协作者（画布维度 ACL）的读写路由。
 *
 * 协作入口是「作者 / 部署管理员管成员」的客户端面：浏览器不持令牌、远端零 CORS，因此
 * 三个 handler 都只是宿主代发与形状裁剪，授权结论仍由服务端现算
 * （`ListCanvasMembers` / `UpsertCanvasMember` / `RemoveCanvasMember`）。
 */
export const REMOTE_SERVER_CANVAS_MEMBERS_ROUTE = "canvas-members";
export const REMOTE_SERVER_CANVAS_MEMBER_UPSERT_ROUTE = "canvas-member-upsert";
export const REMOTE_SERVER_CANVAS_MEMBER_REMOVE_ROUTE = "canvas-member-remove";
/**
 * 画布「链接分享」的读写路由。
 *
 * 服务端把分享模式实现为 Access 语义：`restricted` 只认作者/协作者；`everyone_view` /
 * `everyone_edit` 让**拿到链接的已认证主体**可读（edit 时可写）。这不是匿名公开：
 * 未登录仍然进不来，链接也不让画布出现在别人的目录里。
 */
export const REMOTE_SERVER_CANVAS_SHARE_ROUTE = "canvas-share";
export const REMOTE_SERVER_CANVAS_SHARE_UPDATE_ROUTE = "canvas-share-update";
/**
 * 画布协作邀请的读写路由。
 *
 * 邀请由**服务端签发**：创建返回的 url 形如 `<public_base_url>/invite/<token>`，客户端只
 * 展示与复制它，**不自己用 location.origin 拼**（对外地址只有部署侧知道；未配置时服务端
 * 回 failed_precondition 或空 url）。创建/撤销是管理动作（作者或部署管理员），读取列表
 * 同样只对管理面开放，授权结论仍由服务端现算。
 */
export const REMOTE_SERVER_CANVAS_INVITES_ROUTE = "canvas-invites";
export const REMOTE_SERVER_CANVAS_INVITE_CREATE_ROUTE = "canvas-invite-create";
export const REMOTE_SERVER_CANVAS_INVITE_REVOKE_ROUTE = "canvas-invite-revoke";

/**
 * 公开回调路由（宿主挂在 extension.json 的 publicRoutes 之下）。
 *
 * 浏览器授权码**只在服务端**出现：浏览器被服务端 302 到这里的回调，回调在本机宿主内部换会话，
 * 然后 302 到完成页——页面脚本、前端 store 都接触不到授权码（design D5）。
 */
/**
 * 回调路径（相对 `publicRoutes[0].publicPath`）。
 *
 * 只写**相对**部分：宿主按 `<extensionId>/<route>` 组织注册表，`publicPath` 的前缀
 * 由公开路由映射负责。把映射前缀写进 route 常量会让同一个路径出现两种拼法
 * （`remote-server/remote-server/...`），排查时极难发现。
 */
export const REMOTE_SERVER_OAUTH_CALLBACK_ROUTE = "auth/callback";
/** 回调完成页：只渲染「成功/失败，可以关闭此窗口」，不带任何码或令牌。 */
export const REMOTE_SERVER_OAUTH_DONE_ROUTE = "auth/done";
/** 公开路径前缀；必须与 extension.json 的 publicRoutes[0].publicPath 一致。 */
export const REMOTE_SERVER_PUBLIC_PATH = "/api/remote-server";

/** 浏览器登录的轮询间隔（毫秒）；面板以此节奏问宿主「回调到了吗」。 */
export const REMOTE_SERVER_OAUTH_POLL_INTERVAL_MS = 1500;
/**
 * 浏览器登录的总等待上限（毫秒）。
 *
 * 它**不是**授权码 TTL（那是服务端 60 秒的事）：人可能在统一登录页里多花几十秒输入/切账号，
 * 我们要等的是「这个人还在这条路上」，超过 5 分钟就该把短码摆出来。
 */
export const REMOTE_SERVER_OAUTH_POLL_TIMEOUT_MS = 5 * 60_000;

/** 前端能力 key：连接状态读模型。 */
export const REMOTE_SERVER_CAPABILITY = "remoteServer";

/** 同步上游使用的设置键；与 `web/contracts/src/settings/index.ts` 的定义一一对应。 */
export const REMOTE_SERVER_UPSTREAM_URL_KEY = "canvas.syncUpstream.url" as const;
export const REMOTE_SERVER_UPSTREAM_TOKEN_KEY = "canvas.syncUpstream.token" as const;

/**
 * 扩展自己的配置段（`remote-server.` 前缀，落普通配置文件）。
 *
 * 只有非秘密项能走这里：站点扩展的 `config.values()` 不含 `secret` 字段的值，
 * 拿到的只有 `secretRefs()`（引用，不含明文）。部署凭证因此**不**走设置面，
 * 而是读扩展目录里的 `config.local.json`（0600，不进 Git）。
 */
export const REMOTE_SERVER_CONFIG_PREFIX = "remote-server";

/** 部署凭证的本地配置文件名（与扩展目录同级；已被 .gitignore 忽略）。 */
export const REMOTE_SERVER_LOCAL_CONFIG = "config.local.json";

/** 部署期环境变量：作为 `config.local.json` 的覆盖，便于容器化部署注入。 */
export const REMOTE_SERVER_URL_ENV = "WOOHAA3_REMOTE_SERVER_URL";
export const REMOTE_SERVER_DEVICE_TOKEN_ENV = "WOOHAA3_REMOTE_SERVER_DEVICE_TOKEN";

/**
 * 远端助手的稳定 adapter id。
 *
 * 放在 `shared` 而不是 backend 目录：前端要拿它做两件事——注册 `authoring.generate`
 * 来源贡献（`sourceId` 必须等于 adapterId，否则宿主判定「来源已停用」），以及在
 * 连接选择里对上号。半边分离下前端不能 import backend 代码。
 */
export const REMOTE_ASSISTANT_ADAPTER_ID = "remote-assistant";

export const REMOTE_SERVER_METADATA: ApplicationExtensionMetadata = {
  extensionId: REMOTE_SERVER_EXTENSION_ID,
  name: "服务端接入",
  description: "一键接入远端 woohaa-server：登录、连接状态与断开；未配置时保持纯本地。",
  version: "1.1.0",
  managementScope: "site",
  host: "backend",
  configSchema: { schemaId: "remote-server-config", schemaVersion: 1 },
  dependencies: [],
  capabilities: [
    { id: "remote-server.session", kind: "handler", description: "连接状态与会话读模型", auth: "authenticated" },
    { id: "remote-server.login", kind: "handler", description: "用部署凭证换远端会话", auth: "authenticated" },
    { id: "remote-server.logout", kind: "handler", description: "撤销远端会话", auth: "authenticated" },
    { id: "remote-server.probe", kind: "handler", description: "探测远端可达性与登录方式", auth: "authenticated" },
    { id: "remote-server.canvas-sync-enable", kind: "handler", description: "把一张本地画布显式启用为同步到远端", auth: "authenticated" },
    { id: "remote-server.canvas-members", kind: "handler", description: "读取一张远端画布的协作者名单", auth: "authenticated" },
    { id: "remote-server.canvas-member-upsert", kind: "handler", description: "新增或调整一名协作者（作者/部署管理员）", auth: "authenticated" },
    { id: "remote-server.canvas-member-remove", kind: "handler", description: "移除一名协作者（作者/部署管理员）", auth: "authenticated" },
    { id: "remote-server.canvas-share", kind: "handler", description: "读取画布的链接分享模式与修订号", auth: "authenticated" },
    { id: "remote-server.canvas-share-update", kind: "handler", description: "修改画布的链接分享模式（作者/部署管理员）", auth: "authenticated" },
    { id: "remote-server.canvas-invites", kind: "handler", description: "列出一张远端画布的协作邀请（作者/部署管理员）", auth: "authenticated" },
    { id: "remote-server.canvas-invite-create", kind: "handler", description: "创建一条协作邀请并返回服务端签发的链接（作者/部署管理员）", auth: "authenticated" },
    { id: "remote-server.canvas-invite-revoke", kind: "handler", description: "撤销一条协作邀请（作者/部署管理员）", auth: "authenticated" },
    { id: "remote-server.generation-refresh", kind: "handler", description: "重新探测服务端托管生成目录并返回模型状态", auth: "authenticated" },
    { id: "remote-server.diagnostics", kind: "handler", description: "读取已脱敏的服务端接入诊断事件", auth: "authenticated" },
    { id: "remote-server.diagnostics-report", kind: "handler", description: "把诊断事件上报到已连接的服务端", auth: "authenticated" },
    { id: "remote-server.oauth-start", kind: "handler", description: "发起浏览器授权码登录（本机 loopback 回调）", auth: "authenticated" },
    { id: "remote-server.oauth-poll", kind: "handler", description: "轮询浏览器授权码登录结果", auth: "authenticated" }
  ]
};

/**
 * 连接状态。
 *
 * `local` 是缺省形态（未配置远端），不是错误——界面必须能把它说成一种正常选择，
 * 而不是「未连接」的失败态。`error` 与 `local` 分开，避免把配置缺失表现成故障，
 * 也避免把故障表现成「你本来就没接」。
 */
export const REMOTE_SERVER_PHASES = ["local", "connecting", "connected", "error"] as const;
export type RemoteServerPhase = (typeof REMOTE_SERVER_PHASES)[number];

export function isRemoteServerPhase(value: unknown): value is RemoteServerPhase {
  return typeof value === "string" && (REMOTE_SERVER_PHASES as readonly string[]).includes(value);
}

/** 远端登录方式（与 `woohaa.identity.v1alpha1.GetAuthMethods` 的 kind 同义，但只保留展示所需）。 */
export const REMOTE_AUTH_METHOD_KINDS = ["machine-token", "gateway", "tof"] as const;
export type RemoteAuthMethodKind = (typeof REMOTE_AUTH_METHOD_KINDS)[number];

export type RemoteAuthMethod = {
  kind: RemoteAuthMethodKind;
  /** 这次请求是否已经带着网关断言（只描述当前请求，不承诺配置）。 */
  ambient?: boolean;
};

/**
 * 连接状态快照（浏览器可读）。
 *
 * **不含令牌，也不含远端返回的原始载荷**：只放界面需要的事实。`subject` 是为了让人确认
 * 「接的是哪个账号」，不是凭据。
 */
export type RemoteServerSnapshot = {
  phase: RemoteServerPhase;
  /** 远端基址；`local` 时为 null。 */
  serverUrl: string | null;
  /** 已登录主体；未登录为 null。 */
  subject: string | null;
  displayName: string | null;
  /** 会话到期时刻（毫秒）；未知为 null。 */
  expiresAt: number | null;
  /** 这次部署提供哪些登录方式（探测结果；未探测为空数组）。 */
  methods: RemoteAuthMethod[];
  /** 面向人的失败原因；`phase !== "error"` 时为 null。 */
  error: string | null;
};

export const LOCAL_ONLY_SNAPSHOT: RemoteServerSnapshot = {
  phase: "local",
  serverUrl: null,
  subject: null,
  displayName: null,
  expiresAt: null,
  methods: [],
  error: null
};

/** 登录请求体。`token` 留空表示用扩展配置里的部署凭证。 */
export type RemoteServerLoginInput = { token?: string; serverUrl?: string };

export type RemoteServerLogoutResult = { ok: true } | { ok: false; error: string };
/**
 * 设备码登录的状态（与 `woohaa.identity.v1alpha1.DeviceLoginState` 同义）。
 *
 * 它是一个**状态**而不是错误码：把「还没批准」表达成错误，会让「这次轮询没结果」与
 * 「你未认证」变成同一个结论，而它们该有完全不同的走向——前者继续等，后者重新开始。
 */
export const DEVICE_LOGIN_STATES = ["pending", "approved", "denied", "expired"] as const;
export type DeviceLoginState = (typeof DEVICE_LOGIN_STATES)[number];

/** 发起结果：给人看的短码 + 要打开的批准页地址。**不含会话令牌。** */
export type RemoteDeviceLoginStart = {
  /** 显示给用户的短码（已带连字符）。 */
  userCode: string;
  /** 批准页地址（在服务端管理端）。用户在这个页面登录并输入短码。 */
  verificationUri: string;
  /** 建议轮询间隔（毫秒）。 */
  intervalMs: number;
  /** 过期时刻（毫秒）。 */
  expiresAt: number;
};

/** 轮询结果。`approved` 时宿主已经拿到并保存会话，浏览器仍不接触令牌。 */
export type RemoteDeviceLoginPoll =
  | { state: "pending" | "denied" | "expired" }
  | { state: "approved"; snapshot: RemoteServerSnapshot };

/**
 * 发起浏览器授权码登录的结果（宿主 oauth-start handler 的返回形状）。
 *
 * 失败时 error 是**稳定码**、message 是可直接展示的中文短语。为什么两者分开：前端要按
 * 「是不是 unsupported」决定回退设备码，按文案匹配的话，改一次文案回退就断了。
 */
export type RemoteOAuthLoginStartResult =
  | { ok: true; attemptId: string; authorizeUrl: string; expiresAt: number }
  | { ok: false; error: string; message: string };

/** oauth-start 的稳定失败码：当前环境（旧宿主/站内相对地址）没有浏览器登录这条路径。 */
export const OAUTH_LOGIN_UNSUPPORTED = "unsupported";

/**
 * 轮询结果。
 *
 * approved 时宿主已经落好会话，浏览器只拿到快照（令牌不出宿主）；failed 带一句可展示的
 * 中文原因，面板据此显示文案并提供「改用短码」。
 */
export type RemoteOAuthLoginPoll =
  | { state: "pending" }
  | { state: "approved"; snapshot: RemoteServerSnapshot }
  | { state: "failed"; error: string; code?: string };

export type RemoteServerProbeResult =
  | { ok: true; serverUrl: string; methods: RemoteAuthMethod[] }
  | { ok: false; error: string };

/**
 * 一条服务端接入诊断事件（宿主已脱敏、有界）。
 *
 * `category` / `event` 是稳定标识，`message` 是短说明，`attributes` 是有界键值细节；
 * 不包含令牌、设备码、请求体或远端响应正文。浏览器只读，令牌永远不经过这条链路。
 */
export type RemoteDiagnosticLevel = "debug" | "info" | "warn" | "error";

export type RemoteDiagnosticEntry = {
  seq: number;
  time: number;
  level: RemoteDiagnosticLevel;
  category: string;
  event: string;
  code?: string;
  message?: string;
  /**
   * 有界、已脱敏的键值细节（例如 `status=200`、`server=host:port`、`phase=probe`）。
   *
   * 它来自宿主投影，形状（键 `[a-z][a-z0-9._-]{0,31}`、值单行 ≤256 字符、≤16 对）由宿主
   * 保证；窗口只把它当展示/复制文本，**不解释语义**，也不据此做任何判断。
   */
  attributes?: Record<string, string>;
};

/**
 * 诊断窗口一次读取的结果。
 *
 * `capacity` 是**本次读取/展示上限**（宿主缓冲可能更大），只用于界面说明；它不等于宿主
 * 实际缓冲容量——扩展拿不到那个值，也不该猜。
 */
export type RemoteDiagnosticsSnapshot = {
  entries: RemoteDiagnosticEntry[];
  capturedAt: number;
  capacity: number;
  /**
   * 宿主是否提供诊断缓冲。
   *
   * 旧宿主/独立入口没有这个能力；此时必须明说「不可用」，不能返回一份空列表让人
   * 误以为「最近确实什么都没发生」。
   */
  available: boolean;
};

export type RemoteDiagnosticsReadResult =
  | { ok: true; snapshot: RemoteDiagnosticsSnapshot }
  | { ok: false; error: string };

export type RemoteDiagnosticsReportResult =
  | { ok: true; acceptedCount: number }
  | { ok: false; error: string };

/**
 * 服务端托管生成的目录状态（受控快照：可用性、模型数量、目录修订号）。
 *
 * **不含模型细节、远端正文与凭据**：界面只需要回答「服务端现在提供了多少模型」以及给一个
 * 刷新入口；模型定义本身已经在宿主的生成注册表里（change: 2026-10-20-reserve-remote-generation-provider）。
 * `error` 是稳定短语（未实现/协议不匹配/不可达），不是异常栈。
 */
export type RemoteServerGenerationStatus = {
  available: boolean;
  modelCount: number;
  catalogRevision: number;
  error: string | null;
};

/** 协作者两档角色。作者不在成员表里：作者身份只有一个来源（canvas.created_by）。 */
export const REMOTE_CANVAS_ROLES = ["viewer", "editor"] as const;
export type RemoteCanvasRole = (typeof REMOTE_CANVAS_ROLES)[number];

/** 一条协作者关系（字段与 CanvasMember 对齐，角色已折成界面用的两档）。 */
export type RemoteCanvasMember = {
  actorId: string;
  role: RemoteCanvasRole;
  /** 授予者；空表示迁移遗留（旧画布级绑定没有操作者）。 */
  grantedBy: string;
  /** RFC 3339。 */
  grantedAt: string;
};

/**
 * 协作者读模型的快照。
 *
 * `canManage` 是**服务端的结论**（`allowed_actions` 含 `canvas.share`，即作者本人；
 * 部署管理员的 `canvas.manage` 只够代管成员，不够改分享设置）：
 * 界面只据它决定是否显示写操作，不自己推一遍"我是不是作者/管理员"。`complete` 回答
 * "members 是不是完整名单"——普通协作者只拿到自己那一条，不能把不完整的名单画成
 * "只有这些人"。
 */
export type RemoteCanvasMemberView = {
  canvasId: string;
  /** 作者（服务端 created_by）；空表示无属主（迁移遗留）。 */
  owner: string;
  isOwner: boolean;
  /** 调用者在这张画布上的角色；作者按 editor 呈现（作者拥有全部内容权限）。 */
  role: RemoteCanvasRole;
  canManage: boolean;
  complete: boolean;
  members: RemoteCanvasMember[];
};

export type RemoteCanvasMembersResult =
  | ({ ok: true } & RemoteCanvasMemberView)
  | { ok: false; error: string };

export type RemoteCanvasMemberMutationResult =
  | { ok: true; member: RemoteCanvasMember | null }
  | { ok: false; error: string };

/** proto 的 CanvasRole → 两档角色；UNSPECIFIED / 未知值返回 null。 */
export function canvasRoleFromProto(value: unknown): RemoteCanvasRole | null {
  if (value === "CANVAS_ROLE_VIEWER") return "viewer";
  if (value === "CANVAS_ROLE_EDITOR") return "editor";
  return null;
}

/** 两档角色 → proto 的 CanvasRole（成员写入只接受这两档）。 */
export function canvasRoleToProto(role: RemoteCanvasRole): "CANVAS_ROLE_VIEWER" | "CANVAS_ROLE_EDITOR" {
  return role === "viewer" ? "CANVAS_ROLE_VIEWER" : "CANVAS_ROLE_EDITOR";
}

const ACTOR_PATTERN = /^[^\s\u0000-\u001f\u007f]{1,256}$/;

/**
 * 校验一条成员移除（画布 + 主体）。
 *
 * 浏览器可控输入：画布 id 有界，主体标识不得含空白与控制字符。这里只做形状，不判断
 * "这个人存不存在"——服务端也不校验主体是否已登记（输错只会得到一条不被使用的记录）。
 */
export function parseCanvasMemberTarget(
  value: unknown
): { ok: true; canvasId: string; actorId: string } | { ok: false; error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "请求体必须是对象" };
  }
  const record = value as Record<string, unknown>;
  const canvasId = typeof record.canvasId === "string" ? record.canvasId.trim() : "";
  if (!isBoundedId(canvasId)) return { ok: false, error: "画布 id 非法" };
  const actorId = typeof record.actorId === "string" ? record.actorId.trim() : "";
  if (!ACTOR_PATTERN.test(actorId)) return { ok: false, error: "主体标识必须是 1–256 个不含空白和控制字符的字符" };
  return { ok: true, canvasId, actorId };
}

/** 校验一条成员写入（新增或调整）。角色只能是 viewer / editor 两档。 */
export function parseCanvasMemberMutation(
  value: unknown
): { ok: true; canvasId: string; actorId: string; role: RemoteCanvasRole } | { ok: false; error: string } {
  const target = parseCanvasMemberTarget(value);
  if (!target.ok) return target;
  const role = (value as Record<string, unknown>).role;
  if (role !== "viewer" && role !== "editor") return { ok: false, error: "角色只能是 viewer 或 editor" };
  return { ...target, role };
}

/**
 * 链接分享模式（服务端 `CanvasShareMode` 的两档 + 默认的 restricted）。
 *
 * 语义边界写在这里，是因为它决定了「拿到链接的人能做什么」：
 * - `restricted`：只有作者与显式协作者；
 * - `everyone_view`：拿到链接且**已登录本部署**的人可读；
 * - `everyone_edit`：同上，可写（仍不蕴含改分享、删除与成员管理）。
 */
export const REMOTE_CANVAS_SHARE_MODES = ["restricted", "everyone_view", "everyone_edit"] as const;
export type RemoteCanvasShareMode = (typeof REMOTE_CANVAS_SHARE_MODES)[number];

const isShareMode = (value: unknown): value is RemoteCanvasShareMode =>
  typeof value === "string" && (REMOTE_CANVAS_SHARE_MODES as readonly string[]).includes(value);

/** 分享设置读模型：`revision` 是 ProtoJSON 的 int64 字符串，原样保留避免 JS number 精度问题。 */
export type RemoteCanvasShareState = {
  mode: RemoteCanvasShareMode;
  revision: string;
  /** 调用者能否修改分享设置（作者或部署管理员）；界面据此决定是否渲染选择器。 */
  canManage: boolean;
};

export type RemoteCanvasShareResult = ({ ok: true } & RemoteCanvasShareState) | { ok: false; error: string };
export type RemoteCanvasShareUpdateResult =
  | { ok: true; mode: RemoteCanvasShareMode; revision: string }
  | { ok: false; error: string };

/** proto 的 CanvasShareMode → 三档；UNSPECIFIED / 未知值返回 null。 */
export function canvasShareModeFromProto(value: unknown): RemoteCanvasShareMode | null {
  if (value === "CANVAS_SHARE_MODE_RESTRICTED") return "restricted";
  if (value === "CANVAS_SHARE_MODE_EVERYONE_VIEW") return "everyone_view";
  if (value === "CANVAS_SHARE_MODE_EVERYONE_EDIT") return "everyone_edit";
  return null;
}

/** 三档 → proto 的 CanvasShareMode。 */
export function canvasShareModeToProto(
  mode: RemoteCanvasShareMode
): "CANVAS_SHARE_MODE_RESTRICTED" | "CANVAS_SHARE_MODE_EVERYONE_VIEW" | "CANVAS_SHARE_MODE_EVERYONE_EDIT" {
  if (mode === "everyone_view") return "CANVAS_SHARE_MODE_EVERYONE_VIEW";
  if (mode === "everyone_edit") return "CANVAS_SHARE_MODE_EVERYONE_EDIT";
  return "CANVAS_SHARE_MODE_RESTRICTED";
}

/** int64 可能是字符串或数字（ProtoJSON），统一成十进制字符串；非法返回 null。 */
export function normalizeRevision(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return null;
}

/** 校验一次分享设置写入（浏览器可控输入）。 */
export function parseCanvasShareUpdate(
  value: unknown
): { ok: true; canvasId: string; mode: RemoteCanvasShareMode; expectedRevision: string } | { ok: false; error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "请求体必须是对象" };
  }
  const record = value as Record<string, unknown>;
  const canvasId = typeof record.canvasId === "string" ? record.canvasId.trim() : "";
  if (!isBoundedId(canvasId)) return { ok: false, error: "画布 id 非法" };
  if (!isShareMode(record.mode)) return { ok: false, error: "分享模式只能是 restricted / everyone_view / everyone_edit" };
  const expectedRevision = normalizeRevision(record.expectedRevision ?? 0) ?? "0";
  return { ok: true, canvasId, mode: record.mode, expectedRevision };
}

function decodeShareMode(value: unknown): RemoteCanvasShareMode | null {
  return isShareMode(value) ? value : null;
}

/** 防御性解码分享设置读取结果。 */
export function decodeRemoteCanvasShareResult(value: unknown): RemoteCanvasShareResult | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.ok === false) {
    return typeof record.error === "string" && record.error !== "" ? { ok: false, error: record.error } : null;
  }
  if (record.ok !== true) return null;
  const mode = decodeShareMode(record.mode);
  const revision = normalizeRevision(record.revision);
  if (mode === null || revision === null || typeof record.canManage !== "boolean") return null;
  return { ok: true, mode, revision, canManage: record.canManage };
}

/** 防御性解码分享设置写入结果。 */
export function decodeRemoteCanvasShareUpdateResult(value: unknown): RemoteCanvasShareUpdateResult | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.ok === false) {
    return typeof record.error === "string" && record.error !== "" ? { ok: false, error: record.error } : null;
  }
  if (record.ok !== true) return null;
  const mode = decodeShareMode(record.mode);
  const revision = normalizeRevision(record.revision);
  if (mode === null || revision === null) return null;
  return { ok: true, mode, revision };
}

/** 成员操作的稳定错误短语（远端正文与内部细节不进浏览器）。 */
export function memberErrorText(code: string): string {
  switch (code) {
    case "unauthenticated":
      return "未连接服务端或会话已失效";
    case "permission_denied":
      return "只有作者或部署管理员能管理协作者";
    case "not_found":
      return "画布不存在或对你不可见";
    case "failed_precondition":
      return "画布已删除，不能管理协作者";
    case "invalid_argument":
      return "主体标识或角色不合法";
    case "unavailable":
      return "远端服务暂不可用";
    case "timeout":
      return "远端响应超时";
    case "unreachable":
      return "无法连接远端服务端";
    default:
      return "协作者操作失败";
  }
}

const isRole = (value: unknown): value is RemoteCanvasRole =>
  typeof value === "string" && (REMOTE_CANVAS_ROLES as readonly string[]).includes(value);

function decodeMember(value: unknown): RemoteCanvasMember | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.actorId !== "string" || record.actorId === "" || !isRole(record.role)) return null;
  return {
    actorId: record.actorId,
    role: record.role,
    grantedBy: typeof record.grantedBy === "string" ? record.grantedBy : "",
    grantedAt: typeof record.grantedAt === "string" ? record.grantedAt : ""
  };
}

/** 防御性解码协作者读取结果：形状不符返回 null（界面报"响应形状不符"而不是崩）。 */
export function decodeRemoteCanvasMembersResult(value: unknown): RemoteCanvasMembersResult | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.ok === false) {
    return typeof record.error === "string" && record.error !== "" ? { ok: false, error: record.error } : null;
  }
  if (record.ok !== true) return null;
  if (typeof record.canvasId !== "string" || typeof record.owner !== "string") return null;
  if (typeof record.isOwner !== "boolean" || typeof record.canManage !== "boolean" || typeof record.complete !== "boolean") return null;
  if (!isRole(record.role) || !Array.isArray(record.members)) return null;
  const members: RemoteCanvasMember[] = [];
  for (const entry of record.members) {
    const decoded = decodeMember(entry);
    if (decoded === null) return null;
    members.push(decoded);
  }
  return {
    ok: true,
    canvasId: record.canvasId,
    owner: record.owner,
    isOwner: record.isOwner,
    role: record.role,
    canManage: record.canManage,
    complete: record.complete,
    members
  };
}

/** 防御性解码一条成员写入结果。 */
export function decodeRemoteCanvasMemberMutationResult(value: unknown): RemoteCanvasMemberMutationResult | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.ok === false) {
    return typeof record.error === "string" && record.error !== "" ? { ok: false, error: record.error } : null;
  }
  if (record.ok !== true) return null;
  if (record.member === undefined || record.member === null) return { ok: true, member: null };
  const member = decodeMember(record.member);
  return member === null ? null : { ok: true, member };
}

/**
 * 协作邀请的有效期预设（秒）。
 *
 * 与服务端 `CreateCanvasInvite` 的缺省（7 天）对齐：界面只提供这四档，避免出现「永不过期」
 * 这种实际做不到的选项；超过服务端上限（90 天）的值仍由服务端收紧，客户端不猜。
 */
export const REMOTE_CANVAS_INVITE_EXPIRY_PRESETS = [
  { seconds: 3600, label: "1 小时" },
  { seconds: 86_400, label: "24 小时" },
  { seconds: 604_800, label: "7 天" },
  { seconds: 2_592_000, label: "30 天" }
] as const;

/** 预设里的一档秒数。 */
export type RemoteCanvasInviteExpirySeconds = (typeof REMOTE_CANVAS_INVITE_EXPIRY_PRESETS)[number]["seconds"];

/** 默认有效期：7 天（与服务端缺省一致）。 */
export const REMOTE_CANVAS_INVITE_DEFAULT_EXPIRY_SECONDS: RemoteCanvasInviteExpirySeconds = 604_800;

/**
 * 一条协作邀请。
 *
 * token **不在**这里：服务端只在创建时返回一次链接，库里只存哈希。列表里没有链接是协议
 * 事实，不是宿主裁剪——需要再分享时重新创建一条（旧链接仍有效，直到到期或撤销）。
 */
export type RemoteCanvasInvite = {
  inviteId: string;
  role: RemoteCanvasRole;
  /** 创建者主体；空表示服务端没有回填。 */
  createdBy: string;
  /** RFC 3339。 */
  createdAt: string;
  /** RFC 3339；服务端保证非空。 */
  expiresAt: string;
  /** 已经被接受的次数（同一链接可以被多次使用，直到到期或撤销）。 */
  acceptedCount: number;
  /** 最近一次被接受的时间；没人接受时为空串。 */
  lastAcceptedAt: string;
  revoked: boolean;
};

/** 创建结果：url 是服务端按部署配置拼好的绝对地址，客户端只展示/复制，不自己拼。 */
export type RemoteCanvasInviteCreated = {
  inviteId: string;
  role: RemoteCanvasRole;
  /** RFC 3339。 */
  expiresAt: string;
  /** 空串表示服务端未配置对外地址；界面必须据此报错，而不是退回 location.origin。 */
  url: string;
};

export type RemoteCanvasInvitesResult =
  | { ok: true; canvasId: string; invites: RemoteCanvasInvite[] }
  | { ok: false; error: string };

export type RemoteCanvasInviteCreateResult =
  | ({ ok: true } & RemoteCanvasInviteCreated)
  | { ok: false; error: string };

export type RemoteCanvasInviteRevokeResult = { ok: true } | { ok: false; error: string };

function isInviteExpirySeconds(value: unknown): value is RemoteCanvasInviteExpirySeconds {
  return (
    typeof value === "number" && REMOTE_CANVAS_INVITE_EXPIRY_PRESETS.some((preset) => preset.seconds === value)
  );
}

/**
 * 校验一次邀请创建（浏览器可控输入）。
 *
 * 有效期只接受预设档位：界面没有「自定义秒数」入口，放行任意正整数只会让契约多出一种
 * 没有使用者的形状。缺省按 7 天。
 */
export function parseCanvasInviteCreate(
  value: unknown
):
  | { ok: true; canvasId: string; role: RemoteCanvasRole; expiresInSeconds: RemoteCanvasInviteExpirySeconds }
  | { ok: false; error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "请求体必须是对象" };
  }
  const record = value as Record<string, unknown>;
  const canvasId = typeof record.canvasId === "string" ? record.canvasId.trim() : "";
  if (!isBoundedId(canvasId)) return { ok: false, error: "画布 id 非法" };
  const role = record.role;
  if (role !== "viewer" && role !== "editor") return { ok: false, error: "角色只能是 viewer 或 editor" };
  const expiresInSeconds =
    record.expiresInSeconds === undefined ? REMOTE_CANVAS_INVITE_DEFAULT_EXPIRY_SECONDS : record.expiresInSeconds;
  if (!isInviteExpirySeconds(expiresInSeconds)) {
    return { ok: false, error: "有效期只能是 1 小时 / 24 小时 / 7 天 / 30 天" };
  }
  return { ok: true, canvasId, role, expiresInSeconds };
}

/** 校验一次邀请撤销（画布 + 邀请 id）。 */
export function parseCanvasInviteTarget(
  value: unknown
): { ok: true; canvasId: string; inviteId: string } | { ok: false; error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "请求体必须是对象" };
  }
  const record = value as Record<string, unknown>;
  const canvasId = typeof record.canvasId === "string" ? record.canvasId.trim() : "";
  if (!isBoundedId(canvasId)) return { ok: false, error: "画布 id 非法" };
  const inviteId = typeof record.inviteId === "string" ? record.inviteId.trim() : "";
  if (!isBoundedId(inviteId)) return { ok: false, error: "邀请 id 非法" };
  return { ok: true, canvasId, inviteId };
}

function decodeInvite(value: unknown): RemoteCanvasInvite | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const inviteId = typeof record.inviteId === "string" ? record.inviteId : "";
  // 宿主已经把 proto 枚举折成两档角色；这里按宿主契约解码，不再吃 CANVAS_ROLE_*。
  const role = isRole(record.role) ? record.role : null;
  if (!isBoundedId(inviteId) || role === null) return null;
  const rawCount = record.acceptedCount;
  // int32 在 ProtoJSON 里是数字；缺省是 0（proto3 省略零值），字符串形式一并容错。
  const acceptedCount =
    typeof rawCount === "number" && Number.isSafeInteger(rawCount) && rawCount >= 0
      ? rawCount
      : typeof rawCount === "string" && /^\d+$/.test(rawCount)
        ? Number(rawCount)
        : 0;
  return {
    inviteId,
    role,
    createdBy: typeof record.createdBy === "string" ? record.createdBy : "",
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : "",
    acceptedCount,
    lastAcceptedAt: typeof record.lastAcceptedAt === "string" ? record.lastAcceptedAt : "",
    revoked: record.revoked === true
  };
}

/** 防御性解码邀请列表结果：形状不符返回 null（界面报「响应形状不符」而不是崩）。 */
export function decodeRemoteCanvasInvitesResult(value: unknown): RemoteCanvasInvitesResult | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.ok === false) {
    return typeof record.error === "string" && record.error !== "" ? { ok: false, error: record.error } : null;
  }
  if (record.ok !== true) return null;
  if (typeof record.canvasId !== "string" || !Array.isArray(record.invites)) return null;
  const invites: RemoteCanvasInvite[] = [];
  for (const entry of record.invites) {
    const decoded = decodeInvite(entry);
    if (decoded === null) return null;
    invites.push(decoded);
  }
  return { ok: true, canvasId: record.canvasId, invites };
}

/** 防御性解码邀请创建结果。url 允许为空串（服务端未配置对外地址），由界面报错。 */
export function decodeRemoteCanvasInviteCreateResult(value: unknown): RemoteCanvasInviteCreateResult | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.ok === false) {
    return typeof record.error === "string" && record.error !== "" ? { ok: false, error: record.error } : null;
  }
  if (record.ok !== true) return null;
  const inviteId = typeof record.inviteId === "string" ? record.inviteId : "";
  const role = isRole(record.role) ? record.role : null;
  if (!isBoundedId(inviteId) || role === null || typeof record.url !== "string") return null;
  return {
    ok: true,
    inviteId,
    role,
    expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : "",
    url: record.url
  };
}

/** 防御性解码邀请撤销结果。 */
export function decodeRemoteCanvasInviteRevokeResult(value: unknown): RemoteCanvasInviteRevokeResult | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.ok === false) {
    return typeof record.error === "string" && record.error !== "" ? { ok: false, error: record.error } : null;
  }
  return record.ok === true ? { ok: true } : null;
}

/**
 * 协作邀请的稳定错误短语（远端正文与内部细节不进浏览器）。
 *
 * `failed_precondition` 在创建时的含义就是「部署没有配置对外地址」：服务端签不出绝对链接，
 * 客户端**不**退回 location.origin 自己拼一个（那会指向错误的域名）。列表/撤销遇到同一码
 * 则是画布状态问题，按动作分开说。
 */
export function inviteErrorText(code: string, action: "list" | "create" | "revoke" = "list"): string {
  switch (code) {
    case "unauthenticated":
      return "未连接服务端或会话已失效";
    case "permission_denied":
      return "只有作者或部署管理员能管理协作邀请";
    case "failed_precondition":
      return action === "create" ? "服务端未配置对外地址，无法生成邀请链接" : "画布已删除，不能管理协作邀请";
    case "not_found":
      return action === "revoke" ? "邀请不存在或已被撤销" : "画布不存在或对你不可见";
    case "invalid_argument":
      return "邀请参数不合法";
    case "unimplemented":
      return "这台服务端还没有协作邀请接口";
    case "unavailable":
      return "远端服务暂不可用";
    case "timeout":
      return "远端响应超时";
    case "unreachable":
      return "无法连接远端服务端";
    default:
      return "协作邀请操作失败";
  }
}

/**
 * 上报端自报的构建版本（`frontendVersion`）的形状校验。
 *
 * 浏览器把它写进上报请求，宿主校验后原样转给服务端。形状与服务端 `cleanVersion` / proto
 * 注释一致：≤64 的 `[0-9A-Za-z.+_-]`，首字符字母数字。非法值归一为 `""`（"未声明"），
 * **不**拒绝上报——它是辅助信息，不该把整批诊断弄失败。
 *
 * 为什么宿主也要校验：宿主只是代发方，对浏览器传来的内容没有信任依据；这里先归一能保证
 * 日志面与库里的值只有"版本号"或"空串"两种，读取方不用再区分"没报"与"报了非法值"。
 */
const FRONTEND_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

export function normalizeFrontendVersion(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return FRONTEND_VERSION_PATTERN.test(trimmed) ? trimmed : "";
}

/** 有界校验：基址必须是 http(s) 或同源绝对路径；拒绝其它协议与裸主机名。 */
export function parseServerUrl(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "服务端地址必须是字符串" };
  const value = raw.trim();
  if (value === "") return { ok: false, message: "服务端地址不能为空" };
  if (value.length > 2048) return { ok: false, message: "服务端地址过长" };
  // 同源挂载路径：以 / 开头，后面不能再是 //（协议相对地址会指向别的 origin）。
  if (value.startsWith("/")) {
    if (value.startsWith("//")) return { ok: false, message: "服务端地址不能是协议相对地址" };
    return { ok: true, value: value.replace(/\/+$/, "") };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: "服务端地址必须是 https://… 或以 / 开头的站内路径" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: "服务端地址只支持 http / https" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, message: "服务端地址不得内嵌凭据" };
  }
  if (url.search !== "" || url.hash !== "") {
    return { ok: false, message: "服务端地址不要带查询串或片段" };
  }
  return { ok: true, value: `${url.origin}${url.pathname.replace(/\/+$/, "")}` };
}

/**
 * 由基址推出 Connect 根与 WS 根。
 *
 * 远端服务端把 Connect 过程名直接挂在根路径（`/woohaa.<service>/<Method>`），中继在
 * `/ws/canvases/{id}`；同源反代场景下两者都相对同一个基址，因此这里只做一处推导。
 */
export function resolveRemoteEndpoints(serverUrl: string): { rpcBase: string; wsBase: string } {
  if (serverUrl.startsWith("/")) return { rpcBase: serverUrl, wsBase: serverUrl };
  const url = new URL(serverUrl);
  const rpcBase = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
  return { rpcBase, wsBase: `${wsProtocol}//${url.host}${url.pathname.replace(/\/+$/, "")}` };
}

/**
 * loopback 主机名白名单：只认这三个（IPv6 的两种写法都算）。
 *
 * 为什么用白名单而不是「以 127. 开头」：浏览器回调只能落到**本机**，放行 127.0.0.2/8 段
 * 或任意 *.localhost 只是把攻击面扩大，产品上没有任何好处。
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** 这个主机名是不是 loopback（面板据此决定「默认走浏览器登录」）。 */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.trim().toLowerCase());
}

/**
 * 解析浏览器 origin：只接受 **http 的 loopback origin**。
 *
 * 约束与 design D2 一致：必须是绝对 origin（无路径/查询/片段/userinfo），协议只允许 http，
 * 主机只允许 loopback。宿主据此拼 redirect_uri——放行其它主机等于把授权码送给攻击者。
 */
export function parseLoopbackOrigin(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "来源必须是字符串" };
  const value = raw.trim();
  if (value === "") return { ok: false, message: "来源不能为空" };
  if (value.length > 256) return { ok: false, message: "来源过长" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: "来源必须是绝对地址" };
  }
  if (url.protocol !== "http:") return { ok: false, message: "浏览器登录只支持 http 的本机地址" };
  if (url.username !== "" || url.password !== "") return { ok: false, message: "来源不得内嵌凭据" };
  if (url.pathname !== "/") return { ok: false, message: "来源必须是 origin（不含路径）" };
  if (url.search !== "" || url.hash !== "") return { ok: false, message: "来源不得带查询串或片段" };
  if (!isLoopbackHostname(url.hostname)) {
    return { ok: false, message: "浏览器登录只能从本机访问（127.0.0.1 / localhost / [::1]）" };
  }
  return { ok: true, value: url.origin };
}

/**
 * 应用基址归一：空串表示挂在根，否则是带前导 / 、无尾斜杠的片段（如 /app）。
 *
 * 回调与完成页都在应用基址之下：反代把整个应用挂在子路径时，宿主看到的请求路径与
 * 浏览器地址栏是两回事，只有 deployment.basePath 能对齐（design D6）。
 */
export function normalizeBasePath(basePath?: string | null): string {
  if (typeof basePath !== "string") return "";
  const trimmed = basePath.trim();
  if (trimmed === "" || trimmed === "/") return "";
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeading.replace(/\/+$/, "");
}

/** 浏览器授权回调的绝对地址：<origin><basePath>/api/remote-server/auth/callback。 */
export function oauthCallbackUrl(origin: string, basePath?: string | null): string {
  // origin 按定义不带尾斜杠；这里再兜一次，避免拼出 //api/... 这种反代可能拒绝的路径。
  return `${origin.replace(/\/+$/, "")}${normalizeBasePath(basePath)}${REMOTE_SERVER_PUBLIC_PATH}/auth/callback`;
}

/** 回调完成页的站内地址（只用于 302 的 Location，不含任何码或令牌）。 */
export function oauthDonePath(basePath?: string | null): string {
  return `${normalizeBasePath(basePath)}${REMOTE_SERVER_PUBLIC_PATH}/auth/done`;
}

/**
 * 拼服务端授权入口地址：<rpcBase>/tof/authorize?redirect_uri=&state=&code_challenge=&code_challenge_method=S256。
 *
 * query 用 URLSearchParams 编码（redirect_uri 里的 :// 必须编码）；参数名与 query 位置由服务端
 * 契约固定，这里不自造别名。
 */
export function buildTofAuthorizeUrl(input: {
  rpcBase: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const query = new URLSearchParams({
    redirect_uri: input.redirectUri,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256"
  });
  return `${input.rpcBase.replace(/\/+$/, "")}/tof/authorize?${query.toString()}`;
}

/** Connect 一元调用路径（服务端零 CORS，因此只有本机宿主会调用它）。 */
export function connectProcedurePath(service: string, method: string): string {
  return `/${service}/${method}`;
}

export const IDENTITY_SERVICE = "woohaa.identity.v1alpha1.IdentityService";

/** 仅转发受信部署适配器显式允许的登录断言头，缺省不转发任何头。 */
export function pickLoginAssertionHeaders(
  headers: Record<string, string | string[] | undefined>,
  allowedHeaders: readonly string[] = []
): Record<string, string> {
  const out: Record<string, string> = {};
  const lowered = new Map(Object.keys(headers).map((key) => [key.toLowerCase(), key]));
  for (const allowedName of allowedHeaders) {
    const name = allowedName.toLowerCase();
    if (["authorization", "cookie", "host", "connection", "content-length", "transfer-encoding"].includes(name)) continue;
    const original = lowered.get(name);
    if (original === undefined) continue;
    const value = headers[original];
    const single = Array.isArray(value) ? value[0] : value;
    if (typeof single === "string" && single !== "") out[name] = single;
  }
  return out;
}
export const OPS_SERVICE = "woohaa.ops.v1.OpsService";
/** 画布自服务（建/查/我的画布/成员）。目录合并读的是 `ListMyCanvases`。 */
export const CANVAS_SERVICE = "woohaa.canvas.v1.CanvasService";
/** 部署托管的扩展市场（只读目录面）：搜索、版本详情与签名下载地址。 */
export const MARKETPLACE_SERVICE = "woohaa.marketplace.v1alpha1.MarketplaceService";
