/**
 * RunningHub 标准模型区域可用性（change: 2026-11-17-add-runninghub-region-detection）。
 *
 * `data/model-availability.json` 由 `scripts/generate-model-availability.mjs` 探测两站标准模型
 * API 路由生成。运行期只读这份映射，不批量请求上游。
 *
 * 过滤是**保守**的：只隐藏“有证据不可用”的端点（上游返回 1001 Invalid URL）。网络失败、
 * 5xx、405 等未知情况不写入清单，运行期一律保留，避免用不完整探测误删合法模型。
 */
import availabilityData from "../data/model-availability.json";
import type { RunningHubRegion } from "./region.js";

export type RunningHubEndpointAvailability = {
  /** 明确不可用的端点；不是可用列表。 */
  readonly ai: ReadonlySet<string>;
  readonly cn: ReadonlySet<string>;
};

function endpointSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim().replace(/^\/+/, ""))
      .filter((entry) => entry !== "")
  );
}

function availabilityFrom(value: unknown): RunningHubEndpointAvailability {
  const unavailable = value && typeof value === "object" && !Array.isArray(value)
    ? (value as { unavailable?: unknown }).unavailable
    : undefined;
  const record = unavailable && typeof unavailable === "object" && !Array.isArray(unavailable)
    ? (unavailable as { ai?: unknown; cn?: unknown })
    : {};
  return { ai: endpointSet(record.ai), cn: endpointSet(record.cn) };
}

export const RUNNINGHUB_ENDPOINT_AVAILABILITY: RunningHubEndpointAvailability = availabilityFrom(availabilityData);

/**
 * 该端点是否可在指定区域使用。
 *
 * - 明确记录为该区域不可用：隐藏。
 * - 其余（可用或未知）：保留。
 */
export function isEndpointAvailableInRegion(
  region: RunningHubRegion,
  endpoint: string,
  availability: RunningHubEndpointAvailability = RUNNINGHUB_ENDPOINT_AVAILABILITY
): boolean {
  const normalized = endpoint.trim().replace(/^\/+/, "");
  if (normalized === "") return true;
  return !availability[region].has(normalized);
}

/** 只保留当前区域可用的路由。 */
export function availableRoutesInRegion<T extends { endpoint: string }>(
  routes: readonly T[],
  region: RunningHubRegion,
  availability?: RunningHubEndpointAvailability
): T[] {
  return routes.filter((route) => isEndpointAvailableInRegion(region, route.endpoint, availability));
}

/** 过滤逻辑模型的路由；没有可用路由时返回 undefined。 */
export function filterModelRoutesForRegion<T extends { routes: readonly { endpoint: string }[] }>(
  model: T,
  region: RunningHubRegion,
  availability?: RunningHubEndpointAvailability
): T | undefined {
  const routes = availableRoutesInRegion(model.routes, region, availability);
  if (routes.length === 0) return undefined;
  if (routes.length === model.routes.length) return model;
  return { ...model, routes } as T;
}
