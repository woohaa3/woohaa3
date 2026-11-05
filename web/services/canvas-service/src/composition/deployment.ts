/**
 * Canvas Service composition：env 常量、默认值与部署配置校验
 * （自 `composition.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R07）。
 *
 * 纯常量与纯函数；不 import 任何服务实现，避免改变组合拓扑。
 */

/**
 * 默认画布 ID：与前端 `DEFAULT_CANVAS_ID`、E2E 种子画布一致。
 *
 * change: 2026-10-09-refactor-large-source-files-and-remove-compatibility A05 —— 旧的
 * `CANVAS_DEFAULT_CANVAS_ID_ENV` 缺省回退已无消费者，随之删除；本常量保留为前端/服务端
 * 共享的规范默认画布标识。
 */
export const DEFAULT_CANVAS_ID = "woohaa3-default-canvas";

export const CANVAS_TASK_SERVICE_URL_ENV = "WOOHAA3_TASK_SERVICE_URL";
export const CANVAS_MEDIA_SERVICE_URL_ENV = "WOOHAA3_MEDIA_SERVICE_URL";
/** Canvas 调用 Task 内部协议时使用的服务身份令牌（应与 Task 的 `WOOHAA3_TASK_SERVICE_TOKEN` 一致）。 */
export const CANVAS_TASK_SERVICE_TOKEN_ENV = "WOOHAA3_CANVAS_TO_TASK_TOKEN";
/** Canvas 调用 Media 内部协议时使用的服务身份令牌（应与 Media 的 canvas 身份一致）。 */
export const CANVAS_MEDIA_SERVICE_TOKEN_ENV = "WOOHAA3_CANVAS_TO_MEDIA_TOKEN";
/** 内部 MCP Service 调用 Canvas 内部协议时的服务身份令牌。 */
export const CANVAS_MCP_SERVICE_TOKEN_ENV = "WOOHAA3_MCP_TO_CANVAS_TOKEN";
/** 原生 model renderer 可执行文件路径；未配置时预览返回 renderer-unavailable。 */
export const CANVAS_MODEL_RENDERER_CMD_ENV = "WOOHAA3_MODEL_RENDERER_CMD";
/** 预览请求超时（毫秒）。 */
export const CANVAS_MODEL_RENDERER_TIMEOUT_ENV = "WOOHAA3_MODEL_RENDERER_TIMEOUT_MS";
/** 动态镜头视频编码器（Rust `world-video-encoder`）命令；缺失时动态取景显式不可用。 */
export const CANVAS_WORLD_VIDEO_ENCODER_CMD_ENV = "WOOHAA3_WORLD_VIDEO_ENCODER_CMD";
/** 环境变量：显式声明脚本隔离执行器可用（缺省按可用尝试；设为 "0"/"false" 时禁用）。 */
export const CANVAS_SCRIPT_ENGINE_ENV = "WOOHAA3_CANVAS_SCRIPT_ENGINE" as const;
/**
 * loopback 开发模式下用于 Agent authoring 的 principal
 * （change: add-agent-canvas-authoring-mcp，任务 2.1）。
 */
export const CANVAS_AGENT_DEVELOPMENT_PRINCIPAL_ENV = "WOOHAA3_MCP_DEVELOPMENT_PRINCIPAL";

/** 环境变量：显式声明 loopback 开发模式（允许默认画布/开发 principal 兜底）。 */
export const CANVAS_AGENT_LOOPBACK_MODE_ENV = "WOOHAA3_AGENT_LOOPBACK_MODE" as const;

export type AgentDeploymentProfile =
  | { ok: true; loopbackDevelopment: boolean }
  | { ok: false; reason: string };

/**
 * 生产启动配置校验（change: add-agent-canvas-authoring-mcp，任务 2.4 / design D11）。
 */
export function resolveAgentDeploymentProfile(
  env: Record<string, string | undefined>,
  developmentPrincipalId: string | undefined
): AgentDeploymentProfile {
  const loopback = env[CANVAS_AGENT_LOOPBACK_MODE_ENV] === "1" || env[CANVAS_AGENT_LOOPBACK_MODE_ENV] === "true";
  if (loopback) return { ok: true, loopbackDevelopment: true };
  if (developmentPrincipalId) {
    return {
      ok: false,
      reason: `生产模式不得配置 ${CANVAS_AGENT_DEVELOPMENT_PRINCIPAL_ENV}；请显式设置 ${CANVAS_AGENT_LOOPBACK_MODE_ENV}=1 或改由 ingress 注入认证 principal`
    };
  }
  return { ok: true, loopbackDevelopment: false };
}

export function safePathname(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return "";
  }
}

export function isCanvasPath(pathname: string): boolean {
  return pathname === "/api/canvases" || pathname.startsWith("/api/canvases/") || pathname === "/api/canvas-storage/health" || pathname.startsWith("/api/canvas-storage/health/");
}

export function sendJson(res: import("node:http").ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.end(payload);
}
