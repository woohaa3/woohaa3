/**
 * sdpppx 的同源 handler。
 *
 * 所有路由 `auth: "authenticated"`：浏览器会话已经是应用主体，扩展再按 owner 隔离读写。
 * 响应体只含状态、昵称、头像、余额与到期时间；令牌、Authing ticket / random、上游正文
 * 一律不出现在这里。
 *
 * 路由注册挂在插件生命周期上：宿主按 extensionId 记账，插件停用/回滚时自动释放。
 */
import type {
  ApplicationBackendHandlerRegistration,
  ApplicationExtensionHandlerPurpose
} from "@woohaa3/contracts";
import {
  SDPPPX_ERROR_CODES,
  SDPPPX_LOGIN_CANCEL_ROUTE,
  SDPPPX_LOGIN_START_ROUTE,
  SDPPPX_LOGIN_STATUS_ROUTE,
  SDPPPX_LOGOUT_ROUTE,
  SDPPPX_MODELS_REFRESH_ROUTE,
  SDPPPX_SESSION_ROUTE,
  type SdpppxFailure,
  type SdpppxModelRefreshResult,
  type SdpppxResult,
  type SdpppxSessionSnapshot
} from "../shared.js";
import type { SdpppxLoginFlow } from "./login-flow.js";
import type { SdpppxConfig } from "./config.js";

export type SdpppxRouteRegistration = Pick<ApplicationBackendHandlerRegistration, "route" | "handle"> & {
  auth: "authenticated";
  purpose?: ApplicationExtensionHandlerPurpose;
};

export type SdpppxRoutesOptions = {
  config: () => SdpppxConfig;
  flow: SdpppxLoginFlow;
  snapshot: () => Promise<SdpppxSessionSnapshot>;
  logout: () => Promise<SdpppxSessionSnapshot>;
  refreshModels: () => Promise<SdpppxResult<SdpppxModelRefreshResult>>;
  register: (registration: SdpppxRouteRegistration) => void;
  log?: (event: Record<string, unknown>) => void;
};

type HandlerResult = { status?: number; body: unknown };

function textField(body: unknown, key: string): string | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function failure(code: SdpppxFailure["code"], message: string, missing?: string[]): SdpppxFailure {
  return { ok: false, code, message, ...(missing ? { missing } : {}) };
}

function statusForFailure(code: SdpppxFailure["code"]): number {
  switch (code) {
    case SDPPPX_ERROR_CODES.configIncomplete:
    case SDPPPX_ERROR_CODES.authingAppMissing:
      return 400;
    case SDPPPX_ERROR_CODES.sessionExpired:
      return 401;
    default:
      return 502;
  }
}

export function registerSdpppxRoutes(options: SdpppxRoutesOptions): void {
  const log = options.log ?? (() => undefined);

  const register = (
    route: string,
    purpose: ApplicationExtensionHandlerPurpose,
    handle: (input: { body: unknown }) => Promise<HandlerResult> | HandlerResult
  ): void => {
    options.register({ route, auth: "authenticated", purpose, handle });
  };

  register(SDPPPX_SESSION_ROUTE, "read", async () => ({ status: 200, body: await options.snapshot() }));

  register(SDPPPX_LOGIN_START_ROUTE, "auth-transaction", async () => {
    const config = options.config();
    if (config.degradedCode !== null) {
      return {
        status: 400,
        body: failure(config.degradedCode, "缺少 SDPPPX 部署参数", config.missing)
      };
    }
    const result = await options.flow.start();
    if (!result.ok) {
      return { status: statusForFailure(result.code), body: result };
    }
    return { status: 200, body: result };
  });

  register(SDPPPX_LOGIN_STATUS_ROUTE, "auth-transaction", async (input) => {
    const loginId = textField(input.body, "loginId");
    if (!loginId) {
      return {
        status: 400,
        body: failure(SDPPPX_ERROR_CODES.loginFailed, "缺少登录标识")
      };
    }
    const status = await options.flow.status(loginId);
    return { status: 200, body: status };
  });

  register(SDPPPX_LOGIN_CANCEL_ROUTE, "auth-transaction", (input) => {
    const loginId = textField(input.body, "loginId");
    if (loginId) options.flow.cancel(loginId);
    // 幂等：未知/已终态的 loginId 也返回成功。
    return { status: 200, body: { ok: true } };
  });

  register(SDPPPX_LOGOUT_ROUTE, "auth-transaction", async () => {
    const snapshot = await options.logout();
    log({ event: "sdpppx-logged-out" });
    return { status: 200, body: snapshot };
  });

  register(SDPPPX_MODELS_REFRESH_ROUTE, "new-work", async () => {
    const result = await options.refreshModels();
    return { status: result.ok ? 200 : statusForFailure(result.code), body: result };
  });
}
