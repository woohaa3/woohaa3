/**
 * RunningHub 标准模型区域可用性（change: 2026-11-17-add-runninghub-region-detection）。
 *
 * `data/model-availability.json` 由 `scripts/generate-model-availability.mjs` 从两站标准模型
 * SKU 列表与详情生成。运行期只读这份映射，不批量请求上游。
 *
 * 国内站使用**严格白名单**：只有出现在国内站 SKU 列表里的端点是可用的。国际站使用保守
 * 过滤：只隐藏“明确属于国内站独有”的端点，未知端点保留。SKU 详情里的 `isOversea`
 * （1 = 仅海外，0 = 国内可用）用于生成清单，不能用 API 路由是否存在代替售卖/账号可用性。
 */
import availabilityData from "../data/model-availability.json";
import type { RunningHubRegion } from "./region.js";

export type RunningHubEndpointAvailability = {
  /** 该站点 SKU 清单覆盖到的可用端点。 */
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
  const regions = value && typeof value === "object" && !Array.isArray(value)
    ? (value as { regions?: unknown }).regions
    : undefined;
  const record = regions && typeof regions === "object" && !Array.isArray(regions)
    ? (regions as { ai?: unknown; cn?: unknown })
    : {};
  return { ai: endpointSet(record.ai), cn: endpointSet(record.cn) };
}

export const RUNNINGHUB_ENDPOINT_AVAILABILITY: RunningHubEndpointAvailability = availabilityFrom(availabilityData);

/**
 * 该端点是否可在指定区域使用。
 *
 * - 国内站：严格按国内 SKU 白名单，不在清单里就隐藏（GPT Image／全能图片／dola 等均不在）。
 * - 国际站：在清单里可用；只在国内站清单里则隐藏；两边都没有视为未知并保留。
 * - 两边的清单都为空（测试或映射损坏）时不隐藏，避免把整个目录清空。
 */
export function isEndpointAvailableInRegion(
  region: RunningHubRegion,
  endpoint: string,
  availability: RunningHubEndpointAvailability = RUNNINGHUB_ENDPOINT_AVAILABILITY
): boolean {
  const normalized = endpoint.trim().replace(/^\/+/, "");
  if (normalized === "") return true;
  const current = availability[region];
  const other = region === "ai" ? availability.cn : availability.ai;
  if (current.size === 0 && other.size === 0) return true;
  if (current.has(normalized)) return true;
  if (region === "cn") return false;
  return !other.has(normalized);
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
