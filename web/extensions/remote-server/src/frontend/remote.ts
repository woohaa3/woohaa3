/**
 * remote-server 前端：连接状态读模型。
 *
 * 浏览器侧的职责只有一件——把本机宿主给的快照渲染出来，并把用户的动作转发过去。
 * **它不持令牌、不直连远端**：远端服务端零 CORS，且会话必须留在本机（边界 B1/B3）。
 *
 * 状态机刻意把 `local` 与 `error` 分开：
 * - `local` 是「这台机器就只用本地」，是一种正常选择，不是失败；
 * - `error` 是「配了远端但连不上」，必须显示原因。
 * 把两者合并会让「我没配」看起来像「坏了」，也会让真的坏了看起来像「本来就没配」。
 */
import { appBuildVersion } from "@woohaa3/frontend/extension-api";
import type { ApplicationRemoteTransport } from "@woohaa3/frontend/extension-api";
import {
  LOCAL_ONLY_SNAPSHOT,
  OAUTH_LOGIN_UNSUPPORTED,
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
  REMOTE_SERVER_OAUTH_POLL_ROUTE,
  REMOTE_SERVER_OAUTH_POLL_TIMEOUT_MS,
  REMOTE_SERVER_OAUTH_START_ROUTE,
  REMOTE_SERVER_PROBE_ROUTE,
  REMOTE_SERVER_SESSION_ROUTE,
  REMOTE_SERVER_SYNC_ENABLE_ROUTE,
  decodeRemoteCanvasInviteCreateResult,
  decodeRemoteCanvasInviteRevokeResult,
  decodeRemoteCanvasInvitesResult,
  decodeRemoteCanvasMemberMutationResult,
  decodeRemoteCanvasMembersResult,
  decodeRemoteCanvasShareResult,
  decodeRemoteCanvasShareUpdateResult,
  type RemoteAuthMethod,
  type RemoteCanvasInviteCreateResult,
  type RemoteCanvasInviteRevokeResult,
  type RemoteCanvasInvitesResult,
  type RemoteCanvasMemberMutationResult,
  type RemoteCanvasMembersResult,
  type RemoteCanvasRole,
  type RemoteCanvasShareMode,
  type RemoteCanvasShareResult,
  type RemoteCanvasShareUpdateResult,
  type RemoteDeviceLoginStart,
  type RemoteDiagnosticEntry,
  type RemoteDiagnosticLevel,
  type RemoteDiagnosticsReadResult,
  type RemoteDiagnosticsReportResult,
  type RemoteDiagnosticsSnapshot,
  type RemoteServerGenerationStatus,
  type RemoteOAuthLoginPoll,
  type RemoteServerPhase,
  type RemoteServerSnapshot
} from "../shared.js";

/** 只依赖通用的同源 transport。 */
export type RemoteServerTransport = Pick<ApplicationRemoteTransport, "request">;

/**
 * 受控 handler 基路径。
 *
 * 用 `/api/extensions` 而不是规格里写的 `/api/plugins`：后者是**别名基路径**，只在宿主显式
 * 配置 `alternateHandlerBasePaths` 时生效，而当前装配没有配置它——`scripts/lib/ingress.mjs`
 * 的 `routeFor("/api/plugins/...")` 实测返回 `none`（404），`/api/extensions/...` 才路由到
 * application。写死一条实际不可达的路径会让整个页面静默失效。
 */
const HANDLER_BASE = `/api/extensions/${REMOTE_SERVER_EXTENSION_ID}/handlers`;

export type RemoteServerConnectResult =
  | { ok: true; snapshot: RemoteServerSnapshot }
  | { ok: false; error: string };

export type RemoteServerProbeFailure = { ok: false; error: string };
export type RemoteServerProbeSuccess = {
  ok: true;
  serverUrl: string;
  version: string;
  commit: string;
  methods: RemoteAuthMethod[];
};

/**
 * 显式启用「同步到远端」的结果。
 *
 * 失败带一句可展示的原因、不抛到组件外：按钮旁要能说清「为什么没启用成功」，而一次
 * 网络抖动也不该把画布切换器整块打崩。
 */
export type RemoteServerSyncEnableResult = { ok: true } | { ok: false; error: string };

