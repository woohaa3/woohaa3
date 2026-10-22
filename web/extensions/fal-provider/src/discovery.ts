/**
 * 按配置里的 endpoint id 读取 fal 的队列 OpenAPI 定义。
 *
 * 平台模型目录太大（且 `metadata` 可能整体缺失），所以不拉整表：每个 id 请求一次
 * `GET /api/openapi/queue/openapi.json?endpoint_id=...`（公开可读，不需要 Key）。
 * 类别不受支持（语音转写、3D、训练、放大）或没有输入定义的，不注册。
 */
import { classifyFalModel, type FalModel } from "./schema.js";
import { FAL_SCHEMA_ENDPOINT, falSchemaUrl } from "./shared.js";

export type DiscoveryResult =
  | { ok: true; models: FalModel[]; message?: string }
  | { ok: false; message: string };

const DISCOVERY_TIMEOUT_MS = 15_000;
const DISCOVERY_CONCURRENCY = 4;

export async function discoverFalModels(options: {
  modelIds: readonly string[];
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  schemaEndpoint?: string;
}): Promise<DiscoveryResult> {
  if (options.modelIds.length === 0) return { ok: false, message: "先填写模型，每行一个 endpoint id（owner/别名）" };
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const schemaEndpoint = options.schemaEndpoint ?? FAL_SCHEMA_ENDPOINT;
  const results = await mapPool(options.modelIds, DISCOVERY_CONCURRENCY, (id) =>
    loadOne(fetchImpl, schemaEndpoint, id, options.timeoutMs ?? DISCOVERY_TIMEOUT_MS)
  );
  const models: FalModel[] = [];
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
  schemaEndpoint: string,
  id: string,
  timeoutMs: number
): Promise<{ id: string; model?: FalModel; message: string }> {
  try {
    const response = await fetchImpl(falSchemaUrl(id, schemaEndpoint), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return { id, message: `读取定义失败（HTTP ${response.status}）` };
    const model = classifyFalModel(id, await response.json());
    if (!model) return { id, message: "不是受支持的生成模型（图片、视频、音频或文本）" };
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
