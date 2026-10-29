/**
 * fake 远端：按公开契约实现 Connect 的 HTTP/JSON 线格式。
 *
 * 为什么用 fake 而不是连真进程：这里的被测对象是**本扩展的协议解释与状态收敛**
 * （登录、WhoAmI 收敛、到期判定、登出幂等），不是远端实现。真实远端已由 `server/e2e`
 * 覆盖；两边只在「Connect JSON 形状」这一层对齐，因此 fake 必须照 proto 的字段名写。
 */
import { createHash } from "node:crypto";
import type { RemoteServerDeployment } from "../src/deployment.js";

/** 服务端托管生成的 fake 任务（字段名照 proto 的 ProtoJSON）。 */
export type FakeGenerationTask = {
  taskId: string;
  idempotencyKey: string;
  modelKey: string;
  modelType: string;
  state: string;
  polls: number;
  result?: { text?: unknown; media?: unknown };
  error?: { code: string; retryable: boolean };
};

/** 一个任务终态怎么返回：文本、稳定媒体或稳定失败码。 */
export type FakeGenerationTaskResult =
  | { kind: "text"; text: string }
  | { kind: "media"; media: Record<string, unknown> }
  | { kind: "failed"; code: string; retryable?: boolean };

export type FakeGenerationOptions = {
  /** 5 个 RPC 全部回 501 unimplemented（模拟服务端尚未实现托管生成）。 */
  unimplemented?: boolean;
  /** 协议协商字段（缺省 protocolVersion=1 / features=["catalog"]）。 */
  capabilities?: { protocolVersion?: number; features?: string[]; pollAfterMs?: number };
  /** 目录（测试可直接改 `fake.generation.catalog` 来模拟目录变化）。 */
  catalog?: { available?: boolean; reason?: string; catalogRevision?: number; models?: unknown[] };
  /** 轮询到第二次 GetTask 时的终态（缺省 text）。 */
  taskResult?: FakeGenerationTaskResult;
  /** SubmitTask 直接以 FAILED 返回（模拟稳定拒绝；稳定码经 GetTask 读取）。 */
  rejectSubmitWith?: string;
};

/** fake 的一张画布 ACL：作者与协作者。 */
export type FakeCanvasAclConfig = {
  owner?: string;
  members?: Record<string, "viewer" | "editor">;
};

/** fake 里画布 ACL 的可变状态（测试可断言写入结果）。 */
export type FakeCanvasAclState = {
  owner: string;
  members: Map<string, { role: "viewer" | "editor"; grantedBy: string; grantedAt: string }>;
};

/** fake 的一张画布的链接分享模式（与 proto 的 CanvasShareMode 三档一一对应）。 */
export type FakeCanvasShareMode = "restricted" | "everyone_view" | "everyone_edit";

/** fake 的分享设置初始值；测试可只给模式，revision 缺省 0。 */
export type FakeCanvasShareConfig = { mode?: FakeCanvasShareMode; revision?: number };

/** fake 里分享设置的可变状态（测试可断言写入结果）。 */
export type FakeCanvasShareState = { mode: FakeCanvasShareMode; revision: number };

/** fake 的一条协作邀请（字段与 proto CanvasInvite 对齐，角色折成两档）。 */
export type FakeCanvasInvite = {
  inviteId: string;
  role: "viewer" | "editor";
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedCount: number;
  lastAcceptedAt: string;
  revoked: boolean;
};

/** fake 的邀请初始值；测试可只给关心的字段，其余由 createFakeServer 补缺省。 */
export type FakeCanvasInviteConfig = Partial<FakeCanvasInvite>;

export type FakeServerOptions = {
  /** 机器凭证 → 主体。 */
  identities?: Record<string, string>;
  /** 会话有效期（毫秒）。 */
  sessionTtlMs?: number;
  /** 让所有请求失败（模拟不可达）。 */
  down?: boolean;
  /** 让 Login 返回未认证（模拟坏凭证）。 */
  rejectLogin?: boolean;
  /** 网关断言主体（模拟企业网关登录）；设置后带断言头的 Login 直接成功。 */
  gatewaySubject?: string;
  /** WhoAmI 返回的主体（模拟别名表把渠道身份折到另一个主体）。 */
  whoAmIOverride?: string;
  /** 网关断言是否可用（只影响 GetAuthMethods 的 ambient 标记）。 */
  gatewayAmbient?: boolean;
  /** 让 `ReportDiagnostics` 返回 501 `unimplemented`（模拟服务端尚未实现诊断上报）。 */
  diagnosticsUnimplemented?: boolean;
  /** 让第 N 次 `ReportDiagnostics` 失败（1 起算），模拟多批中途断掉。 */
  diagnosticsFailOnCall?: number;
  /** 覆盖 `acceptedCount` 的返回值；缺省等于本批收到的条目数（模拟服务端按自己的规则计数）。 */
  diagnosticsAcceptedCount?: number;
  /**
   * 让 `ReportDiagnostics` 返回空对象 `{}`。
   *
   * 这是 proto3 JSON 对零值的真实编码：幂等键命中导致「新增 0 条」时服务端就回 `{}`，
   * 客户端不能把「字段缺失」当成「不知道」再退化成本批条数。
   */
  diagnosticsOmitAcceptedCount?: boolean;
  /**
   * `ListMyCanvases` 返回的画布 id（缺省只有 `canvas-remote-1`）。
   *
   * 测试可以直接改返回值的 `remoteCanvasIds`：首次推送把本地画布登记到远端目录，正是
   * 「显式启用 → 成为普通远端画布」这条路径的关键一步。
   */
  canvasIds?: string[];
  /**
   * 画布 ACL（作者 / 协作者）。
   *
   * 名单、增删与 allowedActions 都按服务端三层权限语义应答：作者拿
   * `canvas.read/write/share`，editor 拿 read/write，viewer 只 read；`adminSubjects`
   * 里的人拿 `canvas.read/compact/manage`（**不含** `canvas.share`）。
   */
  canvasAcl?: Record<string, FakeCanvasAclConfig>;
  /**
   * 链接分享设置（按画布）。
   *
   * 不在 `canvasIds` 里的画布，只要配置了 ACL 或分享设置，就能按 id 查到——这是为了模拟
   * 「链接打开」：画布不在我的目录里，但拿到链接的已认证主体能读它（everyone_edit 时可写）。
   */
  canvasShare?: Record<string, FakeCanvasShareConfig>;
  /**
   * 协作邀请初始值（按画布）。
   *
   * 列表/创建/撤销都按服务端语义应答：只有作者或部署管理员能管理；创建返回
   * `inviteUrl`（缺省按邀请 id 拼一个绝对地址），`inviteUrlUnconfigured` 时回
   * failed_precondition（模拟部署没有配置对外地址）。
   */
  canvasInvites?: Record<string, FakeCanvasInviteConfig[]>;
  /** 创建邀请时服务端返回的链接；缺省 `https://canvas.example.com/invite/<inviteId>`。 */
  inviteUrl?: string;
  /** 让 CreateCanvasInvite 回 failed_precondition（部署未配置对外地址）。 */
  inviteUrlUnconfigured?: boolean;
  /** 全局管理员主体；用于验证「管理员能代管成员，但没有 canvas.share」这条边界。 */
  adminSubjects?: string[];
  /** 服务端托管生成（change: 2026-10-20-reserve-remote-generation-provider）。 */
  generation?: FakeGenerationOptions;
  /**
   * 浏览器授权码一步签发的本服务授权码由测试通过 `grantLocalLoginCode` 登记；这里只控制
   * 登记之后远端是否认账（模拟「码已用过 / redirect 不匹配 / PKCE 不匹配」的服务端拒绝）。
   */
  rejectLocalExchange?: boolean;
  /** 换码成功后签发的主体（缺省 `oauth-alice`）。 */
  localLoginSubject?: string;
};

