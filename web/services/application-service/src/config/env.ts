/**
 * Application Service 配置与凭据读取
 * （change: 2026-10-05-extract-application-plugin-host，任务 2.1 / design D1/D3）。
 *
 * 只有**凭据与端点**从环境变量来；站点插件配置权威在 Application 的独立 store。
 * 服务间令牌只用于 Application -> 领域服务；浏览器绝不持有。
 */

export const APPLICATION_STORE_PATH_ENV = "WOOHAA3_APPLICATION_STORE_PATH";
export const APPLICATION_SERVICE_TOKEN_ENV = "WOOHAA3_APPLICATION_SERVICE_TOKEN";
export const TASK_SERVICE_URL_ENV = "WOOHAA3_TASK_SERVICE_URL";
export const MEDIA_SERVICE_URL_ENV = "WOOHAA3_MEDIA_SERVICE_URL";
export const CANVAS_SERVICE_URL_ENV = "WOOHAA3_CANVAS_SERVICE_URL";

export type ApplicationServiceConfig = {
  storePath: string;
  serviceToken?: string;
  taskServiceUrl?: string;
  mediaServiceUrl?: string;
  canvasServiceUrl?: string;
};

export type ApplicationServiceConfigResult =
  | { ok: true; config: ApplicationServiceConfig }
  | { ok: false; reason: string };

export function resolveApplicationServiceConfig(
  env: Record<string, string | undefined>
): ApplicationServiceConfigResult {
  const storePath = (env[APPLICATION_STORE_PATH_ENV] ?? "").trim();
  if (storePath === "") {
    return { ok: false, reason: `缺少 ${APPLICATION_STORE_PATH_ENV}（durable application/plugin store 路径）` };
  }
  return {
    ok: true,
    config: {
      storePath,
      serviceToken: trimOrUndefined(env[APPLICATION_SERVICE_TOKEN_ENV]),
      taskServiceUrl: trimOrUndefined(env[TASK_SERVICE_URL_ENV]),
      mediaServiceUrl: trimOrUndefined(env[MEDIA_SERVICE_URL_ENV]),
      canvasServiceUrl: trimOrUndefined(env[CANVAS_SERVICE_URL_ENV])
    }
  };
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? undefined : trimmed;
}
