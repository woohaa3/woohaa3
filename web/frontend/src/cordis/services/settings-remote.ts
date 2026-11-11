/**
 * 后端统一配置 remote：设置页读写 `/api/settings` 的唯一出口。
 *
 * 本地单实例不启用访问控制；受控部署由同源会话认证与站点 action 判断管理员。未授权时返回
 * `unauthorized`，设置页据此显示只读提示。
 */
import type { SettingsIssue, SettingsSnapshot, SettingsWriteValue } from "@woohaa3/contracts";
import { getAppPublicFetch } from "./app-base-path.js";
import { SETTINGS_BASE_PATH } from "./paths.js";

export type SettingsRemoteFailure = { ok: false; code: string; error: string; issues?: SettingsIssue[] };
export type SettingsRemoteResult = { ok: true; snapshot: SettingsSnapshot } | SettingsRemoteFailure;
export type SettingsTestRemoteResult = { ok: true; message: string } | { ok: false; error: string; issues?: SettingsIssue[] };

export type SettingsRemote = {
  fetchSnapshot(): Promise<SettingsRemoteResult>;
  /** 安装/卸载一个扩展目录（改名，下一次启动生效）；与启停无关。 */
  setExtensionInstalled?(extensionId: string, installed: boolean): Promise<SettingsRemoteResult>;
  write(values: Record<string, SettingsWriteValue>): Promise<SettingsRemoteResult>;
  /** 测试配置项（不落盘）。 */
  test?(values: Record<string, SettingsWriteValue>): Promise<SettingsTestRemoteResult>;
  /**
   * 写一个 browser-local 插件的启停目标状态：宿主把
   * `extensions.frontend.<id>.enabled` 写进配置文件，并热生效。
   */
  setExtensionToggle?(extensionId: string, enabled: boolean): Promise<SettingsRemoteResult>;
};

export type SettingsRemoteOptions = {
  basePath?: string;
  fetchImpl?: typeof globalThis.fetch;
};

export function createSettingsRemote(options: SettingsRemoteOptions = {}): SettingsRemote {
  const basePath = options.basePath ?? SETTINGS_BASE_PATH;
  const fetchImpl = options.fetchImpl ?? getAppPublicFetch();

  const request = async (method: "GET" | "PUT", body?: unknown, suffix = ""): Promise<SettingsRemoteResult> => {
    try {
      const response = await fetchImpl(`${basePath}${suffix}`, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {})
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
      const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok) {
        return {
          ok: false,
          code: typeof parsed?.code === "string" ? parsed.code : "unavailable",
          error: typeof parsed?.message === "string" && parsed.message !== "" ? parsed.message : "配置服务请求失败",
          ...(Array.isArray(parsed?.issues) ? { issues: parsed.issues as SettingsIssue[] } : {})
        };
      }
      if (!parsed || !Array.isArray(parsed.settings)) return { ok: false, code: "malformed", error: "配置响应无法识别" };
      return { ok: true, snapshot: parsed as unknown as SettingsSnapshot };
    } catch {
      return { ok: false, code: "unavailable", error: "无法连接配置服务" };
    }
  };

  return {
    fetchSnapshot: () => request("GET"),
    setExtensionInstalled: (extensionId, installed) => request("PUT", { extensionId, installed }, "/extensions"),
    write: (values) => request("PUT", { values }),
    async test(values) {
      try {
        const response = await fetchImpl(`${basePath}/test`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ values })
        });
        const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        if (!response.ok || !parsed || parsed.ok !== true) {
          return {
            ok: false,
            error: typeof parsed?.message === "string" && parsed.message !== "" ? parsed.message : "连接测试未通过",
            ...(Array.isArray(parsed?.issues) ? { issues: parsed.issues as SettingsIssue[] } : {})
          };
        }
        return {
          ok: true,
          message: typeof parsed.message === "string" && parsed.message !== "" ? parsed.message : "测试通过"
        };
      } catch {
        return { ok: false, error: "无法连接配置服务" };
      }
    },
    setExtensionToggle: (extensionId, enabled) => request("PUT", { extensionId, enabled }, "/extension-toggles")
  };
}