/**
 * 发起浏览器登录的结果。
 *
 * `unsupported` 表示这台环境根本没有这条路径（旧宿主没有公开回调、站内相对地址）：
 * 面板据此**直接**走设备码，不再把一次注定失败的尝试摆到人面前。
 */
export type RemoteOAuthStartOutcome =
  | { ok: true; attemptId: string; authorizeUrl: string; expiresAt: number }
  | { ok: false; unsupported: boolean; error: string };

export type RemoteServerApi = ReturnType<typeof createRemoteServerApi>;

const DIAGNOSTIC_LEVELS: readonly RemoteDiagnosticLevel[] = ["debug", "info", "warn", "error"];

/** 属性值与条数上限：与上报契约一致；前端只做防御性收窄，不解释语义。 */
const MAX_DIAGNOSTIC_ATTRIBUTES = 16;
const MAX_DIAGNOSTIC_ATTRIBUTE_VALUE = 256;

function isDiagnosticLevel(value: unknown): value is RemoteDiagnosticLevel {
  return typeof value === "string" && (DIAGNOSTIC_LEVELS as readonly string[]).includes(value);
}

/**
 * 读一条诊断条目的 attributes。
 *
 * 宿主已经保证形状，这里仍防御性收窄：必须是非数组对象、键值都是字符串、最多 16 对、值
 * 截断到 256 字符。不合形状的整对丢弃而不是让整条读取失败——日志行不该把窗口打崩；空对象
 * 等同于「没有细节」，不产出这个键。
 */
function readDiagnosticAttributes(raw: unknown): Record<string, string> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const attributes: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_DIAGNOSTIC_ATTRIBUTES) break;
    if (key === "" || typeof value !== "string" || value === "") continue;
    attributes[key] =
      value.length > MAX_DIAGNOSTIC_ATTRIBUTE_VALUE
        ? `${value.slice(0, MAX_DIAGNOSTIC_ATTRIBUTE_VALUE - 1)}…`
        : value;
    count += 1;
  }
  return count > 0 ? attributes : undefined;
}

/** 读一条诊断事件；字段不全的条目丢弃（日志行不该让整次读取变成失败）。 */
function readDiagnosticEntry(raw: unknown): RemoteDiagnosticEntry | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.seq !== "number" || !Number.isFinite(record.seq)) return null;
  if (typeof record.time !== "number" || !Number.isFinite(record.time)) return null;
  if (!isDiagnosticLevel(record.level)) return null;
  if (typeof record.category !== "string" || record.category === "") return null;
  if (typeof record.event !== "string" || record.event === "") return null;
  const attributes = readDiagnosticAttributes(record.attributes);
  return {
    seq: record.seq,
    time: record.time,
    level: record.level,
    category: record.category,
    event: record.event,
    ...(typeof record.code === "string" && record.code !== "" ? { code: record.code } : {}),
    ...(typeof record.message === "string" && record.message !== "" ? { message: record.message } : {}),
    ...(attributes !== undefined ? { attributes } : {})
  };
}

/**
 * 读一次诊断缓冲快照。
 *
 * 接受两种形态：宿主 handler 直接返回 `RemoteDiagnosticsSnapshot`，或包一层 `{ ok: true, snapshot }`
 * （与同扩展其它 handler 一致的形状）。**两者都必须带显式 `available`**：旧宿主没有诊断能力时
 * 会回 `available: false`，若把缺失字段当成「空列表」，界面就会把「宿主不支持」说成
 * 「最近没有任何事件」——这两种情况对排查者是完全不同的结论。
 */
function readDiagnosticsSnapshot(data: unknown): RemoteDiagnosticsSnapshot | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const outer = data as Record<string, unknown>;
  const inner = outer.snapshot;
  const record =
    inner !== null && typeof inner === "object" && !Array.isArray(inner) && outer.available === undefined
      ? (inner as Record<string, unknown>)
      : outer;
  if (typeof record.available !== "boolean") return null;
  if (!Array.isArray(record.entries)) return null;
  const entries = record.entries
    .map(readDiagnosticEntry)
    .filter((entry): entry is RemoteDiagnosticEntry => entry !== null);
  return {
    entries,
    capturedAt: typeof record.capturedAt === "number" && Number.isFinite(record.capturedAt) ? record.capturedAt : Date.now(),
    capacity: typeof record.capacity === "number" && Number.isFinite(record.capacity) ? record.capacity : 0,
    available: record.available
  };
}

