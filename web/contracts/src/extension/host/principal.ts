/**
 * 应用插件宿主：可信用户身份、会话与领域委托契约
 * （change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 1.3 / design D3）。
 *
 * 本模块只声明**纯类型**：区分三类身份（plugin identity、application principal、audit actor）。
 * 不含 Node driver、HTTP 实现或秘密。宿主在分派前建立 principal/session，插件不得自报。
 */

/** 可信应用用户主体：由宿主的认证适配器建立，绝不来自请求参数或 loopback。 */
export type ApplicationPrincipal = {
  /** 应用用户 ID（owner 选择依据；不是 ChatGPT sub，也不是 localStorage 随机值）。 */
  subject: string;
  roles: readonly string[];
};

/**
 * 宿主体内的**可信、冻结**principal 上下文
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 0.3 / design D2）。
 *
 * 只由 identity provider 建立；包含有效期与会话绑定。刻意不含 `isAdmin`/管理员角色：管理权
 * 是 site-access 的**授权结果**，不是认证结果。核心 MUST NOT 依据角色判定管理权。
 */
export type PrincipalContext = {
  /** 应用用户 owner 依据（已验证的稳定主体；不是显示名或客户端自报字段）。 */
  subject: string;
  /** 已验证可得名称（展示用；不参与 owner 选择）。 */
  displayName?: string;
  /** 建立该 principal 的 identity provider identity（extensionId/providerId）。 */
  identityProvider: string;
  /** 会话绑定（OAuth 事务与撤权隔离用）。 */
  sessionId?: string;
  /** 身份有效期（epoch ms）；到期后受保护连接停止。 */
  validUntil?: number;
  /** 已验证的附加属性（有界字符串；由 provider 决定语义）。 */
  attributes?: Readonly<Record<string, string>>;
};

/** 浏览器会话绑定：用于 OAuth 事务与 owner 绑定。 */
export type ApplicationExtensionSessionBinding = {
  sessionId: string;
  /**
   * principal：可信应用登录会话；
   * local-session：纯本地开发时由宿主签发并验证的 HttpOnly 会话（仅隔离浏览器配置文件）。
   */
  kind: "principal" | "local-session";
};

/**
 * 进入领域端口时传递的宿主生成委托上下文。
 *
 * 下游据此检查「插件身份 + 应用用户委托」，插件不能改写它，也不获得原始服务令牌。
 */
export type ApplicationUserDelegation = {
  subject: string;
  authLevel: import("./manifest.js").ApplicationExtensionAuthLevel;
  /** 可信会话绑定（存在时）。 */
  sessionId?: string;
  /** 审计 actor（不参与 owner 选择）。 */
  auditActor?: string;
};
