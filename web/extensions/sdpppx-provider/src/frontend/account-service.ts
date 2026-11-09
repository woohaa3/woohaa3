/**
 * 浏览器侧账号读模型。
 *
 * 只做三件事：调用同源 handler、把返回的**无令牌快照**缓存成可订阅状态、把用户动作转发给
 * 宿主。登录轮询不在服务里做（弹窗拥有 1.5s 轮询与终态停止），服务也不直接 fetch——统一走
 * 应用注入的 `transport`。
 */
import type { ApplicationRemoteTransport } from "@woohaa3/frontend/extension-api";
import {
  EMPTY_SDPPPX_SNAPSHOT,
  SDPPPX_ERROR_CODES,
  SDPPPX_LOGIN_CANCEL_ROUTE,
  SDPPPX_LOGIN_START_ROUTE,
  SDPPPX_LOGIN_STATUS_ROUTE,
  SDPPPX_LOGOUT_ROUTE,
  SDPPPX_MODELS_REFRESH_ROUTE,
  SDPPPX_PLUGIN_ID,
  SDPPPX_SESSION_ROUTE,
  recordOf,
  textOf,
  type SdpppxFailure,
  type SdpppxLoginPhase,
  type SdpppxLoginStart,
  type SdpppxLoginStatus,
  type SdpppxModelRefreshResult,
  type SdpppxResult,
  type SdpppxSessionSnapshot,
  type SdpppxSessionView
} from "../shared.js";

export const SDPPPX_HANDLER_BASE = `/api/extensions/${SDPPPX_PLUGIN_ID}/handlers`;

export type SdpppxAccountTransport = Pick<ApplicationRemoteTransport, "request">;

const LOGIN_PHASES: readonly SdpppxLoginPhase[] = [
  "pending",
  "scanned",
  "authorized",
  "cancelled",
  "expired",
  "error"
];

function failure(code: SdpppxFailure["code"], message: string): SdpppxFailure {
  return { ok: false, code, message };
}

/** 同源 handler 的非 2xx：保留 body，调用方才能拿到宿主给的稳定码。 */
class SdpppxTransportError extends Error {
  readonly body: unknown;

  constructor(message: string, body: unknown) {
    super(message);
    this.name = "SdpppxTransportError";
    this.body = body;
  }
}