export type FakeServer = {
  fetch: typeof globalThis.fetch;
  /** 收到的请求路径（不含 origin），用于断言「没有把令牌放进 URL」。 */
  calls: Array<{ path: string; authorization: string | null; body: unknown }>;
  /** 当前有效会话（token → subject）。 */
  sessions: Map<string, string>;
  /** 已撤销的会话 token。 */
  revoked: string[];
  /** 远端目录当前包含的画布 id；可变，用来模拟「首次推送后远端登记」与后续目录变化。 */
  remoteCanvasIds: string[];
  /** 画布 ACL 的可变状态；测试可直接断言写入结果。 */
  canvasAcls: Map<string, FakeCanvasAclState>;
  /** 链接分享设置的可变状态（按画布）；测试可直接断言写入与 revision 递增。 */
  canvasShares: Map<string, FakeCanvasShareState>;
  /** 协作邀请的可变状态（按画布）；测试可直接断言创建/撤销结果。 */
  canvasInvites: Map<string, FakeCanvasInvite[]>;
  /**
   * 服务端托管生成的 fake 状态：测试可直接改 `catalog.catalogRevision` / `catalog.models`
   * 模拟「服务端新增模型」，或用 `tasks` 断言提交/轮询/取消。
   */
  generation: {
    capabilities: { protocolVersion: number; features: string[]; pollAfterMs: number };
    catalog: { available: boolean; reason: string; catalogRevision: number; models: unknown[] };
    tasks: Map<string, FakeGenerationTask>;
    submits: Array<Record<string, unknown>>;
    cancels: string[];
    taskResult: FakeGenerationTaskResult;
  };
  deployment: RemoteServerDeployment;
  serverUrl: string;
  /**
   * 模拟服务端 `/tof/authorize` 那一步签发的**本服务一次性授权码**。
   *
   * 真实链路里这个码由服务端在浏览器回调时带回来；测试直接把它交给宿主的 loopback 回调，
   * 于是被测的是宿主「换码 → 落会话 → 轮询交付」这一段，而不是远端实现（那由 server/e2e 覆盖）。
   */
  grantLocalLoginCode: (input: { code: string; challenge?: string }) => void;
};

const enc = new TextEncoder();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** fake 的画布标题：目录列表与按 id 读取共用一份，避免两处口径分叉。 */
function fakeCanvasTitle(canvasId: string): string {
  return canvasId === "canvas-remote-1" ? "远端画布" : `画布 ${canvasId}`;
}

/** proto 的 CanvasShareMode 名 → fake 的三档；未知值返回 null。 */
function shareModeFromProtoName(value: unknown): FakeCanvasShareMode | null {
  if (value === "CANVAS_SHARE_MODE_RESTRICTED") return "restricted";
  if (value === "CANVAS_SHARE_MODE_EVERYONE_VIEW") return "everyone_view";
  if (value === "CANVAS_SHARE_MODE_EVERYONE_EDIT") return "everyone_edit";
  return null;
}

/** fake 的三档 → proto 的 CanvasShareMode 名。 */
function shareModeToProtoName(mode: FakeCanvasShareMode): string {
  if (mode === "everyone_view") return "CANVAS_SHARE_MODE_EVERYONE_VIEW";
  if (mode === "everyone_edit") return "CANVAS_SHARE_MODE_EVERYONE_EDIT";
  return "CANVAS_SHARE_MODE_RESTRICTED";
}

