/**
 * ChatGPT 授权/生成服务部署配置
 * （change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 2.1 / design D2）。
 *
 * 凭据目录与密钥位置 MUST 由部署配置指定，当前 change 不固定默认路径。未配置时服务处于
 * 「未启用」状态：`/api/oauth-agent/*` 返回明确不可用状态，不静默使用临时目录。
 *
 * 环境变量：
 * - `WOOHAA3_CHATGPT_CREDENTIAL_DIR`：per-user 加密凭据目录（绝对路径；0700）。
 * - `WOOHAA3_CHATGPT_MASTER_KEY`：base64 编码的 32 字节主密钥（与凭据目录分离）。
 * - `WOOHAA3_CHATGPT_MASTER_KEY_FILE`：主密钥文件路径（与上面二选一；文件 0600）。
 * - `WOOHAA3_CHATGPT_CODEX_HOME_DIR`：隔离的 Codex HOME 根目录（每 owner 一个子目录）。
 * - `WOOHAA3_CHATGPT_WORKSPACE_DIR`：受限工作目录根（每 owner 一个子目录）。
 * - `WOOHAA3_CHATGPT_CALLBACK_ORIGIN`：外部回调 origin（`https://app.example.com`）。
 *   缺失时仅在 loopback 本地开发姿态回退到请求自身 origin（仍需 `WOOHAA3_CHATGPT_ALLOW_LOCAL_CALLBACK=1`）。
 * - `WOOHAA3_CHATGPT_ALLOW_LOCAL_CALLBACK`：允许 loopback 开发回退（`1`/`true`）。
 * - `WOOHAA3_CHATGPT_CODEX_BIN`：覆盖 SDK 解析的 CLI 入口（测试用；生产留空由 SDK 解析）。
 * - `WOOHAA3_CHATGPT_ISSUER`：OAuth issuer（缺省 `https://auth.openai.com`，测试可覆盖）。
 *
 * 已删除的执行额度配置（change: 2026-10-22-remove-agent-execution-limits，任务 2.3 / 3.3）：
 * `WOOHAA3_CHATGPT_MAX_CONCURRENCY`、`WOOHAA3_CHATGPT_MAX_QUEUE_DEPTH`、
 * `WOOHAA3_CHATGPT_TURN_TIMEOUT_MS` 与 `WOOHAA3_CHATGPT_MAX_TOOL_CALLS`。它们过去限制并发、
 * 排队深度、单回合总时长与工具次数；现在即使仍存在于部署环境也不再被读取，不会恢复任何拒绝路径。
 * 每个回合拥有独立执行上下文与取消身份，停止只来自用户、引擎真实结束/失败与权限失效。
 */
import path from "node:path";
import fs from "node:fs";
import { addAppBasePath, normalizeAppBasePath } from "@woohaa3/contracts";

export const CHATGPT_PROVIDER_ID = "openai-chatgpt" as const;
export const CHATGPT_PLUGIN_ID = "openai-chatgpt" as const;

export const CHATGPT_ENV = {
  credentialDir: "WOOHAA3_CHATGPT_CREDENTIAL_DIR",
  masterKey: "WOOHAA3_CHATGPT_MASTER_KEY",
  masterKeyFile: "WOOHAA3_CHATGPT_MASTER_KEY_FILE",
  codexHomeDir: "WOOHAA3_CHATGPT_CODEX_HOME_DIR",
  workspaceDir: "WOOHAA3_CHATGPT_WORKSPACE_DIR",
  callbackOrigin: "WOOHAA3_CHATGPT_CALLBACK_ORIGIN",
  allowLocalCallback: "WOOHAA3_CHATGPT_ALLOW_LOCAL_CALLBACK",
  codexBin: "WOOHAA3_CHATGPT_CODEX_BIN",
  issuer: "WOOHAA3_CHATGPT_ISSUER",
  appClientId: "WOOHAA3_CHATGPT_APP_CLIENT_ID",
  mcpUrl: "WOOHAA3_CHATGPT_MCP_URL"
} as const;

/** 旧执行额度环境变量名（保留常量仅用于迁移说明与测试断言「不再生效」）。 */
export const CHATGPT_LEGACY_LIMIT_ENV = {
  maxConcurrency: "WOOHAA3_CHATGPT_MAX_CONCURRENCY",
  turnTimeoutMs: "WOOHAA3_CHATGPT_TURN_TIMEOUT_MS",
  maxQueueDepth: "WOOHAA3_CHATGPT_MAX_QUEUE_DEPTH",
  maxToolCalls: "WOOHAA3_CHATGPT_MAX_TOOL_CALLS"
} as const;

