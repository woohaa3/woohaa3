/**
 * Task Service 凭据读取（change: split-web-runtime-services，任务 3.1 / 4.1）。
 *
 * **只有凭据**（和端点）从环境变量来：`LITELLM_API_KEY` / `LITELLM_BASE_URL`。
 * 模型启用集合与 per-model 运营覆盖在仓库内模型配置/站点策略里，不走环境变量。
 *
 * `COS_*` **绝不**出现在本服务（proposal：Task 不持有 COS secret；媒体能力经 Media client）。
 *
 * change: 2026-10-07-remove-residual-compatibility —— 删除旧 `PPTASK_LITELLM_*` 兼容别名。
 */
export const LITELLM_ENV_KEYS = [
  "LITELLM_API_KEY",
  "LITELLM_BASE_URL"
] as const;

export type PptaskEnvConfig = {
  apiKey: string;
  baseUrl: string;
};

export type PptaskEnvResult =
  | { ok: true; config: PptaskEnvConfig }
  | { ok: false; reason: string };

export function readPptaskEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  _onWarn?: (message: string) => void
): PptaskEnvResult {
  const apiKey = (env.LITELLM_API_KEY ?? "").trim();
  const baseUrl = (env.LITELLM_BASE_URL ?? "").trim().replace(/\/+$/, "");

  const missing: string[] = [];
  if (apiKey === "") missing.push("LITELLM_API_KEY");
  if (baseUrl === "") missing.push("LITELLM_BASE_URL");
  if (missing.length > 0) {
    return { ok: false, reason: `缺少任务凭据：${missing.join("、")}` };
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { ok: false, reason: "LITELLM_BASE_URL 必须是 http(s) 地址" };
  }
  return { ok: true, config: { apiKey, baseUrl } };
}

/**
 * Task Service 自身配置：durable store 与 Media Service 地址/身份。
 *
 * store 路径不由 Canvas 数据库承担（design D3：不得用 Canvas DB 表充当 Task store）。
 */
export const TASK_STORE_PATH_ENV = "WOOHAA3_TASK_STORE_PATH";
export const TASK_SERVICE_TOKEN_ENV = "WOOHAA3_TASK_SERVICE_TOKEN";
export const MEDIA_SERVICE_URL_ENV = "WOOHAA3_MEDIA_SERVICE_URL";
export const TASK_HISTORY_RETENTION_DAYS_ENV = "WOOHAA3_TASK_HISTORY_RETENTION_DAYS";
export const TASK_HISTORY_MAX_RECORDS_ENV = "WOOHAA3_TASK_HISTORY_MAX_RECORDS";

/** 执行器并发（dispatcher capacity）。 */
export const TASK_WORKER_CONCURRENCY_ENV = "WOOHAA3_TASK_WORKER_CONCURRENCY";
/** active claim 的 lease 时长（heartbeat 按 lease/3 续租）。 */
export const TASK_LEASE_MS_ENV = "WOOHAA3_TASK_LEASE_MS";
/**
 * 低频 recovery sweep 周期（change: replace-worker-db-polling-with-dispatcher，D5）。
 * 只补偿 commit 后通知丢失、timer 丢失和过期 lease；有安全下限，禁止退化成高频轮询。
 */
export const TASK_RECOVERY_INTERVAL_MS_ENV = "WOOHAA3_TASK_RECOVERY_INTERVAL_MS";
export const TASK_RECOVERY_JITTER_MS_ENV = "WOOHAA3_TASK_RECOVERY_JITTER_MS";
/** 优雅停机等待 active executor 的有界宽限。 */
export const TASK_SHUTDOWN_GRACE_MS_ENV = "WOOHAA3_TASK_SHUTDOWN_GRACE_MS";
/**
 * 多实例开关。SQLite profile 只允许单 dispatcher；显式声明多实例时启动失败，
 * 而不是让多个进程静默争用同一 task store（design D9）。
 */
export const TASK_MULTI_INSTANCE_ENV = "WOOHAA3_TASK_MULTI_INSTANCE";

