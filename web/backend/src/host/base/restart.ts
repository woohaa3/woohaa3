/**
 * 基础层 · restart：宿主受控重启入口 `POST /api/host/restart`
 * （change: 2026-10-21-harden-extension-fault-isolation，design D6）。
 *
 * 只提供 `hostRestart` 控制器与路由；真正的排空与 `exit(75)` 由进程入口（`server.ts`）订阅后执行。
 */
import { createHostRestartApiHandler, createHostRestartController } from "../../api/host-restart-api.js";
import { markRestartRequested, resolveBootStatePath } from "../boot-state.js";
import type { HostPlugin } from "../context.js";
import { ROUTE_ORDER } from "../order.js";

export const restartPlugin: HostPlugin<{ env: Record<string, string | undefined> }> = {
  name: "restart",
  inject: ["log", "gateway", "access"],
  apply(ctx, { env }) {
    const log = ctx.log.scope("host-restart");
    const controller = createHostRestartController();
    ctx.provide("hostRestart", controller);
    const bootStateFile = resolveBootStatePath(env);
    const handler = createHostRestartApiHandler({
      controller,
      authenticator: ctx.access.authenticator,
      accessEnforcer: ctx.access.accessEnforcer,
      markRestartRequested: (input) => markRestartRequested(bootStateFile, input),
      logger: log
    });
    ctx.effect(() => ctx.gateway.route(ROUTE_ORDER.hostRestart, handler));
  }
};