export function createRemoteServerApi(transport: RemoteServerTransport) {
  const readSnapshot = (data: unknown): RemoteServerSnapshot | null => {
    if (data === null || typeof data !== "object") return null;
    const record = data as Record<string, unknown>;
    const phase = record.phase;
    if (phase !== "local" && phase !== "connecting" && phase !== "connected" && phase !== "error") return null;
    return {
      phase: phase as RemoteServerPhase,
      serverUrl: typeof record.serverUrl === "string" ? record.serverUrl : null,
      subject: typeof record.subject === "string" ? record.subject : null,
      displayName: typeof record.displayName === "string" ? record.displayName : null,
      expiresAt: typeof record.expiresAt === "number" ? record.expiresAt : null,
      methods: Array.isArray(record.methods) ? (record.methods as RemoteAuthMethod[]) : [],
      error: typeof record.error === "string" ? record.error : null
    };
  };

  return {
    /** 当前连接状态；读不到时返回 `local`（缺省形态），不把网络失败说成「已连接」。 */
    async loadSnapshot(): Promise<RemoteServerSnapshot> {
      try {
        const result = await transport.request({ path: `${HANDLER_BASE}/${REMOTE_SERVER_SESSION_ROUTE}` });
        if (!result.ok) return { ...LOCAL_ONLY_SNAPSHOT };
        return readSnapshot(result.data) ?? { ...LOCAL_ONLY_SNAPSHOT };
      } catch {
        return { ...LOCAL_ONLY_SNAPSHOT };
      }
    },

    /** 探测地址是否可达、这个部署提供哪些登录方式。不改变登录态。 */
    async probe(input: { serverUrl?: string } = {}): Promise<RemoteServerProbeSuccess | RemoteServerProbeFailure> {
      try {
        const result = await transport.request({
          path: `${HANDLER_BASE}/${REMOTE_SERVER_PROBE_ROUTE}`,
          method: "POST",
          body: input.serverUrl ? { serverUrl: input.serverUrl } : {}
        });
        if (!result.ok) return { ok: false, error: result.error };
        const data = (result.data ?? {}) as Record<string, unknown>;
        if (data.ok !== true) {
          return { ok: false, error: typeof data.error === "string" ? data.error : "探测失败" };
        }
        return {
          ok: true,
          serverUrl: typeof data.serverUrl === "string" ? data.serverUrl : "",
          version: typeof data.version === "string" ? data.version : "",
          commit: typeof data.commit === "string" ? data.commit : "",
          methods: Array.isArray(data.methods) ? (data.methods as RemoteAuthMethod[]) : []
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "探测失败" };
      }
    },

    /** 一键接入：用部署凭证（或用户临时输入的令牌）换会话。 */
    async login(input: { serverUrl?: string; token?: string } = {}): Promise<RemoteServerConnectResult> {
      try {
        const result = await transport.request({
          path: `${HANDLER_BASE}/${REMOTE_SERVER_LOGIN_ROUTE}`,
          method: "POST",
          body: {
            ...(input.serverUrl ? { serverUrl: input.serverUrl } : {}),
            ...(input.token ? { token: input.token } : {})
          }
        });
        if (!result.ok) return { ok: false, error: result.error };
        const data = (result.data ?? {}) as Record<string, unknown>;
        if (data.ok !== true) {
          return { ok: false, error: typeof data.error === "string" ? data.error : "登录失败" };
        }
        const snapshot = readSnapshot(data.snapshot);
        if (!snapshot) return { ok: false, error: "远端返回的会话形状不符" };
        return { ok: true, snapshot };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "登录失败" };
      }
    },

    /**
     * 发起设备码登录：拿到短码与批准页地址。
     *
     * 这是「一键接入」的主路径——登录发生在**服务端**，客户端只负责把地址与短码摆到人
     * 面前，然后轮询。浏览器不会接触到会话令牌。
     */
    async startDeviceLogin(input: { serverUrl?: string } = {}): Promise<
      { ok: true; start: RemoteDeviceLoginStart } | { ok: false; error: string }
    > {
      try {
        const result = await transport.request({
          path: `${HANDLER_BASE}/${REMOTE_SERVER_DEVICE_START_ROUTE}`,
          method: "POST",
          body: input.serverUrl ? { serverUrl: input.serverUrl } : {}
        });
        if (!result.ok) return { ok: false, error: result.error };
        const data = (result.data ?? {}) as Record<string, unknown>;
        if (data.ok !== true) {
          return { ok: false, error: typeof data.error === "string" ? data.error : "无法发起登录" };
        }
        return {
          ok: true,
          start: {
            userCode: typeof data.userCode === "string" ? data.userCode : "",
            verificationUri: typeof data.verificationUri === "string" ? data.verificationUri : "",
            intervalMs: typeof data.intervalMs === "number" ? data.intervalMs : 5000,
            expiresAt: typeof data.expiresAt === "number" ? data.expiresAt : Date.now() + 15 * 60_000
          }
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "无法发起登录" };
      }
    },

    /**
     * 发起**浏览器授权码**登录：拿到服务端授权入口地址（不含任何凭据）。
     *
     * 只有浏览器与本机宿主同机（loopback）时才该调用它：宿主会用这里传的 origin 拼
     * redirect_uri，非 loopback 会被宿主拒绝（返回 unsupported）。
     *
     * serverUrl 是面板里**当前这个**地址（可能还是没保存的草稿）。必须传：宿主自己只知道
     * 部署配置或已登录会话里的地址，手填地址的人否则会被判成「还没有配置服务端地址」，
     * 然后静默改走短码。
     */
    async startOauthLogin(input: { origin: string; serverUrl?: string }): Promise<RemoteOAuthStartOutcome> {
      try {
        const result = await transport.request({
          path: `${HANDLER_BASE}/${REMOTE_SERVER_OAUTH_START_ROUTE}`,
          method: "POST",
          body: input.serverUrl === undefined ? { origin: input.origin } : { origin: input.origin, serverUrl: input.serverUrl }
        });
        if (!result.ok) return { ok: false, unsupported: false, error: result.error };
        const data = (result.data ?? {}) as Record<string, unknown>;
        if (data.ok !== true) {
          return {
            ok: false,
            // 稳定码 unsupported：宿主没有这条路径（旧版本/站内相对地址），面板直接改走短码。
            unsupported: data.error === OAUTH_LOGIN_UNSUPPORTED,
            error: typeof data.message === "string" && data.message !== "" ? data.message : "无法发起浏览器登录"
          };
        }
        const attemptId = typeof data.attemptId === "string" ? data.attemptId : "";
        const authorizeUrl = typeof data.authorizeUrl === "string" ? data.authorizeUrl : "";
        if (attemptId === "" || authorizeUrl === "") {
          return { ok: false, unsupported: false, error: "宿主返回的浏览器登录信息形状不符" };
        }
        return {
          ok: true,
          attemptId,
          authorizeUrl,
          expiresAt:
            typeof data.expiresAt === "number" && Number.isFinite(data.expiresAt)
              ? data.expiresAt
              : Date.now() + REMOTE_SERVER_OAUTH_POLL_TIMEOUT_MS
        };
      } catch (error) {
        return { ok: false, unsupported: false, error: error instanceof Error ? error.message : "无法发起浏览器登录" };
      }
    },

    /**
     * 轮询一次浏览器登录。
     *
     * `approved` 时宿主已经落好会话并给出快照（**令牌从不经过这个方法**）。
     * 网络失败一律当 `pending`：一次抖动不该等于「登录失败」，终止判断交给面板的超时。
     */
    async pollOauthLogin(attemptId: string): Promise<RemoteOAuthLoginPoll> {
      try {
        const result = await transport.request({
          path: `${HANDLER_BASE}/${REMOTE_SERVER_OAUTH_POLL_ROUTE}`,
          method: "POST",
          body: { attemptId }
        });
        if (!result.ok) return { state: "pending" };
        const data = (result.data ?? {}) as Record<string, unknown>;
        if (data.state === "approved") {
          const snapshot = readSnapshot(data.snapshot);
          return snapshot ? { state: "approved", snapshot } : { state: "failed", error: "宿主返回的会话形状不符" };
        }
        if (data.state === "failed") {
          return {
            state: "failed",
            // 稳定码只用于排障/上报；界面只用下面那句中文。
            ...(typeof data.code === "string" && data.code !== "" ? { code: data.code } : {}),
            error: typeof data.error === "string" && data.error !== "" ? data.error : "浏览器登录没有完成，请改用短码"
          };
        }
        return { state: "pending" };
      } catch {
        return { state: "pending" };
      }
    },

    /**
     * 轮询一次设备码登录。
     *
     * `approved` 时宿主已保存会话，这里拿到的只是状态快照——**令牌从不经过这个方法**。
     */
    async pollDeviceLogin(): Promise<
      { state: "pending" | "denied" | "expired" } | { state: "approved"; snapshot: RemoteServerSnapshot }
    > {
      try {
        const result = await transport.request({
          path: `${HANDLER_BASE}/${REMOTE_SERVER_DEVICE_POLL_ROUTE}`,
          method: "POST",
          body: {}
        });
        if (!result.ok) return { state: "pending" };
        const data = (result.data ?? {}) as Record<string, unknown>;
        if (data.state === "approved") {
          const snapshot = readSnapshot(data.snapshot);
          return snapshot ? { state: "approved", snapshot } : { state: "expired" };
        }
        if (data.state === "denied") return { state: "denied" };
        if (data.state === "expired") return { state: "expired" };
        return { state: "pending" };
      } catch {
        return { state: "pending" };
      }
    },

    /** 断开：撤销远端会话（尽力）并清本地登录态。 */
    async logout(): Promise<{ ok: true } | { ok: false; error: string }> {
      try {
        const result = await transport.request({
          path: `${HANDLER_BASE}/${REMOTE_SERVER_LOGOUT_ROUTE}`,
          method: "POST",
          body: {}
        });
        if (!result.ok) return { ok: false, error: result.error };
        const data = (result.data ?? {}) as Record<string, unknown>;
        return data.ok === true ? { ok: true } : { ok: false, error: typeof data.error === "string" ? data.error : "断开失败" };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "断开失败" };
      }
    },

    /**
     * 把一张**仅本机**的画布显式启用为远端画布。
     *
     * 登录远端只代表「远端可用」，不再等于「本地画布自动上传」：每张画布要用户自己点一次。
     * 这里只负责把请求交给宿主 handler（远端调用、凭证与登记都在宿主侧），成败都收敛成
     * 结构化结果——组件据此在按钮旁给出可读原因并允许重试。
     *
     * 启用只是登记，真正的首次推送发生在画布于本机被加载之后；调用方在成功后刷新目录并
     * 切到这张画布，不在这里做轮询。
     */
    async enableCanvasSync(canvasId: string): Promise<RemoteServerSyncEnableResult> {
      try {
        const result = await transport.request({
          path: `${HANDLER_BASE}/${REMOTE_SERVER_SYNC_ENABLE_ROUTE}`,
          method: "POST",
          body: { canvasId }
        });
        if (!result.ok) return { ok: false, error: result.error };
        const data = (result.data ?? {}) as Record<string, unknown>;
        if (data.ok !== true) {
          return { ok: false, error: typeof data.error === "string" ? data.error : "无法启用远端同步" };
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "无法启用远端同步" };
      }
    },

    /**
     * 读一张远端画布的协作者名单。
     *
     * 授权结论（canManage / isOwner / complete）全部来自服务端，浏览器只渲染：
     * 界面上「是否显示写操作」不是一个可以就地推导的判断，作者身份与部署管理员权限都只有
     * 服务端知道。读取失败收敛成结构化结果——窗口要能说清读不到的原因，而不是白屏。
     */
    async loadCanvasMembers(canvasId: string): Promise<RemoteCanvasMembersResult> {
      try {
        const result = await transport.request({
          path: `${HANDLER_BASE}/${REMOTE_SERVER_CANVAS_MEMBERS_ROUTE}`,
          method: "POST",
          body: { canvasId }
        });
        if (!result.ok) return { ok: false, error: result.error };
        const decoded = decodeRemoteCanvasMembersResult(result.data);
        if (!decoded) return { ok: false, error: "宿主返回的协作者名单形状不符" };
        return decoded;
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "读取协作者失败" };
      }
    },

    /** 新增或调整一名协作者（只读协同 / 可写协同）。 */
    async upsertCanvasMember(input: {
      canvasId: string;
      actorId: string;
      role: RemoteCanvasRole;
    }): Promise<RemoteCanvasMemberMutationResult> {
      try {
        const result = await transport.request({
          path: `${HANDLER_BASE}/${REMOTE_SERVER_CANVAS_MEMBER_UPSERT_ROUTE}`,
          method: "POST",
          body: { canvasId: input.canvasId, actorId: input.actorId, role: input.role }
        });
        if (!result.ok) return { ok: false, error: result.error };
        const decoded = decodeRemoteCanvasMemberMutationResult(result.data);
        if (!decoded) return { ok: false, error: "宿主返回的协作者写入结果形状不符" };
        return decoded;
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "保存协作者失败" };
      }
    },

    /** 移除一名协作者。远端对不存在的记录也按成功处理（幂等），界面刷新名单即可。 */
    async removeCanvasMember(input: {
      canvasId: string;
      actorId: string;
    }): Promise<RemoteCanvasMemberMutationResult> {
      try {
        const result = await transport.request({
          path: `${HANDLER_BASE}/${REMOTE_SERVER_CANVAS_MEMBER_REMOVE_ROUTE}`,
          method: "POST",
          body: { canvasId: input.canvasId, actorId: input.actorId }
        });
        if (!result.ok) return { ok: false, error: result.error };
        const decoded = decodeRemoteCanvasMemberMutationResult(result.data);
        if (!decoded) return { ok: false, error: "宿主返回的协作者移除结果形状不符" };
        return decoded;
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "移除协作者失败" };
      }
    },

    /**
     * 读一张远端画布的「链接分享」设置：模式 + 修订号 + 能不能改。
     *
     * 打开协作窗口时与成员名单**并行**读一次，之后不轮询：分享模式是低频配置，变更由用户
     * 动作驱动。权限结论（canManage）来自服务端，界面只按它决定是否渲染可保存的选择器。
     * 读取失败收敛成结构化结果——窗口要能说清读不到的原因，而不是把整块分享区藏掉。
     */
    async loadCanvasShare(canvasId: string): Promise<RemoteCanvasShareResult> {
      try {
        const result = await transport.request({
          path: `${HANDLER_BASE}/${REMOTE_SERVER_CANVAS_SHARE_ROUTE}`,
          method: "POST",
          body: { canvasId }
        });
        if (!result.ok) return { ok: false, error: result.error };
        const decoded = decodeRemoteCanvasShareResult(result.data);
        if (!decoded) return { ok: false, error: "宿主返回的分享设置形状不符" };
        return decoded;
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "读取分享设置失败" };
      }
    },

    /**
     * 修改分享模式（只有作者或部署管理员能成功；授权由服务端现算，这里不自证）。
     *
     * 必须带上**读到的 revision**：服务端按 CAS 拒绝过期写入（冲突文案含「已被其他人修改」），
     * 界面据此清空待保存选择、提示并重读，而不是盲目覆盖别人的修改。成功后用服务端返回的
     * 新 revision 更新本地读模型，下一次保存才对得上。
     */
    async updateCanvasShare(input: {
      canvasId: string;
      mode: RemoteCanvasShareMode;
      expectedRevision: string;
    }): Promise<RemoteCanvasShareUpdateResult> {
      try {
        const result = await transport.request({
          path: `${HANDLER_BASE}/${REMOTE_SERVER_CANVAS_SHARE_UPDATE_ROUTE}`,
          method: "POST",
          body: {
            canvasId: input.canvasId,
            mode: input.mode,
            expectedRevision: input.expectedRevision
          }
        });
        if (!result.ok) return { ok: false, error: result.error };
        const decoded = decodeRemoteCanvasShareUpdateResult(result.data);
        if (!decoded) return { ok: false, error: "宿主返回的分享修改结果形状不符" };
        return decoded;
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "保存分享设置失败" };
      }
    },

    /**
     * 读一张远端画布的协作邀请列表。
     *
     * 只有作者/部署管理员能读（服务端现算，普通协作者会得到 permission_denied）。列表里
     * **没有链接**：token 只在创建时出现一次，需要再分享就重新创建一条。读取失败收敛成
     * 结构化结果，窗口据此给原因而不是白屏。
     */
    async loadCanvasInvites(canvasId: string): Promise<RemoteCanvasInvitesResult> {
      try {
        const result = await transport.request({
          path: `${HANDLER_BASE}/${REMOTE_SERVER_CANVAS_INVITES_ROUTE}`,
          method: "POST",
          body: { canvasId }
        });
        if (!result.ok) return { ok: false, error: result.error };
        const decoded = decodeRemoteCanvasInvitesResult(result.data);
        if (!decoded) return { ok: false, error: "宿主返回的协作邀请列表形状不符" };
        return decoded;
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "读取协作邀请失败" };
      }
    },

    /**
     * 创建一条协作邀请，拿回**服务端签发的链接**。
     *
     * 客户端只把 url 原样展示/复制：它由部署的对外地址决定，不能拿 location.origin 拼。
     * 返回的 url 可能是空串（服务端未配置对外地址），界面必须报错并禁用复制——这不是
     * "创建失败"，邀请可能已经签发，只是没有可分享的绝对地址。
     */
    async createCanvasInvite(input: {
      canvasId: string;
      role: RemoteCanvasRole;
      expiresInSeconds: number;
    }): Promise<RemoteCanvasInviteCreateResult> {
      try {
        const result = await transport.request({
          path: `${HANDLER_BASE}/${REMOTE_SERVER_CANVAS_INVITE_CREATE_ROUTE}`,
          method: "POST",
          body: {
            canvasId: input.canvasId,
            role: input.role,
            expiresInSeconds: input.expiresInSeconds
          }
        });
        if (!result.ok) return { ok: false, error: result.error };
        const decoded = decodeRemoteCanvasInviteCreateResult(result.data);
        if (!decoded) return { ok: false, error: "宿主返回的协作邀请形状不符" };
        return decoded;
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "创建协作邀请失败" };
      }
    },

    /** 撤销一条协作邀请。撤销只影响后续接受，不会移除已经接受的人。 */
    async revokeCanvasInvite(input: {
      canvasId: string;
      inviteId: string;
    }): Promise<RemoteCanvasInviteRevokeResult> {
      try {
        const result = await transport.request({
          path: `${HANDLER_BASE}/${REMOTE_SERVER_CANVAS_INVITE_REVOKE_ROUTE}`,
          method: "POST",
          body: { canvasId: input.canvasId, inviteId: input.inviteId }
        });
        if (!result.ok) return { ok: false, error: result.error };
        const decoded = decodeRemoteCanvasInviteRevokeResult(result.data);
        if (!decoded) return { ok: false, error: "宿主返回的撤销结果形状不符" };
        return decoded;
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "撤销协作邀请失败" };
      }
    },

    /**
     * 重新探测服务端托管生成目录（「刷新模型」）。
     *
     * 只拿受控状态（可用性、模型数量、目录修订号）：模型定义已经在宿主注册表里，浏览器
     * 不接触它们。刷新失败收敛成结构化结果，不把错误抛到组件外——按钮旁要能显示原因。
     */
    async refreshGenerationModels(): Promise<
      { ok: true; status: RemoteServerGenerationStatus } | { ok: false; error: string }
    > {
      try {
        const result = await transport.request({
          path: `${HANDLER_BASE}/${REMOTE_SERVER_GENERATION_REFRESH_ROUTE}`,
          method: "POST",
          body: {}
        });
        if (!result.ok) return { ok: false, error: result.error };
        const data = (result.data ?? {}) as Record<string, unknown>;
        return {
          ok: true,
          status: {
            available: data.available === true,
            modelCount:
              typeof data.modelCount === "number" && Number.isFinite(data.modelCount) ? data.modelCount : 0,
            catalogRevision:
              typeof data.catalogRevision === "number" && Number.isFinite(data.catalogRevision)
                ? data.catalogRevision
                : 0,
            error: typeof data.error === "string" && data.error !== "" ? data.error : null
          }
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "刷新模型失败" };
      }
    },

    /**
     * 读一次宿主诊断缓冲（已脱敏的接入与同步上游事件）。
     *
     * 全部异常都收敛成结构化失败：调试窗口本身不该因为一次读失败就崩掉，也不该把
     * 「宿主不支持」说成「最近没有事件」。
     */
    async loadDiagnostics(): Promise<RemoteDiagnosticsReadResult> {
      try {
        const result = await transport.request({
          path: `${HANDLER_BASE}/${REMOTE_SERVER_DIAGNOSTICS_ROUTE}`,
          method: "POST",
          body: {}
        });
        if (!result.ok) return { ok: false, error: result.error };
        const snapshot = readDiagnosticsSnapshot(result.data);
        if (!snapshot) return { ok: false, error: "宿主返回的诊断数据形状不符" };
        return { ok: true, snapshot };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "读取接入日志失败" };
      }
    },

    /**
     * 把当前诊断缓冲上报到已连接的服务端。
     *
     * 由宿主代发（令牌不出宿主）；浏览器只拿到受理条数或一条可展示的原因。
     *
     * `frontendVersion` 必须由浏览器带上：条目是宿主记的，但"这是哪一次构建的前端"只有
     * 浏览器知道（它的构建期常量）。宿主只做形状校验后转给服务端，不猜、不编。
     */
    async reportDiagnostics(): Promise<RemoteDiagnosticsReportResult> {
      try {
        const result = await transport.request({
          path: `${HANDLER_BASE}/${REMOTE_SERVER_DIAGNOSTICS_REPORT_ROUTE}`,
          method: "POST",
          body: { frontendVersion: appBuildVersion() }
        });
        if (!result.ok) return { ok: false, error: result.error };
        const data = (result.data ?? {}) as Record<string, unknown>;
        if (data.ok !== true) {
          return { ok: false, error: typeof data.error === "string" ? data.error : "上报失败" };
        }
        return {
          ok: true,
          acceptedCount: typeof data.acceptedCount === "number" && Number.isFinite(data.acceptedCount) ? data.acceptedCount : 0
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "上报失败" };
      }
    }
  };
}