/** sweep 周期安全下限：远高于旧 100ms poll，避免恢复路径退化为轮询。 */
export const MIN_RECOVERY_INTERVAL_MS = 5_000;
export const DEFAULT_RECOVERY_INTERVAL_MS = 30_000;
export const DEFAULT_RECOVERY_JITTER_MS = 5_000;
/** 默认执行器并发与准入上限。 */
export const DEFAULT_WORKER_CONCURRENCY = 2_000;
export const MAX_WORKER_CONCURRENCY = 2_000;
export const DEFAULT_LEASE_MS = 120_000;
export const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;

export type TaskServiceConfig = {
  storePath: string;
  serviceToken?: string;
  mediaServiceUrl?: string;
  historyRetentionDays: number;
  historyMaxRecords: number;
  historyMaxEventsPerRecord: number;
  historyPageSize: number;
  workerConcurrency: number;
  leaseMs: number;
  recoveryIntervalMs: number;
  recoveryJitterMs: number;
  shutdownGraceMs: number;
};

export type TaskServiceConfigResult =
  | { ok: true; config: TaskServiceConfig }
  | { ok: false; reason: string };

export function resolveTaskServiceConfig(
  env: Record<string, string | undefined>
): TaskServiceConfigResult {
  const storePath = (env[TASK_STORE_PATH_ENV] ?? "").trim();
  if (storePath === "") {
    return { ok: false, reason: `缺少 ${TASK_STORE_PATH_ENV}（durable task/history store 路径）` };
  }
  // SQLite profile 无法提供跨进程原子 claim：显式多实例配置必须失败，而不是静默争用。
  if (isTruthy(env[TASK_MULTI_INSTANCE_ENV])) {
    return {
      ok: false,
      reason: "SQLite task store 只支持单 Task Service dispatcher；多实例部署必须先替换为支持跨进程原子 claim 的 durable backend 与 notification transport"
    };
  }
  return {
    ok: true,
    config: {
      storePath,
      serviceToken: trimOrUndefined(env[TASK_SERVICE_TOKEN_ENV]),
      mediaServiceUrl: trimOrUndefined(env[MEDIA_SERVICE_URL_ENV]),
      historyRetentionDays: positiveInt(env[TASK_HISTORY_RETENTION_DAYS_ENV], 30),
      historyMaxRecords: positiveInt(env[TASK_HISTORY_MAX_RECORDS_ENV], 5000),
      historyMaxEventsPerRecord: 200,
      historyPageSize: 50,
      workerConcurrency: atMost(
        positiveInt(env[TASK_WORKER_CONCURRENCY_ENV], DEFAULT_WORKER_CONCURRENCY),
        MAX_WORKER_CONCURRENCY
      ),
      // lease 至少 30s：heartbeat 下限 5s，给恢复留出可观测窗口。
      leaseMs: atLeast(
        positiveInt(env[TASK_LEASE_MS_ENV], DEFAULT_LEASE_MS),
        30_000
      ),
      // recovery 周期必须显著大于旧 100ms 轮询；设置过小时钳到安全下限。
      recoveryIntervalMs: atLeast(
        positiveInt(env[TASK_RECOVERY_INTERVAL_MS_ENV], DEFAULT_RECOVERY_INTERVAL_MS),
        MIN_RECOVERY_INTERVAL_MS
      ),
      recoveryJitterMs: nonNegativeInt(
        env[TASK_RECOVERY_JITTER_MS_ENV],
        DEFAULT_RECOVERY_JITTER_MS
      ),
      shutdownGraceMs: positiveInt(env[TASK_SHUTDOWN_GRACE_MS_ENV], DEFAULT_SHUTDOWN_GRACE_MS)
    }
  };
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? undefined : trimmed;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function atLeast(value: number, minimum: number): number {
  return value < minimum ? minimum : value;
}

function atMost(value: number, maximum: number): number {
  return value > maximum ? maximum : value;
}

function isTruthy(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/** 浏览器只读历史接口的默认前缀（同源，经 ingress 路由到本服务）。 */
export const DEFAULT_TASK_HISTORY_BASE_PATH = "/api/pptask/history";
export const DEFAULT_PPTASK_CATALOG_PATH = "/api/pptask/catalog";

