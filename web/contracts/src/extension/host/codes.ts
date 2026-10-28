/**
 * 应用插件稳定错误码（change: 2026-10-04-add-backend-plugin-extensions，任务 1.1 / design D3）。
 *
 * 跨进程契约：调用方按字符串判定，不按 `instanceof`。命名与既有协议错误码分开，因为
 * 站点插件管理面属于独立的控制面协议，不与内部服务间协议混用。
 */

export const APPLICATION_EXTENSION_ERROR_CODES = [
  /** 未认证（身份缺失/失效）。 */
  "unauthorized",
  /** 身份可信但无权限（change: 2026-10-13-...，任务 1.4：具名 action 拒绝）。 */
  "forbidden",
  /** 请求结构非法（含未注册入口/模块地址/脚本等代码位置字段）。 */
  "malformed-request",
  /** 不受支持的插件/操作/认证等级。 */
  "unsupported",
  /** 引用的插件不在可信清单中。 */
  "extension-not-found",
  /**
   * 插件已激活但请求的 route 没有注册（或方法/路径拼错）。
   * 与 `extension-not-found` 分开：后者的文案「插件未激活」会把人引向错误的排查方向。
   */
  "route-not-registered",
  /** `expectedRevision` 与当前持久化 revision 不一致。 */
  "revision-conflict",
  /** 候选配置未通过 schema 校验。 */
  "config-invalid",
  /** 候选配置 prepare 阶段失败（activation 前）。 */
  "prepare-failed",
  /** 试图在线停用必需基础提供者（change: 2026-10-13-...，任务 1.5）：必须经发布/重启更新部署 profile。 */
  "required-provider",
  /** 宿主或依赖暂时不可用（可重试）。 */
  "unavailable",
  /** 持久化写入失败（可重试）。 */
  "storage-failed",
  /** 浏览器上下文试图进入内部/system 调用路径（change: 2026-10-13-...，任务 1.6）。 */
  "browser-cannot-enter-system"
] as const;

export type ApplicationExtensionErrorCode = (typeof APPLICATION_EXTENSION_ERROR_CODES)[number];

export function isApplicationExtensionErrorCode(value: unknown): value is ApplicationExtensionErrorCode {
  return (
    typeof value === "string" &&
    (APPLICATION_EXTENSION_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** 与错误码对应的稳定 HTTP 状态（管理面统一使用）。 */
export const APPLICATION_EXTENSION_ERROR_STATUS: Readonly<Record<ApplicationExtensionErrorCode, number>> = {
  unauthorized: 401,
  forbidden: 403,
  "malformed-request": 400,
  unsupported: 400,
  "extension-not-found": 404,
  "route-not-registered": 404,
  "revision-conflict": 409,
  "config-invalid": 400,
  "prepare-failed": 409,
  "required-provider": 409,
  unavailable: 503,
  "storage-failed": 500,
  "browser-cannot-enter-system": 403
};

export type ApplicationExtensionErrorBody = {
  code: ApplicationExtensionErrorCode;
  message: string;
};