/** 订阅式读模型：页面与徽标共用同一份状态，避免各自轮询出两个结论。 */
export function createRemoteServerService(transport: RemoteServerTransport) {
  const api = createRemoteServerApi(transport);
  let snapshot: RemoteServerSnapshot = { ...LOCAL_ONLY_SNAPSHOT };
  let loaded = false;
  let inflight: Promise<RemoteServerSnapshot> | null = null;
  /**
   * 状态版本。
   *
   * 登录/登出会**本地推进**状态（`setSnapshot`），而在途的 `refresh` 可能更晚返回。若不做
   * 版本校验，一次迟到的旧快照就会把刚登录的界面打回「本地模式」——用户看到的是「登录
   * 成功又立刻掉线」。这与仓库对迟到结果的既有处理一致：过期结果一律丢弃。
   */
  let epoch = 0;
  const listeners = new Set<() => void>();

  const publish = (next: RemoteServerSnapshot) => {
    if (
      snapshot.phase === next.phase &&
      snapshot.serverUrl === next.serverUrl &&
      snapshot.subject === next.subject &&
      snapshot.displayName === next.displayName &&
      snapshot.expiresAt === next.expiresAt &&
      snapshot.error === next.error &&
      snapshot.methods.length === next.methods.length
    ) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) listener();
  };

  return {
    api,
    getSnapshot: (): RemoteServerSnapshot => snapshot,
    /** 是否已经问过一次宿主；未问过时界面应显示「读取中」而不是「未连接」。 */
    isLoaded: (): boolean => loaded,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async refresh(): Promise<RemoteServerSnapshot> {
      // 并发刷新共享同一次请求：页面挂载与徽标挂载会同时来一次。
      const requestEpoch = epoch;
      inflight ??= api.loadSnapshot().then((next) => {
        inflight = null;
        // 期间发生过登录/登出：这份结果已经过期，丢弃。
        if (requestEpoch !== epoch) return snapshot;
        loaded = true;
        publish(next);
        return next;
      });
      return inflight;
    },
    setSnapshot(next: RemoteServerSnapshot): void {
      // 本地权威推进：作废任何在途刷新。
      epoch += 1;
      loaded = true;
      publish(next);
    },
    dispose(): void {
      epoch += 1;
      listeners.clear();
    }
  };
}

export type RemoteServerService = ReturnType<typeof createRemoteServerService>;
