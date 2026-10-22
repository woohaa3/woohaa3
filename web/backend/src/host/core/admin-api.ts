/**
 * 核心层 · admin：会话读模型与 Provider 凭据两处**管理读/写面**的装配。
 *
 * 本模块只做装配（恢复自迁移前 `composition.ts` 的等价接线），不复制任何授权逻辑：
 * - `createSessionApi`：前端 `current-user.ts` 调用的 `/api/application/session` 读模型；
 * - `createProviderManagementApi`：`/api/providers` 的公开凭据状态 + 具名 action 保护的写入。
 *
 * 生成模型管理面已由 `host/core/generation.ts` 持有，这里不再重复装配（旧的
 * `composition/admin-apis.ts` 里那一半因此不恢复）。
 */
import { createSessionApi } from "../../composition/session-api.js";
import { createProviderManagementApi } from "../../composition/provider-credentials.js";
import type { HostContext, HostPlugin } from "../context.js";
import { ROUTE_ORDER } from "../order.js";

export const adminApiPlugin: HostPlugin = {
  name: "adminApi",
  inject: ["log", "gateway", "access", "config", "generation"],
  apply(ctx: HostContext) {
    const logger = ctx.log.scope("admin-api");
    // 与宿主使用同一启动扫描结果：企业身份走受控 session，本地单实例返回 accessControl=false。
    const sessionApi = createSessionApi(ctx.access.authenticator, ctx.access.providers, ctx.access.runtime);
    ctx.effect(() => ctx.gateway.route(ROUTE_ORDER.session, (req, res) => sessionApi(req, res)));

    const providersApi = createProviderManagementApi({
      settings: ctx.config,
      generation: ctx.generation,
      authenticator: ctx.access.authenticator,
      accessEnforcer: ctx.access.accessEnforcer,
      logger
    });
    ctx.effect(() => ctx.gateway.route(ROUTE_ORDER.providers, (req, res) => providersApi(req, res)));
  }
};
