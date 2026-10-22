/**
 * Application extension API：常量、限制与依赖类型
 * （自 `extension-api.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R15；
 *  change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 1.3/3.5）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApplicationExtensionPublicRouteMapping } from "@woohaa3/contracts";
import type { ApplicationRequestAuthenticator } from "../../auth/adapter.js";
import type { AccessEnforcer } from "../../extensions/access-enforcement.js";
import type { SiteExtensionControlPlane } from "../../extensions/control-plane.js";
import type { ApplicationExtensionHost } from "../../extensions/host.js";

export const DEFAULT_APPLICATION_EXTENSION_BASE_PATH = "/api/extensions" as const;
export const PLUGIN_INTERNAL_BASE_PATH = "/internal/v1/extensions" as const;
/** 规范 handler 基路径（change: 2026-10-13-...，任务 1.4）：与 `/api/extensions` 同一分派。 */
export const DEFAULT_PLUGIN_HANDLER_BASE_PATH = "/api/plugins" as const;

export type ApplicationExtensionHandlerLimits = {
  /** 请求体上限（字节）；缺省 256 KiB。 */
  maxRequestBytes: number;
  /** 响应体上限（字节）；缺省 1 MiB。 */
  maxResponseBytes: number;
  /** handler 执行超时（毫秒）；缺省 5000。 */
  timeoutMs: number;
};

export const DEFAULT_PLUGIN_HANDLER_LIMITS: ApplicationExtensionHandlerLimits = {
  maxRequestBytes: 256 * 1024,
  maxResponseBytes: 1024 * 1024,
  timeoutMs: 5_000
};

export const DEFAULT_WRITE_BODY_BYTES = 256 * 1024;

export type ApplicationExtensionApiDependencies = {
  accessRuntime?: import("@woohaa3/contracts").AccessRuntime;
  controlPlane: SiteExtensionControlPlane;
  /**
   * 可信请求认证器（change: 2026-10-13-...，任务 1.3）：由 identity provider 支撑，只建立
   * 一次冻结 principal。未配置时所有受保护面按未认证拒绝，但公开读取仍可用；**不**回退
   * loopback、静态 Token 或来路头。
   */
  authenticator?: ApplicationRequestAuthenticator;
  /**
   * 统一执行边界（change: 2026-10-13-...，任务 1.4）：站点 action 检查（site-access 提供者）。
   * 具名 `requiredActions` 在此校验；未配置时含 action 的入口拒绝。
   */
  accessEnforcer?: AccessEnforcer;
  /** 已激活的插件宿主（handler 分派）；缺失时 handler 路由返回 404。 */
  host?: ApplicationExtensionHost;
  /** 内部 work/recovery 服务令牌；浏览器不持有。缺失时内部接口拒绝。 */
  serviceToken?: string;
  handlerLimits?: Partial<ApplicationExtensionHandlerLimits>;
  basePath?: string;
  /**
   * 额外的**别名**受控 handler 基路径（change: 2026-10-13-...，任务 1.4/10.11）。
   *
   * 规范统一使用 `/api/plugins/:extensionId/handlers/*`；既有清单与 ingress 使用
   * `/api/extensions`。两条基路径都分派到**同一** owner-scoped handler，不建立第二套业务
   * dispatcher。别名只影响路径匹配，不影响认证/授权/owner 校验。
   */
  alternateBasePaths?: readonly string[];
  internalBasePath?: string;
  /** 可信清单声明的固定公开路径映射（如 `/api/chatgpt/*`）。 */
  publicRoutes?: readonly ApplicationExtensionPublicRouteMapping[];
  logger?: (event: Record<string, unknown>) => void;
};

export type ApplicationExtensionApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/** 日志函数类型（已归一化）。 */
export type ApiLogger = (event: Record<string, unknown>) => void;