/** 一条 fake 邀请 → proto JSON：枚举名 + int32 数字；零值字段照 proto3 省略。 */
function inviteToProtoJson(invite: FakeCanvasInvite): Record<string, unknown> {
  return {
    inviteId: invite.inviteId,
    role: invite.role === "viewer" ? "CANVAS_ROLE_VIEWER" : "CANVAS_ROLE_EDITOR",
    createdBy: invite.createdBy,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    // proto3 JSON 省略零值：客户端的缺省处理必须经得起「字段不在」。
    ...(invite.acceptedCount > 0 ? { acceptedCount: invite.acceptedCount } : {}),
    ...(invite.lastAcceptedAt !== "" ? { lastAcceptedAt: invite.lastAcceptedAt } : {}),
    ...(invite.revoked ? { revoked: true } : {})
  };
}

/** 读 ProtoJSON 的 int64（字符串或数字）；非法返回 null。 */
function readProtoRevision(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

export function createFakeServer(options: FakeServerOptions = {}): FakeServer {
  const identities = options.identities ?? { "device-token": "device-alice" };
  const sessionTtlMs = options.sessionTtlMs ?? 60 * 60 * 1000;
  const sessions = new Map<string, string>();
  const revoked: string[] = [];
  const calls: FakeServer["calls"] = [];
  /** 远端目录：可变数组，测试可直接 push 来模拟「首次推送后远端登记」。 */
  const remoteCanvasIds = [...(options.canvasIds ?? ["canvas-remote-1"])];
  let counter = 0;
  /** 进行中的设备码登录：演示「发起 → 轮询获批」这条主路径。 */
  let pendingDevice: { deviceCode: string; userCode: string; expiresAt: string } | null = null;
  let deviceCounter = 0;
  /** `ReportDiagnostics` 已收到的次数（1 起算，模拟分批上报的进度）。 */
  let diagnosticsCalls = 0;
  /** 已签发的一次性授权码：换码成功一次即作废（与服务端「先消费再使用」一致）。 */
  const localLoginCodes = new Map<string, { challenge: string | null; used: boolean }>();

  // ---- 画布 ACL fake 状态（按公开的三种授权通道建模） ----
  const canvasAcls = new Map<string, FakeCanvasAclState>();
  for (const [canvasId, acl] of Object.entries(options.canvasAcl ?? {})) {
    canvasAcls.set(canvasId, {
      owner: acl.owner ?? "",
      members: new Map(
        Object.entries(acl.members ?? {}).map(([actorId, role]) => [
          actorId,
          { role, grantedBy: "", grantedAt: "2026-10-18T00:00:00Z" }
        ])
      )
    });
  }
  // ---- 链接分享 fake 状态（restricted / everyone_view / everyone_edit + revision） ----
  const canvasShares = new Map<string, FakeCanvasShareState>();
  for (const [canvasId, share] of Object.entries(options.canvasShare ?? {})) {
    canvasShares.set(canvasId, { mode: share.mode ?? "restricted", revision: share.revision ?? 0 });
  }
  // ---- 协作邀请 fake 状态（服务端签发链接；按画布） ----
  const canvasInvites = new Map<string, FakeCanvasInvite[]>();
  for (const [canvasId, list] of Object.entries(options.canvasInvites ?? {})) {
    canvasInvites.set(
      canvasId,
      list.map((invite, index) => ({
        inviteId: invite.inviteId ?? `${canvasId}-invite-${index + 1}`,
        role: invite.role ?? "viewer",
        createdBy: invite.createdBy ?? "alice",
        createdAt: invite.createdAt ?? "2026-10-18T03:00:00Z",
        expiresAt: invite.expiresAt ?? "2026-10-25T03:00:00Z",
        acceptedCount: invite.acceptedCount ?? 0,
        lastAcceptedAt: invite.lastAcceptedAt ?? "",
        revoked: invite.revoked ?? false
      }))
    );
  }
  let inviteCounter = 0;
  const invitesOf = (canvasId: string): FakeCanvasInvite[] => {
    const stored = canvasInvites.get(canvasId);
    if (stored) return stored;
    const empty: FakeCanvasInvite[] = [];
    canvasInvites.set(canvasId, empty);
    return empty;
  };
  const adminSubjects = [...(options.adminSubjects ?? [])];
  const bearerSubject = (authorization: string | null): string | null => {
    const token = authorization?.replace(/^Bearer\s+/i, "") ?? "";
    return sessions.get(token) ?? null;
  };
  /**
   * 取一张画布的 ACL；远端目录里、或配置了 ACL / 分享设置的，按「存在」处理（迁移遗留无属主）。
   * 未登记的画布返回 null（调用方按 not_found / 无权限应答）。
   *
   * 「配置了分享但不在目录里」也算存在：链接打开的正是这类画布——它不在我的目录里，
   * 但按 id 查得到（见 server 的 GetCanvas，不依赖 ListMyCanvases）。
   */
  const aclOf = (canvasId: string): FakeCanvasAclState | null => {
    const stored = canvasAcls.get(canvasId);
    if (stored) return stored;
    if (!remoteCanvasIds.includes(canvasId) && !canvasShares.has(canvasId) && !canvasInvites.has(canvasId)) return null;
    const empty: FakeCanvasAclState = { owner: "", members: new Map() };
    canvasAcls.set(canvasId, empty);
    return empty;
  };
  /** 一张画布当前的分享设置；从未设置过就是默认的 restricted / revision 0。 */
  const shareOf = (canvasId: string): FakeCanvasShareState => {
    const stored = canvasShares.get(canvasId);
    if (stored) return stored;
    const initial: FakeCanvasShareState = { mode: "restricted", revision: 0 };
    canvasShares.set(canvasId, initial);
    return initial;
  };
  /**
   * 一张画布上的动作结论，按公开的画布授权语义判断：
   *
   * - 作者：read / write / share；editor 协作者：read / write；viewer 协作者：read；
   * - 部署管理员：read / compact / manage（**不含** write 与 share）；
   * - 链接分享只在主体**没有**从上面三条通道拿到内容权限时补：everyone_view 补 read，
   *   everyone_edit 再补 write；不覆盖显式关系，也不带来 share / manage。
   */
  const decisionFor = (canvasId: string, acl: FakeCanvasAclState, subject: string) => {
    const isAdmin = adminSubjects.includes(subject);
    const isOwner = acl.owner !== "" && acl.owner === subject;
    const memberRole = acl.members.get(subject)?.role;
    const allowed: string[] = [];
    if (isOwner) allowed.push("canvas.read", "canvas.write", "canvas.share");
    else if (memberRole === "editor") allowed.push("canvas.read", "canvas.write");
    else if (memberRole === "viewer") allowed.push("canvas.read");
    if (isAdmin) {
      // 管理端通道与作者/协作者通道正交：能看能管，但**不**改内容、不改分享。
      for (const action of ["canvas.read", "canvas.compact", "canvas.manage"]) {
        if (!allowed.includes(action)) allowed.push(action);
      }
    }
    if (!allowed.includes("canvas.read") && !allowed.includes("canvas.write")) {
      const mode = shareOf(canvasId).mode;
      if (mode === "everyone_view") allowed.push("canvas.read");
      else if (mode === "everyone_edit") allowed.push("canvas.read", "canvas.write");
    }
    return { allowed, isOwner, memberRole };
  };
  /** 成员代管：作者或部署管理员（与 server 的 authorizeMemberOps 一致）。 */
  const canManageCanvas = (acl: FakeCanvasAclState, subject: string): boolean =>
    (acl.owner !== "" && acl.owner === subject) || adminSubjects.includes(subject);

  // ---- 托管生成 fake 状态（字段名照 proto 的 ProtoJSON） ----
  const generation = {
    capabilities: {
      protocolVersion: options.generation?.capabilities?.protocolVersion ?? 1,
      features: [...(options.generation?.capabilities?.features ?? ["catalog"])],
      pollAfterMs: options.generation?.capabilities?.pollAfterMs ?? 100
    },
    catalog: {
      available: options.generation?.catalog?.available ?? true,
      reason: options.generation?.catalog?.reason ?? "",
      catalogRevision: options.generation?.catalog?.catalogRevision ?? 1,
      models: [...(options.generation?.catalog?.models ?? [])]
    },
    tasks: new Map<string, FakeGenerationTask>(),
    submits: [] as Array<Record<string, unknown>>,
    cancels: [] as string[],
    taskResult: (options.generation?.taskResult ?? { kind: "text", text: "服务端生成的文本" }) as FakeGenerationTaskResult
  };
  let generationTaskCounter = 0;
  const generationBearer = (authorization: string | null): string => authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const isGenerationAuthorized = (authorization: string | null): boolean => sessions.has(generationBearer(authorization));

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
    const parsed = new URL(url);
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const authorization = headers.get("authorization");
    let body: unknown = null;
    try {
      body = init?.body === undefined ? null : JSON.parse(String(init.body));
    } catch {
      body = null;
    }
    calls.push({ path: parsed.pathname, authorization, body });

    if (options.down) throw new TypeError("fetch failed");

    const method = parsed.pathname.split("/").pop() ?? "";

    if (method === "GetServerInfo") {
      return json({ version: "test-1", commit: "abc123", buildTime: "2026-10-19T00:00:00Z" });
    }

    if (method === "GetAuthMethods") {
      return json({
        methods: [
          { kind: "AUTH_METHOD_KIND_MACHINE_TOKEN", id: "machine-token" },
          { kind: "AUTH_METHOD_KIND_GATEWAY_ASSERTION", id: "gateway", ambient: options.gatewayAmbient === true }
        ]
      });
    }

    if (method === "ListMyCanvases") {
      // 目录合并读的是这个接口：远端只返回"我的画布"（作者或协作者）。
      const bearer = authorization?.replace(/^Bearer /i, "") ?? "";
      if (!sessions.has(bearer)) return json({ code: "unauthenticated", message: "未认证" }, 401);
      return json({
        canvases: remoteCanvasIds.map((canvasId) => ({
          canvasId,
          title: fakeCanvasTitle(canvasId),
          state: "CANVAS_STATE_ACTIVE",
          createdAt: "2026-10-18T00:00:00Z",
          updatedAt: "2026-10-18T01:00:00Z"
        }))
      });
    }

    // ---- 画布协作者（CanvasService 成员接口） ----
    if (method === "DeleteCanvas") {
      const subject = bearerSubject(authorization);
      if (subject === null) return json({ code: "unauthenticated", message: "未认证" }, 401);
      const canvasId = (body as { canvasId?: unknown } | null)?.canvasId;
      if (typeof canvasId !== "string" || canvasId === "") {
        return json({ code: "invalid_argument", message: "缺少画布 id" }, 400);
      }
      const acl = aclOf(canvasId);
      if (acl === null) return json({ code: "not_found", message: "画布不存在" }, 404);
      // 删除是作者动作：可写协作者（editor）不蕴含删除（与 server 的 authorize 一致）。
      if (!decisionFor(canvasId, acl, subject).allowed.includes("canvas.share")) {
        return json({ code: "permission_denied", message: "只有画布作者能删除" }, 403);
      }
      const index = remoteCanvasIds.indexOf(canvasId);
      if (index >= 0) remoteCanvasIds.splice(index, 1);
      return json({});
    }

    if (method === "GetCanvas") {
      const subject = bearerSubject(authorization);
      if (subject === null) return json({ code: "unauthenticated", message: "未认证" }, 401);
      const canvasId = (body as { canvasId?: unknown } | null)?.canvasId;
      if (typeof canvasId !== "string" || canvasId === "") {
        return json({ code: "invalid_argument", message: "缺少画布 id" }, 400);
      }
      const acl = aclOf(canvasId);
      if (acl === null) {
        // 看不见与不存在同一结论：不做存在性探测。
        return json({ code: "not_found", message: "画布不存在" }, 404);
      }
      const decision = decisionFor(canvasId, acl, subject);
      if (!decision.allowed.includes("canvas.read")) {
        // 看不见与不存在同一结论：不做存在性探测。
        return json({ code: "not_found", message: "画布不存在" }, 404);
      }
      return json({
        canvas: {
          canvasId,
          title: fakeCanvasTitle(canvasId),
          createdBy: acl.owner,
          state: "CANVAS_STATE_ACTIVE",
          createdAt: "2026-10-18T00:00:00Z",
          updatedAt: "2026-10-18T01:00:00Z",
          role: decision.isOwner || decision.memberRole === "editor" ? "CANVAS_ROLE_EDITOR" : "CANVAS_ROLE_VIEWER",
          isOwner: decision.isOwner,
          allowedActions: decision.allowed
        }
      });
    }

    if (method === "ListCanvasMembers") {
      const subject = bearerSubject(authorization);
      if (subject === null) return json({ code: "unauthenticated", message: "未认证" }, 401);
      const canvasId = (body as { canvasId?: unknown } | null)?.canvasId;
      if (typeof canvasId !== "string" || canvasId === "") {
        return json({ code: "invalid_argument", message: "缺少画布 id" }, 400);
      }
      const acl = aclOf(canvasId);
      // 与 server 一致：先过 read（链接分享也给读），再决定名单给多少。
      if (acl === null || !decisionFor(canvasId, acl, subject).allowed.includes("canvas.read")) {
        return json({ code: "permission_denied", message: "没有权限" }, 403);
      }
      const rows = [...acl.members.entries()].map(([actorId, member]) => ({
        actorId,
        role: member.role === "viewer" ? "CANVAS_ROLE_VIEWER" : "CANVAS_ROLE_EDITOR",
        grantedBy: member.grantedBy,
        grantedAt: member.grantedAt
      }));
      // 完整名单只给能代管成员的人；普通协作者只看到自己那一条（与 server 一致）。
      if (canManageCanvas(acl, subject)) return json({ owner: acl.owner, members: rows });
      return json({ owner: acl.owner === subject ? acl.owner : "", members: rows.filter((row) => row.actorId === subject) });
    }

    if (method === "UpsertCanvasMember") {
      const subject = bearerSubject(authorization);
      if (subject === null) return json({ code: "unauthenticated", message: "未认证" }, 401);
      const request = (body ?? {}) as Record<string, unknown>;
      const acl = typeof request.canvasId === "string" ? aclOf(request.canvasId) : null;
      if (acl === null) return json({ code: "permission_denied", message: "没有权限" }, 403);
      if (!canManageCanvas(acl, subject)) return json({ code: "permission_denied", message: "没有权限" }, 403);
      const actorId = typeof request.actorId === "string" ? request.actorId : "";
      const protoRole = request.role;
      if (protoRole !== "CANVAS_ROLE_VIEWER" && protoRole !== "CANVAS_ROLE_EDITOR") {
        return json({ code: "invalid_argument", message: "角色不合法" }, 400);
      }
      if (actorId === acl.owner) {
        return json({ code: "invalid_argument", message: "作者本人已是最高权限" }, 400);
      }
      const grantedAt = "2026-10-18T02:00:00Z";
      acl.members.set(actorId, {
        role: protoRole === "CANVAS_ROLE_VIEWER" ? "viewer" : "editor",
        grantedBy: subject,
        grantedAt
      });
      return json({ member: { actorId, role: protoRole, grantedBy: subject, grantedAt } });
    }

    if (method === "RemoveCanvasMember") {
      const subject = bearerSubject(authorization);
      if (subject === null) return json({ code: "unauthenticated", message: "未认证" }, 401);
      const request = (body ?? {}) as Record<string, unknown>;
      const acl = typeof request.canvasId === "string" ? aclOf(request.canvasId) : null;
      if (acl === null) return json({ code: "permission_denied", message: "没有权限" }, 403);
      if (!canManageCanvas(acl, subject)) return json({ code: "permission_denied", message: "没有权限" }, 403);
      const actorId = typeof request.actorId === "string" ? request.actorId : "";
      if (!acl.members.delete(actorId)) return json({ code: "not_found", message: "协作者不存在" }, 404);
      return json({});
    }

    if (method === "ListCanvasInvites") {
      const subject = bearerSubject(authorization);
      if (subject === null) return json({ code: "unauthenticated", message: "未认证" }, 401);
      const canvasId = (body as { canvasId?: unknown } | null)?.canvasId;
      if (typeof canvasId !== "string" || canvasId === "") {
        return json({ code: "invalid_argument", message: "缺少画布 id" }, 400);
      }
      const acl = aclOf(canvasId);
      // 与服务端一致：邀请列表是管理面，只有作者或部署管理员能读。
      if (acl === null || !canManageCanvas(acl, subject)) {
        return json({ code: "permission_denied", message: "没有权限" }, 403);
      }
      return json({ invites: invitesOf(canvasId).map(inviteToProtoJson) });
    }

    if (method === "CreateCanvasInvite") {
      const subject = bearerSubject(authorization);
      if (subject === null) return json({ code: "unauthenticated", message: "未认证" }, 401);
      const request = (body ?? {}) as Record<string, unknown>;
      const canvasId = typeof request.canvasId === "string" ? request.canvasId : "";
      const acl = canvasId === "" ? null : aclOf(canvasId);
      if (acl === null || !canManageCanvas(acl, subject)) {
        return json({ code: "permission_denied", message: "没有权限" }, 403);
      }
      const role =
        request.role === "CANVAS_ROLE_VIEWER" ? "viewer" : request.role === "CANVAS_ROLE_EDITOR" ? "editor" : null;
      if (role === null) return json({ code: "invalid_argument", message: "角色不合法" }, 400);
      // 部署没有配置对外地址：服务端签不出绝对链接，回 failed_precondition。
      if (options.inviteUrlUnconfigured) {
        return json({ code: "failed_precondition", message: "未配置对外地址" }, 400);
      }
      // int64 在 ProtoJSON 里是字符串；0 取服务端缺省（7 天）。
      const seconds = request.expiresInSeconds === undefined ? 0 : readProtoRevision(request.expiresInSeconds) ?? 0;
      inviteCounter += 1;
      const inviteId = `invite-${inviteCounter}`;
      const ttlSeconds = seconds > 0 ? seconds : 7 * 24 * 60 * 60;
      const invite: FakeCanvasInvite = {
        inviteId,
        role,
        createdBy: subject,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
        acceptedCount: 0,
        lastAcceptedAt: "",
        revoked: false
      };
      invitesOf(canvasId).push(invite);
      return json({
        inviteId,
        role: role === "viewer" ? "CANVAS_ROLE_VIEWER" : "CANVAS_ROLE_EDITOR",
        expiresAt: invite.expiresAt,
        // url 由“部署配置”决定；测试可用 inviteUrl 固定它，验证宿主原样透传。
        url: options.inviteUrl ?? `https://canvas.example.com/invite/${inviteId}`
      });
    }

    if (method === "RevokeCanvasInvite") {
      const subject = bearerSubject(authorization);
      if (subject === null) return json({ code: "unauthenticated", message: "未认证" }, 401);
      const request = (body ?? {}) as Record<string, unknown>;
      const canvasId = typeof request.canvasId === "string" ? request.canvasId : "";
      const acl = canvasId === "" ? null : aclOf(canvasId);
      if (acl === null || !canManageCanvas(acl, subject)) {
        return json({ code: "permission_denied", message: "没有权限" }, 403);
      }
      const inviteId = typeof request.inviteId === "string" ? request.inviteId : "";
      const invite = invitesOf(canvasId).find((entry) => entry.inviteId === inviteId);
      if (invite === undefined) return json({ code: "not_found", message: "邀请不存在" }, 404);
      invite.revoked = true;
      return json({});
    }

    if (method === "GetCanvasShare") {
      const subject = bearerSubject(authorization);
      if (subject === null) return json({ code: "unauthenticated", message: "未认证" }, 401);
      const canvasId = (body as { canvasId?: unknown } | null)?.canvasId;
      if (typeof canvasId !== "string" || canvasId === "") {
        return json({ code: "invalid_argument", message: "缺少画布 id" }, 400);
      }
      const acl = aclOf(canvasId);
      // 与 server 一致：读分享只要 read 权限（作者、协作者、管理员，以及链接分享带来的读）。
      if (acl === null || !decisionFor(canvasId, acl, subject).allowed.includes("canvas.read")) {
        return json({ code: "permission_denied", message: "没有权限" }, 403);
      }
      const share = shareOf(canvasId);
      return json({ mode: shareModeToProtoName(share.mode), revision: String(share.revision) });
    }

    if (method === "UpdateCanvasShare") {
      const subject = bearerSubject(authorization);
      if (subject === null) return json({ code: "unauthenticated", message: "未认证" }, 401);
      const request = (body ?? {}) as Record<string, unknown>;
      const canvasId = typeof request.canvasId === "string" ? request.canvasId : "";
      if (canvasId === "") return json({ code: "invalid_argument", message: "缺少画布 id" }, 400);
      const acl = aclOf(canvasId);
      // 改分享只属于作者（canvas.share）；部署管理员只有 canvas.manage，不能改分享设置。
      // 链接分享也不蕴含这项能力——与画布授权契约一致。
      if (acl === null || acl.owner === "" || acl.owner !== subject) {
        return json({ code: "permission_denied", message: "没有权限" }, 403);
      }
      const mode = shareModeFromProtoName(request.mode);
      if (mode === null) return json({ code: "invalid_argument", message: "非法的分享模式" }, 400);
      const expected = request.expectedRevision === undefined ? 0 : readProtoRevision(request.expectedRevision);
      if (expected === null) return json({ code: "invalid_argument", message: "非法的 revision" }, 400);
      const share = shareOf(canvasId);
      // expectedRevision=0 表示「按当前值更新」（首次设置或幂等重放）；非 0 时不一致 = 有人先改了。
      if (expected !== 0 && expected !== share.revision) {
        return json({ code: "aborted", message: "分享设置已被其他人修改" }, 409);
      }
      share.mode = mode;
      share.revision += 1;
      return json({ mode: shareModeToProtoName(share.mode), revision: String(share.revision) });
    }

    if (method === "Login") {
      if (options.rejectLogin) {
        return json({ code: "unauthenticated", message: "未认证" }, 401);
      }
      // 远端 resolveLogin：先看请求体令牌，再看请求头里的网关断言。
      const assertion = headers.get("x-example-assertion");
      if (options.gatewaySubject !== undefined && assertion !== null) {
        counter += 1;
        const sessionToken = `session-${counter}`;
        sessions.set(sessionToken, options.gatewaySubject);
        return json({
          sessionToken,
          subjectId: options.gatewaySubject,
          expiresAt: new Date(Date.now() + sessionTtlMs).toISOString()
        });
      }
      const token = (body as { token?: unknown } | null)?.token;
      const subject = typeof token === "string" ? identities[token] : undefined;
      if (!subject) return json({ code: "unauthenticated", message: "未认证" }, 401);
      counter += 1;
      const sessionToken = `session-${counter}`;
      sessions.set(sessionToken, subject);
      return json({
        sessionToken,
        subjectId: subject,
        expiresAt: new Date(Date.now() + sessionTtlMs).toISOString()
      });
    }

    if (method === "WhoAmI") {
      const token = authorization?.replace(/^Bearer\s+/i, "") ?? "";
      const subject = sessions.get(token);
      if (!subject) return json({ code: "unauthenticated", message: "未认证" }, 401);
      return json({
        subjectId: options.whoAmIOverride ?? subject,
        subjectType: "SUBJECT_TYPE_MACHINE",
        expiresAt: new Date(Date.now() + sessionTtlMs).toISOString()
      });
    }

    if (method === "Logout") {
      const token = authorization?.replace(/^Bearer\s+/i, "") ?? "";
      const bodyToken = (body as { sessionToken?: unknown } | null)?.sessionToken;
      // 与远端一致：请求体令牌与 Authorization 不一致时拒绝，不能踢别人的会话。
      if (typeof bodyToken === "string" && bodyToken !== token) {
        return json({ code: "invalid_argument", message: "令牌不一致" }, 400);
      }
      if (sessions.delete(token)) revoked.push(token);
      return json({});
    }

    if (method === "StartDeviceLogin") {
      deviceCounter += 1;
      pendingDevice = {
        deviceCode: `device-code-${deviceCounter}`,
        userCode: `USER-CODE-${deviceCounter}`,
        expiresAt: new Date(Date.now() + sessionTtlMs).toISOString()
      };
      return json({
        deviceCode: pendingDevice.deviceCode,
        userCode: pendingDevice.userCode,
        verificationUri: "https://canvas.example.com/device",
        intervalSeconds: 1,
        expiresAt: pendingDevice.expiresAt
      });
    }

    if (method === "PollDeviceLogin") {
      const deviceCode = (body as { deviceCode?: unknown } | null)?.deviceCode;
      if (!pendingDevice || typeof deviceCode !== "string" || pendingDevice.deviceCode !== deviceCode) {
        return json({ state: "DEVICE_LOGIN_STATE_EXPIRED" });
      }
      // 与远端一致：批准即交付一次性会话，同一设备码之后只会回 expired。
      counter += 1;
      const sessionToken = `session-${counter}`;
      sessions.set(sessionToken, "device-alice");
      pendingDevice = null;
      return json({ state: "DEVICE_LOGIN_STATE_APPROVED", sessionToken });
    }

    if (method === "ExchangeLocalLogin") {
      // 浏览器授权码流程的第二段：宿主拿服务端签发的一次性码 + PKCE verifier + redirect_uri
      // 换会话。这里按服务端语义校验三件事：码一次性、PKCE S256 匹配、redirect_uri 是 loopback。
      const payload = (body ?? {}) as { code?: unknown; codeVerifier?: unknown; redirectUri?: unknown };
      const code = typeof payload.code === "string" ? payload.code : "";
      const verifier = typeof payload.codeVerifier === "string" ? payload.codeVerifier : "";
      const redirectUri = typeof payload.redirectUri === "string" ? payload.redirectUri : "";
      if (options.rejectLocalExchange) return json({ code: "invalid_argument", message: "授权码无效" }, 400);
      const entry = localLoginCodes.get(code);
      if (entry === undefined || entry.used) return json({ code: "invalid_argument", message: "授权码无效" }, 400);
      // 先消费再校验：重放同一个码不会因为校验失败而「复活」。
      entry.used = true;
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
        return json({ code: "invalid_argument", message: "PKCE verifier 非法" }, 400);
      }
      if (entry.challenge !== null) {
        const computed = createHash("sha256").update(verifier).digest("base64url");
        if (computed !== entry.challenge) return json({ code: "invalid_argument", message: "PKCE 不匹配" }, 400);
      }
      if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(redirectUri)) {
        return json({ code: "invalid_argument", message: "redirect_uri 必须是 loopback" }, 400);
      }
      counter += 1;
      const sessionToken = `session-${counter}`;
      const subject = options.localLoginSubject ?? "oauth-alice";
      sessions.set(sessionToken, subject);
      return json({
        sessionToken,
        subjectId: subject,
        expiresAt: new Date(Date.now() + sessionTtlMs).toISOString()
      });
    }

    if (method === "ReportDiagnostics") {
      diagnosticsCalls += 1;
      if (options.diagnosticsUnimplemented) {
        return json({ code: "unimplemented", message: "diagnostics reporting not implemented" }, 501);
      }
      const bearer = authorization?.replace(/^Bearer\s+/i, "") ?? "";
      if (!sessions.has(bearer)) return json({ code: "unauthenticated", message: "未认证" }, 401);
      if (options.diagnosticsFailOnCall === diagnosticsCalls) {
        return json({ code: "internal", message: "内部错误" }, 500);
      }
      const entries = (body as { entries?: unknown } | null)?.entries;
      // 幂等键命中、一条都没新增时，proto3 JSON 会省略零值字段，服务端回的就是 `{}`。
      if (options.diagnosticsOmitAcceptedCount) return json({});
      // 用「接受了几条」回答：测试据此确认整条上报链路（形状 + 鉴权）真的走完了。
      return json({ acceptedCount: options.diagnosticsAcceptedCount ?? (Array.isArray(entries) ? entries.length : 0) });
    }

    // ---- 托管生成（woohaa.generation.v1alpha1.GenerationService） ----
    if (method === "GetCapabilities") {
      if (options.generation?.unimplemented) {
        return json({ code: "unimplemented", message: "generation not implemented" }, 501);
      }
      if (!isGenerationAuthorized(authorization)) return json({ code: "unauthenticated", message: "未认证" }, 401);
      return json({
        protocolVersion: generation.capabilities.protocolVersion,
        features: [...generation.capabilities.features],
        pollAfterMs: generation.capabilities.pollAfterMs
      });
    }

    if (method === "GetCatalog") {
      if (options.generation?.unimplemented) {
        return json({ code: "unimplemented", message: "generation not implemented" }, 501);
      }
      if (!isGenerationAuthorized(authorization)) return json({ code: "unauthenticated", message: "未认证" }, 401);
      return json({
        available: generation.catalog.available,
        ...(generation.catalog.reason !== "" ? { reason: generation.catalog.reason } : {}),
        // uint64 在 ProtoJSON 里是字符串；fake 用字符串，顺带验证客户端的容错。
        catalogRevision: String(generation.catalog.catalogRevision),
        models: generation.catalog.models
      });
    }

    if (method === "SubmitTask") {
      if (options.generation?.unimplemented) {
        return json({ code: "unimplemented", message: "generation not implemented" }, 501);
      }
      if (!isGenerationAuthorized(authorization)) return json({ code: "unauthenticated", message: "未认证" }, 401);
      const request = (body ?? {}) as Record<string, unknown>;
      generation.submits.push(request);
      generationTaskCounter += 1;
      const taskId = `task-${generationTaskCounter}`;
      const idempotencyKey = typeof request.idempotencyKey === "string" ? request.idempotencyKey : "";
      const modelKey = typeof request.modelKey === "string" ? request.modelKey : "";
      const modelType = typeof request.modelType === "string" ? request.modelType : "";
      if (options.generation?.rejectSubmitWith !== undefined) {
        // 稳定拒绝：受理响应就是 FAILED，稳定码要经 GetTask.error.code 读回。
        generation.tasks.set(taskId, {
          taskId,
          idempotencyKey,
          modelKey,
          modelType,
          state: "TASK_STATE_FAILED",
          polls: 0,
          error: { code: options.generation.rejectSubmitWith, retryable: false }
        });
        return json({ taskId, state: "TASK_STATE_FAILED", reused: false, idempotencyKey });
      }
      generation.tasks.set(taskId, { taskId, idempotencyKey, modelKey, modelType, state: "TASK_STATE_QUEUED", polls: 0 });
      return json({ taskId, state: "TASK_STATE_QUEUED", reused: false, idempotencyKey });
    }

    if (method === "GetTask") {
      if (options.generation?.unimplemented) {
        return json({ code: "unimplemented", message: "generation not implemented" }, 501);
      }
      if (!isGenerationAuthorized(authorization)) return json({ code: "unauthenticated", message: "未认证" }, 401);
      const request = (body ?? {}) as Record<string, unknown>;
      const taskId = typeof request.taskId === "string" ? request.taskId : "";
      const task = generation.tasks.get(taskId);
      if (!task) return json({ code: "not_found", message: "任务不存在" }, 404);
      task.polls += 1;
      if (task.state === "TASK_STATE_FAILED" && task.error) {
        return json({
          taskId: task.taskId,
          state: "TASK_STATE_FAILED",
          idempotencyKey: task.idempotencyKey,
          progress: 0,
          error: { code: task.error.code, retryable: task.error.retryable },
          recordRevision: "2"
        });
      }
      if (task.state === "TASK_STATE_CANCELLED") {
        return json({ taskId: task.taskId, state: "TASK_STATE_CANCELLED", idempotencyKey: task.idempotencyKey, progress: 0 });
      }
      // 第一次轮询返回运行中；第二次按 taskResult 收敛到终态（模拟真实轮询）。
      if (task.polls === 1) {
        return json({
          taskId: task.taskId,
          state: "TASK_STATE_RUNNING",
          idempotencyKey: task.idempotencyKey,
          progress: 0.42,
          recordRevision: "1"
        });
      }
      const outcome = generation.taskResult;
      if (outcome.kind === "failed") {
        task.state = "TASK_STATE_FAILED";
        task.error = { code: outcome.code, retryable: outcome.retryable === true };
        return json({
          taskId: task.taskId,
          state: "TASK_STATE_FAILED",
          idempotencyKey: task.idempotencyKey,
          progress: 0,
          error: { code: outcome.code, retryable: outcome.retryable === true },
          recordRevision: "2"
        });
      }
      task.state = "TASK_STATE_SUCCEEDED";
      return json({
        taskId: task.taskId,
        state: "TASK_STATE_SUCCEEDED",
        idempotencyKey: task.idempotencyKey,
        progress: 1,
        ...(outcome.kind === "text"
          ? { text: { text: outcome.text, truncated: false } }
          : { media: outcome.media }),
        recordRevision: "2",
        updatedAt: "2026-10-20T00:00:00Z"
      });
    }

    if (method === "CancelTask") {
      if (options.generation?.unimplemented) {
        return json({ code: "unimplemented", message: "generation not implemented" }, 501);
      }
      if (!isGenerationAuthorized(authorization)) return json({ code: "unauthenticated", message: "未认证" }, 401);
      const request = (body ?? {}) as Record<string, unknown>;
      const taskId = typeof request.taskId === "string" ? request.taskId : "";
      const task = generation.tasks.get(taskId);
      if (!task) return json({ code: "not_found", message: "任务不存在" }, 404);
      generation.cancels.push(taskId);
      task.state = "TASK_STATE_CANCELLED";
      return json({ taskId, state: "TASK_STATE_CANCELLED", cancelScope: "remote" });
    }

    return json({ code: "unimplemented", message: "未知过程" }, 404);
  };

  return {
    fetch: fetchImpl,
    calls,
    sessions,
    revoked,
    remoteCanvasIds,
    canvasAcls,
    canvasShares,
    canvasInvites,
    generation,
    grantLocalLoginCode(input) {
      localLoginCodes.set(input.code, { challenge: input.challenge ?? null, used: false });
    },
    serverUrl: "https://canvas.example.com",
    deployment: { serverUrl: "https://canvas.example.com", deviceToken: "device-token", keyPrefix: "" }
  };
}

/** 供 fetch 响应体读取用（部分运行环境需要显式 text 编码）。 */
export const encoder = enc;
