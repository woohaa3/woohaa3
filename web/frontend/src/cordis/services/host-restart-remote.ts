/**
 * 宿主受控重启 remote（change: 2026-10-21-harden-extension-fault-isolation，design D6）：
 * `POST /api/host/restart` 的唯一前端出口。202 = 已受理（含排空中的重复请求）。
 */
import { getAppPublicFetch } from "./app-base-path.js";

export const HOST_RESTART_PATH = "/api/host/restart";

export type HostRestartResult = { ok: true } | { ok: false; code: string; error: string };

export type HostRestartRemote = {
  restart(input: { reason: string; exitSafeMode?: boolean }): Promise<HostRestartResult>;
};

export function createHostRestartRemote(options: { fetchImpl?: typeof globalThis.fetch } = {}): HostRestartRemote {
  const fetchImpl = options.fetchImpl ?? getAppPublicFetch();
  return {
    async restart(input) {
      try {
        const response = await fetchImpl(HOST_RESTART_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input)
        });
        if (response.status === 202) return { ok: true };
        const parsed = (await response.json().catch(() => null)) as { code?: unknown; message?: unknown } | null;
        return {
          ok: false,
          code: typeof parsed?.code === "string" ? parsed.code : "unavailable",
          error: typeof parsed?.message === "string" && parsed.message ? parsed.message : "重启请求失败"
        };
      } catch {
        return { ok: false, code: "unavailable", error: "无法连接本机服务" };
      }
    }
  };
}
