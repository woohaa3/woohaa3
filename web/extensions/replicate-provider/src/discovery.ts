/**
 * 按配置里的 `owner/name` 读取 Replicate 模型。
 *
 * 公开模型目录太大，不能整表拉取。每个标识请求一次 `GET /models/{owner}/{name}`，
 * 用最新版本的 OpenAPI 判断类型；没有可运行版本、或输出是 3D 的，不注册。
 */
import { classifyReplicateModel, type ReplicateModel } from "./schema.js";
import { replicateOrigin } from "./shared.js";

export type DiscoveryResult =
  | { ok: true; models: ReplicateModel[]; message?: string }
  | { ok: false; message: string };

const DISCOVERY_TIMEOUT_MS = 15_000;
const DISCOVERY_CONCURRENCY = 4;

export async function discoverReplicateModels(options: {
  baseUrl: string;
  apiKey: string;
  modelIds: readonly string[];
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<DiscoveryResult> {
  if (options.modelIds.length === 0) return { ok: false, message: "先填写模型，每行一个 owner/name" };
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const origin = replicateOrigin(options.baseUrl);
  const results = await mapPool(options.modelIds, DISCOVERY_CONCURRENCY, (id) => loadOne(fetchImpl, origin, options.apiKey, id, options.timeoutMs ?? DISCOVERY_TIMEOUT_MS));
  const models: ReplicateModel[] = [];
  const skipped: string[] = [];
  for (const result of results) {
    if (result.model) models.push(result.model);
    else skipped.push(`${result.id}：${result.message}`);
  }
  models.sort((a, b) => a.modelType.localeCompare(b.modelType) || a.id.localeCompare(b.id));
  if (models.length === 0) return { ok: false, message: skipped[0] ?? "没有可运行的模型" };
  return skipped.length > 0 ? { ok: true, models, message: `跳过 ${skipped.length} 个：${skipped.slice(0, 3).join("；")}` } : { ok: true, models };
}

async function loadOne(
  fetchImpl: typeof globalThis.fetch,
  origin: string,
  apiKey: string,
  id: string,
  timeoutMs: number
): Promise<{ id: string; model?: ReplicateModel; message: string }> {
  const [owner, name] = id.split("/");
  if (!owner || !name) return { id, message: "模型标识必须是 owner/name" };
  const url = `${origin}/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return { id, message: `读取失败（HTTP ${response.status}）` };
    const model = classifyReplicateModel(id, await response.json());
    if (!model) return { id, message: "没有可运行的图片、视频、音频或文本版本" };
    return { id, model, message: "" };
  } catch (error) {
    return { id, message: error instanceof Error ? error.message : String(error) };
  }
}

async function mapPool<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
