/**
 * 从百炼 `GET /api/v1/models` 发现可用的生图模型。
 *
 * 这个接口**需要鉴权**（`Authorization: Bearer <API Key>`），不是公开表：同一份代码在老域名与
 * 业务空间域名下都可用，返回的是「当前这个 Key / 业务空间能看到什么」。
 *
 * 只发现、不重建：`capabilities=IG`（图片生成）只给出 id、名称、模态这类**身份事实**，给不出
 * 卡片里的能力事实（档位、官方像素表、参考图上限、负向提示词与智能改写）。所以发现结果只用来
 * 判断「卡片里登记的模型现在还在不在」「有没有卡片没覆盖的新模型」，注册表仍以卡片为准。
 *
 * 分页接口必须翻完：文档给的默认页大小是 20，生图模型只是全量模型里的一小类，只看第一页会漏。
 */
import { BAILIAN_MODELS_PATH, bailianOrigin } from "./shared.js";

/** 图片生成的能力枚举值（文档 `capabilities` 一节）。 */
export const BAILIAN_IMAGE_CAPABILITY = "IG";

const DISCOVERY_TIMEOUT_MS = 15_000;
/** 单页上限：文档示例里出现过 `page_size=100`。 */
const PAGE_SIZE = 100;
/** 防呆：真出现异常分页时不无限翻下去。 */
const MAX_PAGES = 20;

export type BailianListedModel = {
  id: string;
  name: string;
  description?: string;
  provider?: string;
  inferenceProvider?: string;
};

export type BailianDiscoveryResult =
  | {
      ok: true;
      /** 上游确实登记了的生图模型 id（含我们没有卡片的）。 */
      models: readonly BailianListedModel[];
      /** 卡片里有、上游这次没返回的 id。 */
      missing: readonly string[];
      /** 上游有、卡片没覆盖的 id。 */
      uncovered: readonly string[];
      /**
       * 清单是否**翻完了**（`collected >= total`）。
       *
       * 只翻到页数上限或上游页大小异常时为 false：这时 `missing` 只是「这一轮没看到」，
       * 不能据此把模型判死——调用方只在对账完整时才降级。
       */
      complete: boolean;
    }
  | { ok: false; message: string };

/**
 * 解析一页返回。
 *
 * 只认 `output.models[]` 里 `model` 为非空字符串的项：官方失败形态是 `{code, message}`（HTTP 200
 * 也可能带业务错误码），这类响应解析成空列表后由调用方按「没有生图模型」处理。
 */
export function parseBailianModels(payload: unknown): { models: BailianListedModel[]; total: number } {
  const root = isRecord(payload) ? payload : {};
  const output = isRecord(root.output) ? root.output : {};
  const raw = Array.isArray(output.models) ? output.models : [];
  const seen = new Set<string>();
  const models: BailianListedModel[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.model === "string" ? entry.model.trim() : "";
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    const name = typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : id;
    models.push({
      id,
      name,
      ...(typeof entry.description === "string" && entry.description.trim() !== ""
        ? { description: entry.description.trim() }
        : {}),
      ...(typeof entry.provider === "string" && entry.provider.trim() !== ""
        ? { provider: entry.provider.trim() }
        : {}),
      ...(typeof entry.inference_provider === "string" && entry.inference_provider.trim() !== ""
        ? { inferenceProvider: entry.inference_provider.trim() }
        : {})
    });
  }
  const total = typeof output.total === "number" && Number.isFinite(output.total) ? output.total : models.length;
  return { models, total };
}

/**
 * 翻完全部页，返回生图模型。
 *
 * `known` 是卡片里已登记的 id：用来算「卡片有但上游没有」（`missing`）与「上游有但卡片没有」
 * （`uncovered`），设置页据此给出可行动的提示，而不是只报一句「发现 N 个模型」。
 */
export async function discoverBailianModels(options: {
  baseUrl: string;
  apiKey?: string;
  known?: readonly string[];
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<BailianDiscoveryResult> {
  const apiKey = (options.apiKey ?? "").trim();
  if (apiKey === "") return { ok: false, message: "先配置 API Key" };
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const origin = bailianOrigin(options.baseUrl);
  const collected: BailianListedModel[] = [];
  const seen = new Set<string>();
  let total = 0;
  let complete = false;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `${origin}${BAILIAN_MODELS_PATH}?capabilities=${BAILIAN_IMAGE_CAPABILITY}&page_no=${page}&page_size=${PAGE_SIZE}`;
    let payload: unknown;
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
          "content-type": "application/json"
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? DISCOVERY_TIMEOUT_MS)
      });
      if (!response.ok) {
        return { ok: false, message: `读取百炼模型列表失败（HTTP ${response.status}）` };
      }
      payload = await response.json();
    } catch (error) {
      return {
        ok: false,
        message: `读取百炼模型列表失败：${error instanceof Error ? error.message : String(error)}`
      };
    }

    const parsed = parseBailianModels(payload);
    total = parsed.total;
    for (const model of parsed.models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      collected.push(model);
    }
    // 已取满总数即收工；这一页没东西时也收工（上游忽略分页时防死循环）。
    if (collected.length >= total) {
      complete = true;
      break;
    }
    if (parsed.models.length === 0) break;
  }

  if (collected.length === 0) {
    return { ok: false, message: "模型列表里没有生图模型：确认 API Key 与地域/业务空间，以及该空间是否开通了图像生成" };
  }

  // 对账按小写比，报告时保留卡片里写的原样 id（提示里给人看的是它）。
  const known = new Map((options.known ?? []).map((id) => [id.trim().toLowerCase(), id.trim()] as const));
  const present = new Set(collected.map((model) => model.id.toLowerCase()));
  const missing = [...known].filter(([lower]) => !present.has(lower)).map(([, id]) => id);
  const uncovered = collected.map((model) => model.id).filter((id) => !known.has(id.toLowerCase()));

  return { ok: true, models: collected, missing, uncovered, complete };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
