/**
 * 设置面 API（契约见 `@woohaa3/contracts` 的 `DEFAULT_SETTINGS_BASE_PATH`）。
 *
 * 读写都要求具名 action `extensions.configure`：配置里有远端地址等部署信息，站点部署下
 * 普通用户不应看到。授权走宿主统一执行边界（identity provider + site-access）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  APPLICATION_EXTENSION_LOAD_ACTION,
  DEFAULT_SETTINGS_BASE_PATH,
  WOOHAA3_PROTOCOL_VERSION,
  decodeSettingsWrite,
  type SettingsSnapshot
} from "@woohaa3/contracts";
import type { AccessEnforcer, ApplicationRequestAuthenticator } from "@woohaa3/application-service";
import type { SettingsPatch, SettingsService } from "../settings/settings-service.js";
import { authorizeAdmin } from "./admin-auth.js";

export type SettingsApiDependencies = {
  directoryControl?: import("../extensions/manifest.js").LoadedExtensionHost["directoryControl"];
  settings: Pick<SettingsService, "describe" | "plugins" | "update" | "configFile" | "secretsFile">;
  /**
   * 存储扩展点当前注册的后端；按请求现查（config 在基础层装载，storage 在核心层，构造时还拿不到）。
   * 缺省时不提供可选后端，设置页保持纯文本编辑（独立入口与测试）。
   */
  storageBackends?: () => readonly { backendId: string; label?: string; ownerExtensionId?: string }[] | undefined;
  authenticator?: ApplicationRequestAuthenticator;
  accessEnforcer?: AccessEnforcer;
  basePath?: string;
  logger?: (event: Record<string, unknown>) => void;
};

export function createSettingsApiHandler(deps: SettingsApiDependencies): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const basePath = deps.basePath ?? DEFAULT_SETTINGS_BASE_PATH;
  const log = deps.logger ?? (() => undefined);
  const snapshot = (): SettingsSnapshot => {
    const backends = deps.storageBackends?.() ?? [];
    return {
      installedExtensions: deps.directoryControl?.list() ?? [],
      settings: deps.settings.describe(),
      plugins: deps.settings.plugins(),
      extensionPoints: {
        storage: backends.map((backend) => ({
          id: backend.backendId,
          label: backend.label ?? backend.backendId,
          ownerExtensionId: backend.ownerExtensionId ?? null
        }))
      },
      files: { config: deps.settings.configFile, secrets: deps.settings.secretsFile }
    };
  };

  return async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "");
    const directoryWrite = pathname === `${basePath}/extensions`;
    if (pathname !== basePath && !directoryWrite) return false;

    if (req.method !== "GET" && req.method !== "PUT") {
      sendJson(res, 405, { code: "unsupported", message: "仅支持 GET / PUT" });
      return true;
    }
    const auth = await authorizeAdmin(req, deps, APPLICATION_EXTENSION_LOAD_ACTION);
    if (!auth.ok) {
      log({ event: "settings-unauthorized", method: req.method, status: auth.status });
      sendJson(res, auth.status, { code: auth.code, message: "需要站点管理员授权" });
      return true;
    }
    if (req.method === "GET" && !directoryWrite) {
      sendJson(res, 200, snapshot());
      return true;
    }

    const body = await readJson(req).catch(() => null) as { extensionId?: unknown; installed?: unknown } | null;
    if (directoryWrite) {
      // 目录写入只表达「装/卸」；启用/停用走站点控制面的 `/api/application/extensions/<id>/config`。
      if (req.method !== "PUT" || !body || typeof body !== "object" ||
          typeof body.extensionId !== "string" || typeof body.installed !== "boolean") {
        sendJson(res, 400, { code: "malformed-request", message: "请求必须包含插件标识和安装状态" });
        return true;
      }
      if (!deps.directoryControl) {
        sendJson(res, 503, { code: "unavailable", message: "当前宿主不支持插件目录管理" });
        return true;
      }
      try {
        deps.directoryControl.setInstalled(body.extensionId, body.installed);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const message = code === "EACCES" || code === "EPERM" ? "插件目录不可写，请调整目录权限" :
          error instanceof Error ? error.message : "无法修改插件目录";
        sendJson(res, 409, { code: "directory-change-rejected", message });
        return true;
      }
      log({ event: "extension-directory-changed", actor: auth.actor, extensionId: body.extensionId, installed: body.installed });
      sendJson(res, 200, snapshot());
      return true;
    }
    const decoded = decodeSettingsWrite(body);
    if (!decoded.ok) {
      sendJson(res, 400, { code: "malformed-request", message: decoded.message });
      return true;
    }
    const result = await deps.settings.update(decoded.value.values as SettingsPatch);
    if (!result.ok) {
      sendJson(res, 400, {
        code: "config-invalid",
        message: result.issues.map((issue) => `${issue.key || "(根)"}：${issue.message}`).join("；"),
        issues: result.issues
      });
      return true;
    }
    log({ event: "settings-updated", actor: auth.actor, keys: Object.keys(decoded.value.values), changed: result.changed });
    sendJson(res, 200, snapshot());
    return true;
  };
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  const payload = JSON.stringify(status >= 400 ? { ...body, protocolVersion: WOOHAA3_PROTOCOL_VERSION } : body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.end(payload);
}

async function readJson(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    if (total > maxBytes) throw new Error("payload-too-large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : JSON.parse(text);
}
