/**
 * 受管扩展安装 remote（change: 2026-10-21-add-extension-marketplace-point，任务 7.2 / design D10）。
 *
 * 本机宿主 API 的唯一前端出口：
 * - `POST /api/extensions/install`：原始字节流上传 `.wxt`（不经 multipart、不在前端缓冲）→ 202 `{ jobId }`；
 * - `GET / DELETE /api/extensions/install/:jobId`：任务进度 / 取消（commit 前有效）；
 * - `POST /api/extensions/:id/uninstall`、`POST /api/extensions/:id/rollback` → 202 `{ jobId }`；
 * - 受控重启复用 P0 的唯一入口 `POST /api/host/restart`（`host-restart-remote.ts`）：不支持时
 *   宿主回 503 `restart-unsupported`，这里映射为 `MARKETPLACE_RESTART_UNSUPPORTED` 供设置面提示手动重启。
 *
 * 错误统一 `{ code, message }`；网络失败映射为 `unavailable`。不解释业务语义。
 */
import type { ExtensionInstallJobView } from "@woohaa3/contracts";
import { getAppPublicFetch } from "./app-base-path.js";
import { createHostRestartRemote } from "./host-restart-remote.js";

export const EXTENSION_INSTALL_PATH = "/api/extensions/install";

export type ExtensionInstallRemoteError = { ok: false; code: string; error: string };
/** 已受理：宿主可能同时回带任务视图（202，或同步就失败的 422），调用方优先用它。 */
export type ExtensionJobAccepted = { ok: true; jobId: string; job?: ExtensionInstallJobView } | ExtensionInstallRemoteError;
export type ExtensionJobRead = { ok: true; job: ExtensionInstallJobView } | ExtensionInstallRemoteError;
export type ExtensionRestartResult = { ok: true } | ExtensionInstallRemoteError;
export type ExtensionUnquarantineResult = { ok: true } | ExtensionInstallRemoteError;

export type ExtensionInstallRemote = {
  installFile(file: Blob & { name?: string }, extra?: { acceptUntrusted?: boolean }): Promise<ExtensionJobAccepted>;
  job(jobId: string): Promise<ExtensionJobRead>;
  cancel(jobId: string): Promise<ExtensionJobRead>;
  uninstall(extensionId: string, options?: { purgeData?: boolean }): Promise<ExtensionJobAccepted>;
  rollback(extensionId: string): Promise<ExtensionJobAccepted>;
  restart(): Promise<ExtensionRestartResult>;
};

async function failure(response: Response, fallback: string): Promise<ExtensionInstallRemoteError> {
  const body = (await response.json().catch(() => null)) as { code?: unknown; message?: unknown } | null;
  return {
    ok: false,
    code: typeof body?.code === "string" ? body.code : response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : "unavailable",
    error: typeof body?.message === "string" && body.message ? body.message : fallback
  };
}

const UNAVAILABLE: ExtensionInstallRemoteError = { ok: false, code: "unavailable", error: "无法连接本机服务" };

function isJob(value: unknown): value is ExtensionInstallJobView {
  const record = value as Record<string, unknown> | null;
  return !!record && typeof record.jobId === "string" && typeof record.status === "string" && typeof record.phase === "string";
}

export function createExtensionInstallRemote(options: { fetchImpl?: typeof globalThis.fetch } = {}): ExtensionInstallRemote {
  const fetchImpl = options.fetchImpl ?? getAppPublicFetch();
  const hostRestart = createHostRestartRemote({ fetchImpl });
  const accepted = async (input: string, init: RequestInit, fallback: string): Promise<ExtensionJobAccepted> => {
    try {
      const response = await fetchImpl(input, init);
      const body = (await response.clone().json().catch(() => null)) as { jobId?: unknown; job?: unknown } | null;
      // 202 正常受理；同步就失败（如受管根不可用）回 422 但仍带任务——都按任务处理，失败原因在任务里。
      if (typeof body?.jobId === "string" && (response.status === 202 || response.status === 422 || response.ok)) {
        return { ok: true, jobId: body.jobId, ...(isJob(body.job) ? { job: body.job } : {}) };
      }
      if (!response.ok) return failure(response, fallback);
      return { ok: false, code: "malformed", error: "宿主响应无法识别" };
    } catch {
      return UNAVAILABLE;
    }
  };
  const readJob = async (input: string, init: RequestInit): Promise<ExtensionJobRead> => {
    try {
      const response = await fetchImpl(input, init);
      if (!response.ok) return failure(response, "无法读取安装任务");
      const body = await response.json().catch(() => null);
      return isJob(body) ? { ok: true, job: body } : { ok: false, code: "malformed", error: "宿主响应无法识别" };
    } catch {
      return UNAVAILABLE;
    }
  };
  const path = (extensionId: string, action: string) => `/api/extensions/${encodeURIComponent(extensionId)}/${action}`;
  return {
    installFile: (file, extra) =>
      accepted(
        EXTENSION_INSTALL_PATH,
        {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            ...(file.name ? { "x-extension-filename": encodeURIComponent(file.name) } : {}),
            ...(extra?.acceptUntrusted ? { "x-accept-untrusted": "1" } : {})
          },
          body: file
        },
        "安装请求失败"
      ),
    job: (jobId) => readJob(`${EXTENSION_INSTALL_PATH}/${encodeURIComponent(jobId)}`, { method: "GET" }),
    cancel: (jobId) => readJob(`${EXTENSION_INSTALL_PATH}/${encodeURIComponent(jobId)}`, { method: "DELETE" }),
    uninstall: (extensionId, opts = {}) =>
      accepted(
        path(extensionId, "uninstall"),
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ purgeData: opts.purgeData === true }) },
        "卸载请求失败"
      ),
    rollback: (extensionId) =>
      accepted(path(extensionId, "rollback"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, "回滚请求失败"),
    async restart() {
      const result = await hostRestart.restart({ reason: "extension-installed" });
      if (result.ok) return { ok: true };
      return {
        ok: false,
        code: result.code === "restart-unsupported" ? "MARKETPLACE_RESTART_UNSUPPORTED" : result.code,
        error: result.error
      };
    }
  };
}
