/**
 * RunningHub 运行期模型发现（设置页「刷新可用模型」）。
 *
 * 数据源是 RunningHub 官方公开的端点 registry
 * （`HM-RunningHub/ComfyUI_RH_OpenAPI` 的 `developer-kit/model-registry.public.json`）：
 * RunningHub 没有「按 API Key 查询标准模型」的接口——`/openapi/v2/resource/list` 是 ComfyUI
 * 资源（UNET/CHECKPOINT/LORA/GGUF），标准模型只有这个公开 registry 与站点目录页。
 *
 * 刷新要回答的是「现在还剩哪些模型」，而**公开 registry 是一份会过期的快照**（当前
 * `public-2026-04-29`：比线上少 `gpt-image-2.5`，也早已没有 `seedance-2.0-global`）。
 * 所以判定分三层，缺一层就会误删线上模型：
 *
 * 1. **registry + 仓库内上游补丁**（`scripts/upstream/*.json`，带抓取日期与来源 URL）
 *    → 这些是「确定还在」的模型；
 * 2. **站点目录页**（`call-api/standard-api`，只渲染一部分模型）→ 只能当**正向证据**：
 *    页面里出现的模型即使 registry 没收录也算还在（`gpt-image-2.5` / `dola` 就是这种）；
 * 3. 两边都没有的 → 视为上游已不再提供，**移除**（并写进刷新结果的 message）。
 *
 * 目录页取不到时**不做移除**：没有证据就保持现状，比凭一份过期快照删模型安全。
 * 启动期不发现（目录仍是构建期确定性的），只有用户点刷新才联网。
 */
import {
  logicalModelsOf,
  mergeWithBase,
  type RunningHubEndpointEntry,
  type RunningHubPipelineModel
} from "../scripts/model-pipeline.mjs";
import upstreamPatch from "../scripts/upstream/runninghub-gpt-image-2-5.json";
import knownLive from "../scripts/upstream/runninghub-known-live.json";
import type { RunningHubLogicalModel } from "./shared.js";

/** 官方端点 registry（构建期脚本用的是同一个文件）。 */
export const RUNNINGHUB_REGISTRY_URL =
  "https://raw.githubusercontent.com/HM-RunningHub/ComfyUI_RH_OpenAPI/main/developer-kit/model-registry.public.json";

/** 站点标准模型目录页：只当「这个模型还在」的正向证据。 */
export const RUNNINGHUB_CATALOG_URL = "https://www.runninghub.ai/call-api/standard-api";

const DISCOVERY_TIMEOUT_MS = 20_000;
const CATALOG_TIMEOUT_MS = 15_000;
/** registry 现在约 1.3MB；上限只用于挡住异常响应，不是正常体积预期。 */
const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

export type RunningHubDiscoveryResult =
  | {
      ok: true;
      models: RunningHubLogicalModel[];
      /** registry + 补丁合并出的逻辑模型数。 */
      discovered: number;
      /** 上游（registry + 补丁 + 目录页）都不再列出、已被移除的模型 id。 */
      removed: string[];
      /** registry 没收录、但站点目录页仍列出的模型 id。 */
      liveOnly: string[];
      /** 目录页是否取到：取不到时不移除任何模型。 */
      catalogChecked: boolean;
    }
  | { ok: false; message: string };

/** 把 registry 的两种常见形状（数组 / `{ models: [...] }`）统一成端点级条目。 */
export function registryEntries(payload: unknown): RunningHubEndpointEntry[] {
  const list = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null && Array.isArray((payload as { models?: unknown }).models)
      ? ((payload as { models: unknown[] }).models)
      : [];
  return list.filter(
    (entry): entry is RunningHubEndpointEntry =>
      typeof entry === "object" && entry !== null && typeof (entry as { endpoint?: unknown }).endpoint === "string"
  );
}

/**
 * 目录页里出现的逻辑模型 id（端点去掉最后一段操作）。
 *
 * 页面是 Nuxt SSR，端点路径以普通字符串嵌在数据里（`/rhart-video/sparkvideo-2.0/multimodal-video`），
 * 所以按「形似端点」的字符串收一遍即可；不收页面自身的路由（`/call-api/...`）。
 */
export function catalogLogicalIds(html: string): Set<string> {
  const ids = new Set<string>();
  for (const match of html.matchAll(/"\/([A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+){1,3})"/g)) {
    const path = match[1]!;
    if (path.startsWith("call-api/")) continue;
    const index = path.lastIndexOf("/");
    if (index <= 0) continue;
    ids.add(path.slice(0, index));
  }
  return ids;
}