export type ChatGptServiceConfig = {
  /** 凭据目录绝对路径（部署指定）。 */
  credentialDir: string;
  /** base64 主密钥（32 字节）。 */
  masterKey: Buffer;
  /** 隔离 Codex HOME 根目录。 */
  codexHomeDir: string;
  /** 受限工作目录根。 */
  workspaceDir: string;
  /** 外部回调 origin（`https://...`）；缺失时为 null（仅本地回退）。 */
  callbackOrigin: string | null;
  /** 是否允许 loopback 本地回调回退。 */
  allowLocalCallback: boolean;
  /** Codex CLI 入口覆盖（测试/自定义）。 */
  codexBin: string | null;
  /** OAuth issuer。 */
  issuer: string;
  /** 已注册应用 client id（缺失时使用动态注册）。 */
  appClientId: string | null;
  /** 受控 MCP 工具面 URL（缺省同源 `/mcp/model-canvas`）。 */
  mcpUrl: string;
};

export type ChatGptConfigResult =
  | { ok: true; config: ChatGptServiceConfig }
  | { ok: false; configured: false; reason: string };

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

function readEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  return typeof value === "string" ? value.trim() : "";
}

function readMasterKey(env: Record<string, string | undefined>): { ok: true; key: Buffer } | { ok: false; reason: string } {
  const inline = readEnv(env, CHATGPT_ENV.masterKey);
  if (inline !== "") {
    let decoded: Buffer;
    try {
      decoded = Buffer.from(inline, "base64");
    } catch {
      return { ok: false, reason: "WOOHAA3_CHATGPT_MASTER_KEY 不是合法 base64" };
    }
    if (decoded.byteLength !== 32) return { ok: false, reason: "WOOHAA3_CHATGPT_MASTER_KEY 必须是 base64 编码的 32 字节" };
    return { ok: true, key: decoded };
  }
  const file = readEnv(env, CHATGPT_ENV.masterKeyFile);
  if (file !== "") {
    try {
      const fromFile = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
      if (fromFile.byteLength !== 32) return { ok: false, reason: "主密钥文件内容必须是 base64 编码的 32 字节" };
      return { ok: true, key: fromFile };
    } catch (error) {
      return { ok: false, reason: `无法读取主密钥文件：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { ok: false, reason: "缺少 WOOHAA3_CHATGPT_MASTER_KEY 或 WOOHAA3_CHATGPT_MASTER_KEY_FILE" };
}

/**
 * 解析部署配置。任何持久化必需项缺失时返回未配置（服务不启用），而不是回退到临时路径。
 */
export function resolveChatGptServiceConfig(
  env: Record<string, string | undefined>,
  basePath = "/"
): ChatGptConfigResult {
  const deployment = normalizeAppBasePath(basePath);
  if (!deployment.ok) return { ok: false, configured: false, reason: deployment.error };
  const credentialDir = readEnv(env, CHATGPT_ENV.credentialDir);
  if (credentialDir === "" || !path.isAbsolute(credentialDir)) {
    return { ok: false, configured: false, reason: "未配置绝对路径 WOOHAA3_CHATGPT_CREDENTIAL_DIR（凭据目录）" };
  }
  const master = readMasterKey(env);
  if (!master.ok) return { ok: false, configured: false, reason: master.reason };
  const codexHomeDir = readEnv(env, CHATGPT_ENV.codexHomeDir) || path.join(credentialDir, "codex-home");
  const workspaceDir = readEnv(env, CHATGPT_ENV.workspaceDir) || path.join(credentialDir, "workspace");
  const callbackOriginRaw = readEnv(env, CHATGPT_ENV.callbackOrigin);
  let callbackOrigin: string | null = null;
  if (callbackOriginRaw !== "") {
    try {
      const url = new URL(callbackOriginRaw);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        return { ok: false, configured: false, reason: "回调 origin 必须是 http(s)" };
      }
      callbackOrigin = url.origin;
    } catch {
      return { ok: false, configured: false, reason: "WOOHAA3_CHATGPT_CALLBACK_ORIGIN 不是合法 URL" };
    }
  }
  const codexBin = readEnv(env, CHATGPT_ENV.codexBin) || null;
  const appClientId = readEnv(env, CHATGPT_ENV.appClientId) || null;
  const issuer = readEnv(env, CHATGPT_ENV.issuer) || "https://auth.openai.com";
  const mcpUrl =
    readEnv(env, CHATGPT_ENV.mcpUrl) ||
    `http://127.0.0.1:${readEnv(env, "BACKEND_PORT") || readEnv(env, "PORT") || "5180"}${addAppBasePath(deployment.basePath, "/mcp/model-canvas")}`;
  return {
    ok: true,
    config: {
      credentialDir,
      masterKey: master.key,
      codexHomeDir,
      workspaceDir,
      callbackOrigin,
      allowLocalCallback: isTruthy(env[CHATGPT_ENV.allowLocalCallback]),
      codexBin,
      issuer,
      appClientId,
      mcpUrl
    }
  };
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}
