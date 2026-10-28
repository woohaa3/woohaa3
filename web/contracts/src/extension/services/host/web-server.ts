/**
 * `ctx.webServer`：扩展注册受控 HTTP 路由的唯一入口。
 *
 * 服务契约在这里定义，宿主实现路由表与分派；注册形状（registration）也属于本服务，而不是
 * 某个「后端宿主」胖接口。
 *
 * 注册仍是**相对 route**：宿主按 `<extensionId>/<route>` 组织全局注册表并对外拼
 * `/api/extensions/<extensionId>/...`，前缀由宿主添加，插件无法绕过（否则任意扩展都能占用根路径）。
 *
 * 三种注册对应三种响应能力：
 * - `register`：结构化 JSON（自动序列化、受控错误码）；
 * - `registerHttp`：可写 header / 状态码，仍由宿主构造 req/res 视图；
 * - `registerRawHttp`：直接操作 Node `req`/`res`（302 重定向、HTML 完成页、SSE 长连接）。
 */
import type { AccessAction } from "../../host/access.js";
import type { DataScope } from "../../host/data-scope.js";
import type {
  ApplicationExtensionHandlerPurpose,
  ApplicationExtensionHttpHandler,
  ApplicationExtensionHttpMethod,
  ApplicationExtensionRawRequest,
  ApplicationExtensionRawResponse,
  ApplicationExtensionStreamBudget
} from "../../host/http.js";
import type { ApplicationExtensionAuthLevel } from "../../host/manifest.js";
import type { PrincipalContext } from "../../host/principal.js";

/** 受控请求上下文：由宿主认证后注入，插件不得自报身份。 */
export type ApplicationExtensionRequestContext = {
  extensionId: string;
  authLevel: ApplicationExtensionAuthLevel;
  /** 可信操作者标识（仅审计；不参与授权决策）。 */
  actor?: string;
  correlationId?: string;
  /**
   * 可信应用用户主体（change: 2026-10-13-add-enterprise-access-and-production-deployment）。
   * 由宿主 identity provider 建立并冻结；个人凭据与资源权限的 owner 只来自 `principal.subject`。
   * 个人插件不得以 authLevel、actor 或请求体 userId 代替。不含 `isAdmin`/管理员角色。
   */
  principal?: PrincipalContext;
  /** 宿主固定的访问控制装配状态与数据归属；不能由请求自报。 */
  accessControl?: boolean;
  dataScope?: DataScope;
  /** 会话绑定（本地会话或登录会话）；OAuth 事务用它绑定 owner。 */
  sessionId?: string;
  /**
   * 取消信号（change: 2026-10-08-unlock-...，任务 2.5 / design D4）。
   *
   * 宿主在 client 断连或 deadline 到达时 abort；流式 handler MUST 据此停止等待并收尾。
   */
  signal?: AbortSignal;
};

/** handler 返回：body 必须是有界 JSON；宿主负责序列化与状态码。 */
export type ApplicationExtensionHandlerResult = {
  status?: number;
  body: unknown;
};

/**
 * 插件注册的受控请求处理（命名空间下相对路由；宿主统一分派）。
 *
 * `purpose` 区分新工作与在途控制（design D4/D6）：draining 拒绝 `new-work`/`auth-transaction`
 * 的新准入，但保留 `work-control`/`read` 的 owner/version-bound 访问。
 */
export type ApplicationBackendHandlerRegistration = {
  /** 相对路由（不含宿主 base path）；`/` 之外不允许空。 */
  route: string;
  /** 最低认证等级；插件不能弱化。 */
  auth: ApplicationExtensionAuthLevel;
  /**
   * 具名站点 action（change: 2026-10-13-...，任务 3.3）。宿主在进入插件逻辑前用
   * SiteAccessPolicy 逐项校验；缺失/未知 action 默认拒绝。
   */
  requiredActions?: readonly AccessAction[];
  /** 请求用途；缺省按 `new-work`（保守：draining 会拒绝）。 */
  purpose?: ApplicationExtensionHandlerPurpose;
  handle: (
    input: { body: unknown; context: ApplicationExtensionRequestContext }
  ) => Promise<ApplicationExtensionHandlerResult> | ApplicationExtensionHandlerResult;
};

/**
 * 插件注册的受控 **HTTP** handler（server-only；design D4）。
 *
 * 与纯 DTO handler 并存：HTTP handler 取得 method/query/headers/Cookie 与受控响应，用于
 * OAuth callback、Set-Cookie、HTML、redirect 与有界流式响应。宿主仍在进入前完成认证、
 * Origin/CSRF、体积与预算校验，并在超时/断连时向执行层发出取消信号。
 */
export type ApplicationBackendHttpHandlerRegistration = {
  route: string;
  method: ApplicationExtensionHttpMethod;
  auth: ApplicationExtensionAuthLevel;
  /** 具名站点 action（同 DTO handler；宿主在进入前校验）。 */
  requiredActions?: readonly AccessAction[];
  purpose: ApplicationExtensionHandlerPurpose;
  /** 声明流式（SSE）；宿主按 `streamBudget` 执行 heartbeat/deadline/预算。 */
  stream?: boolean;
  streamBudget?: Partial<ApplicationExtensionStreamBudget>;
  handle: ApplicationExtensionHttpHandler;
};

/**
 * 受控**原始 HTTP** handler 注册（server-only；design D4 允许"原始 req/res 访问或等价 facade"）。
 *
 * 请求/响应用**结构化形状**（`ApplicationExtensionRawRequest/Response`，不 import `node:http`），
 * 使 contracts 保持浏览器安全；后端入口契约把它与真实 Node 实现对接。宿主在进入前完成认证、
 * Origin/CSRF 与预算校验，并把可信 dispatch 上下文作为第三参注入；插件不得自报身份。
 * 用于 OAuth 回调、Cookie、HTML、redirect 与 SSE，允许复用既有 Node handler 实现。
 */
export type ApplicationBackendRawHttpHandlerRegistration = {
  route: string;
  method: ApplicationExtensionHttpMethod;
  auth: ApplicationExtensionAuthLevel;
  /** 具名站点 action（同 DTO handler；宿主在进入前校验）。 */
  requiredActions?: readonly AccessAction[];
  purpose: ApplicationExtensionHandlerPurpose;
  stream?: boolean;
  streamBudget?: Partial<ApplicationExtensionStreamBudget>;
  handle: (
    req: ApplicationExtensionRawRequest,
    res: ApplicationExtensionRawResponse,
    context: ApplicationExtensionRequestContext
  ) => Promise<void>;
};

export type HostWebServerService = {
  /** 受控 JSON handler：路由 + 处理函数，宿主统一分派并序列化结果。 */
  register(registration: ApplicationBackendHandlerRegistration): void;
  /** HTTP handler：可设置状态码与响应头。 */
  registerHttp(registration: ApplicationBackendHttpHandlerRegistration): void;
  /** 原始 HTTP handler：直接读写 Node `req`/`res`（重定向、HTML、SSE）。 */
  registerRawHttp(registration: ApplicationBackendRawHttpHandlerRegistration): void;
};