export async function discoverRunningHubModels(options: {
  /** 当前清单（刷新前）：上游已不再提供的会被移除。 */
  base: readonly RunningHubLogicalModel[];
  fetchImpl?: typeof globalThis.fetch;
  registryUrl?: string;
  catalogUrl?: string;
  timeoutMs?: number;
  /** 仓库内上游补丁（默认 `scripts/upstream/runninghub-gpt-image-2-5.json`）；测试可置空。 */
  patchEntries?: readonly RunningHubEndpointEntry[];
}): Promise<RunningHubDiscoveryResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const registry = await readJson(fetchImpl, options.registryUrl ?? RUNNINGHUB_REGISTRY_URL, MAX_REGISTRY_BYTES, options.timeoutMs ?? DISCOVERY_TIMEOUT_MS);
  if (!registry.ok) return { ok: false, message: registry.message };
  const entries = registryEntries(registry.value);
  if (entries.length === 0) return { ok: false, message: "RunningHub 模型清单为空" };

  const patch = options.patchEntries ?? registryEntries(upstreamPatch);
  const upstream = logicalModelsOf(mergeByEndpoint(entries, patch));
  if (upstream.length === 0) return { ok: false, message: "RunningHub 模型清单没有可纳管的端点" };
  const upstreamIds = new Set(upstream.map((model) => model.id));

  const catalog = await readText(fetchImpl, options.catalogUrl ?? RUNNINGHUB_CATALOG_URL, MAX_CATALOG_BYTES, CATALOG_TIMEOUT_MS);
  const liveIds = catalog.ok ? catalogLogicalIds(catalog.text) : undefined;

  // 仓库里登记过「站点在售、registry 未收录」的模型：既不算 liveOnly（不打标签），也不会被移除。
  const knownLiveIds = knownLiveIdsOf();
  const absent = options.base.filter((model) => !upstreamIds.has(model.id));
  const liveOnly = absent.filter(
    (model) => !knownLiveIds.has(model.id) && liveIds?.has(model.id) === true
  );
  // 目录页没取到 = 没有「已下架」的证据：保留现状，宁可留着也不误删。
  const removed =
    liveIds === undefined
      ? []
      : absent.filter((model) => !knownLiveIds.has(model.id) && !liveIds.has(model.id));
  // 目录页取不到时整份保留（`removed` 也为空），只有拿到页面才做「只在页面上出现」的正向匹配。
  const keptAbsent =
    liveIds === undefined
      ? absent
      : absent.filter((model) => knownLiveIds.has(model.id) || liveIds.has(model.id));

  const merged = mergeWithBase(upstream, keptAbsent as readonly RunningHubPipelineModel[]);
  return {
    ok: true,
    models: merged.models as unknown as RunningHubLogicalModel[],
    discovered: upstream.length,
    removed: removed.map((model) => model.id),
    liveOnly: liveOnly.map((model) => model.id),
    catalogChecked: liveIds !== undefined
  };
}

/** 仓库登记的在售清单（`scripts/upstream/runninghub-known-live.json`）。 */
export function knownLiveIdsOf(): Set<string> {
  const models = Array.isArray(knownLive?.models) ? knownLive.models : [];
  return new Set(
    models
      .map((entry) => (typeof entry?.id === "string" ? entry.id.trim() : ""))
      .filter((id): id is string => id !== "")
  );
}

/** 按 endpoint 合并（补丁覆盖 registry）。 */
function mergeByEndpoint(
  primary: readonly RunningHubEndpointEntry[],
  patch: readonly RunningHubEndpointEntry[]
): RunningHubEndpointEntry[] {
  const byEndpoint = new Map<string, RunningHubEndpointEntry>();
  for (const entry of primary) byEndpoint.set(entry.endpoint, entry);
  for (const entry of patch) byEndpoint.set(entry.endpoint, entry);
  return [...byEndpoint.values()];
}

async function readJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  maxBytes: number,
  timeoutMs: number
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  const text = await readText(fetchImpl, url, maxBytes, timeoutMs);
  if (!text.ok) return { ok: false, message: text.message };
  try {
    return { ok: true, value: JSON.parse(text.text) };
  } catch {
    return { ok: false, message: "RunningHub 模型清单不是合法 JSON" };
  }
}

async function readText(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  maxBytes: number,
  timeoutMs: number
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json, text/html;q=0.9" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return { ok: false, message: `读取 ${url} 失败（HTTP ${response.status}）` };
    const text = await response.text();
    if (text.length > maxBytes) return { ok: false, message: `${url} 超出体积上限` };
    return { ok: true, text };
  } catch (error) {
    return { ok: false, message: `无法连接 ${url}：${error instanceof Error ? error.message : String(error)}` };
  }
}