function failureFromBody(body: unknown, fallback: SdpppxFailure["code"], message: string): SdpppxFailure {
  const record = recordOf(body);
  if (record?.ok === false) {
    return failure(
      (textOf(record.code) as SdpppxFailure["code"]) ?? fallback,
      textOf(record.message) ?? message
    );
  }
  return failure(fallback, message);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringMap(value: unknown): Record<string, "image" | "video"> {
  const record = recordOf(value);
  const out: Record<string, "image" | "video"> = {};
  if (!record) return out;
  for (const [key, item] of Object.entries(record)) {
    if (item === "image" || item === "video") out[key] = item;
  }
  return out;
}

function parseSessionView(value: unknown): SdpppxSessionView | null {
  const record = recordOf(value);
  if (!record) return null;
  const expiresAt = numberValue(record.expiresAt);
  if (expiresAt === undefined) return null;
  const balance = recordOf(record.balance);
  return {
    displayName: textOf(record.displayName) ?? null,
    avatarUrl: textOf(record.avatarUrl) ?? null,
    expiresAt,
    balance: balance
      ? {
          totalBalance: numberValue(balance.totalBalance) ?? 0,
          ...(numberValue(balance.paid) !== undefined ? { paid: numberValue(balance.paid) } : {}),
          ...(numberValue(balance.monthlyBonus) !== undefined
            ? { monthlyBonus: numberValue(balance.monthlyBonus) }
            : {}),
          ...(numberValue(balance.dailyBonus) !== undefined
            ? { dailyBonus: numberValue(balance.dailyBonus) }
            : {})
        }
      : null
  };
}

/** 解析 `/session` 与 `/logout` 的快照；形状不符时返回 null，不伪造登录态。 */
export function decodeSdpppxSnapshot(value: unknown): SdpppxSessionSnapshot | null {
  const record = recordOf(value);
  if (!record) return null;
  const status = record.status;
  if (status !== "authenticated" && status !== "anonymous" && status !== "unconfigured") return null;
  const config = recordOf(record.config);
  if (!config) return null;
  const missing = Array.isArray(record.missing)
    ? record.missing.filter((item): item is string => typeof item === "string")
    : [];
  return {
    status,
    degradedCode:
      record.degradedCode === null || record.degradedCode === undefined
        ? null
        : (textOf(record.degradedCode) as SdpppxSessionSnapshot["degradedCode"]) ?? null,
    missing,
    config: {
      baseUrl: textOf(config.baseUrl) ?? "",
      tenantId: textOf(config.tenantId) ?? null,
      supabaseHost: textOf(config.supabaseHost) ?? null,
      authingAppIdConfigured: booleanValue(config.authingAppIdConfigured) ?? false,
      authingHost: textOf(config.authingHost) ?? "",
      authingScene: textOf(config.authingScene) ?? "",
      bridgeHost: textOf(config.bridgeHost) ?? null,
        templateModelTypes: stringMap(config.templateModelTypes),
      promptField: textOf(config.promptField) ?? "prompt",
      uploadProvider: textOf(config.uploadProvider) ?? "",
      taskTimeoutMs: numberValue(config.taskTimeoutMs) ?? 0
    },
    session: parseSessionView(record.session),
    notice: textOf(record.notice) as SdpppxSessionSnapshot["notice"] ?? null
  };
}

function decodeLoginStart(value: unknown): SdpppxLoginStart | null {
  const record = recordOf(value);
  if (!record || record.ok !== true) return null;
  const loginId = textOf(record.loginId);
  const qrDataUrl = textOf(record.qrDataUrl);
  const expiresAt = numberValue(record.expiresAt);
  if (!loginId || !qrDataUrl || !qrDataUrl.startsWith("data:image/") || expiresAt === undefined) return null;
  return { loginId, qrDataUrl, phase: "pending", expiresAt };
}

export function decodeSdpppxLoginStatus(value: unknown): SdpppxLoginStatus | null {
  const record = recordOf(value);
  if (!record) return null;
  const phase = record.phase;
  if (typeof phase !== "string" || !(LOGIN_PHASES as readonly string[]).includes(phase)) return null;
  return {
    phase: phase as SdpppxLoginPhase,
    ...(textOf(record.nickname) !== undefined ? { nickname: textOf(record.nickname)! } : {}),
    ...(textOf(record.avatarUrl) !== undefined ? { avatarUrl: textOf(record.avatarUrl)! } : {}),
    ...(record.session !== undefined && record.session !== null
      ? { session: parseSessionView(record.session) ?? undefined }
      : {}),
    ...(textOf(record.error) !== undefined ? { error: textOf(record.error)! } : {})
  };
}

function decodeModelRefresh(value: unknown): SdpppxModelRefreshResult | null {
  const record = recordOf(value);
  if (!record || record.ok !== true) return null;
  const modelCount = numberValue(record.modelCount);
  const catalogRevision = numberValue(record.catalogRevision);
  if (modelCount === undefined || catalogRevision === undefined) return null;
  return {
    available: record.available === true,
    modelCount,
    catalogRevision,
    error: textOf(record.error) ?? null
  };
}

export type SdpppxAccountService = ReturnType<typeof createSdpppxAccountService>;

export function createSdpppxAccountService(transport: SdpppxAccountTransport) {
  let snapshot: SdpppxSessionSnapshot = { ...EMPTY_SDPPPX_SNAPSHOT };
  const listeners = new Set<() => void>();

  const emit = (next: SdpppxSessionSnapshot): void => {
    snapshot = next;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // 订阅者异常不应打断其他订阅者。
      }
    }
  };

  const request = async (path: string, body?: unknown): Promise<unknown> => {
    const result = await transport.request({
      path: `${SDPPPX_HANDLER_BASE}/${path}`,
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body })
    });
    if (!result.ok) throw new SdpppxTransportError(result.error || "请求失败", result.body);
    return result.data;
  };

  return {
    getSnapshot: (): SdpppxSessionSnapshot => snapshot,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** 读一次宿主快照；读不到时返回 null（调用方据此不弹登录，而不是误判成未登录）。 */
    async refresh(): Promise<SdpppxSessionSnapshot | null> {
      try {
        const next = decodeSdpppxSnapshot(await request(SDPPPX_SESSION_ROUTE));
        if (next) emit(next);
        return next;
      } catch {
        return null;
      }
    },

    async startLogin(): Promise<SdpppxResult<SdpppxLoginStart>> {
      try {
        const raw = await request(SDPPPX_LOGIN_START_ROUTE, {});
        const record = recordOf(raw);
        if (record?.ok === false) {
          return failure(
            (textOf(record.code) as SdpppxFailure["code"]) ?? SDPPPX_ERROR_CODES.loginFailed,
            textOf(record.message) ?? "登录失败"
          );
        }
        const start = decodeLoginStart(raw);
        if (!start) return failure(SDPPPX_ERROR_CODES.loginFailed, "登录响应无效");
        return { ok: true, ...start };
      } catch (error) {
        if (error instanceof SdpppxTransportError) {
          return failureFromBody(error.body, SDPPPX_ERROR_CODES.loginFailed, "登录失败");
        }
        return failure(
          SDPPPX_ERROR_CODES.serviceUnavailable,
          error instanceof Error && error.message ? error.message : "服务暂不可用"
        );
      }
    },

    async pollLogin(loginId: string): Promise<SdpppxLoginStatus> {
      try {
        const status = decodeSdpppxLoginStatus(await request(SDPPPX_LOGIN_STATUS_ROUTE, { loginId }));
        if (!status) return { phase: "error", error: SDPPPX_ERROR_CODES.loginFailed };
        if (status.phase === "authorized" && status.session) {
          emit({
            ...snapshot,
            status: "authenticated",
            session: status.session,
            notice: null
          });
        }
        return status;
      } catch {
        return { phase: "error", error: SDPPPX_ERROR_CODES.serviceUnavailable };
      }
    },

    async cancelLogin(loginId: string): Promise<void> {
      try {
        await request(SDPPPX_LOGIN_CANCEL_ROUTE, { loginId });
      } catch {
        // 关闭弹窗/切页时的清理：失败不阻塞卸载。
      }
    },

    async logout(): Promise<{ ok: true; snapshot: SdpppxSessionSnapshot } | { ok: false; error: string }> {
      try {
        const next = decodeSdpppxSnapshot(await request(SDPPPX_LOGOUT_ROUTE, {}));
        if (!next) return { ok: false, error: "退出登录响应无效" };
        emit({ ...next, status: "anonymous", session: null, notice: null });
        return { ok: true, snapshot: next };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "退出登录失败" };
      }
    },

    async refreshModels(): Promise<SdpppxResult<SdpppxModelRefreshResult>> {
      try {
        const raw = await request(SDPPPX_MODELS_REFRESH_ROUTE, {});
        const record = recordOf(raw);
        if (record?.ok === false) {
          return failure(
            (textOf(record.code) as SdpppxFailure["code"]) ?? SDPPPX_ERROR_CODES.catalogUnavailable,
            textOf(record.message) ?? "刷新失败"
          );
        }
        const result = decodeModelRefresh(raw);
        if (!result) return failure(SDPPPX_ERROR_CODES.catalogUnavailable, "刷新响应无效");
        return { ok: true, ...result };
      } catch (error) {
        if (error instanceof SdpppxTransportError) {
          return failureFromBody(error.body, SDPPPX_ERROR_CODES.catalogUnavailable, "刷新失败");
        }
        return failure(
          SDPPPX_ERROR_CODES.serviceUnavailable,
          error instanceof Error && error.message ? error.message : "服务暂不可用"
        );
      }
    },

    /** 登录后由弹窗写入宿主返回的会话视图（避免再请求一次 /session）。 */
    applySession(view: SdpppxSessionView): void {
      emit({ ...snapshot, status: "authenticated", session: view, notice: null });
    },

    dispose(): void {
      listeners.clear();
    },

    /** 仅测试/调试用；正常路径由宿主响应对齐。 */
    setSnapshotForTest(next: SdpppxSessionSnapshot): void {
      emit(next);
    }
  };
}
