/**
 * 首页读宿主任务目录里的图片 / 视频模型。
 *
 * **为什么不走 `taskCatalog` 服务**:那是画布页作用域的服务(见宿主 `installCanvasPageServices`),
 * 首页在应用作用域拿不到;而 `GET /api/pptask/catalog` 是同源 JSON 接口,首页能直接读 ——
 * 读的是同一份数据,不是另造一套。拿得到画布作用域的服务时优先用它,省一次请求。
 *
 * 参数由 `projectModelConfig` 投影(公共 SDK 导出的纯函数):选项与默认值都来自
 * Provider 声明的 `inputSchema` / `defaultInput`,这里**不写死**比例与分辨率。
 */
import { projectModelConfig, resolvePublicUrl, type TaskCatalogService } from "@woohaa3/frontend/extension-api";
import type { CanvasTaskCatalog } from "@woohaa3/contracts";
import type { HostGenerateKind, HostModelOption, HostParamField } from "@/app/hostGenerate";

/** 只认图片/视频:首页「生成」对应的是画布里的生成节点,不是文本/音频 */
const KINDS: readonly string[] = ["image", "video"];

/** 与宿主 `PPTASK_BASE_PATH` 同一条路径 */
const CATALOG_PATH = "/api/pptask/catalog";

/** 成功拉到的目录缓存一份(首页停留期间不会变);失败不缓存,下次重试 */
let cachedCatalog: CanvasTaskCatalog | null = null;
let inflight: Promise<CanvasTaskCatalog | null> | null = null;

async function fetchCatalog(): Promise<CanvasTaskCatalog | null> {
  if (cachedCatalog) return cachedCatalog;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const response = await fetch(resolvePublicUrl(CATALOG_PATH), { credentials: "same-origin" });
      if (!response.ok) return null;
      const body = (await response.json()) as unknown;
      if (typeof body !== "object" || body === null) return null;
      const catalog = body as CanvasTaskCatalog;
      if (!Array.isArray(catalog.models)) return null;
      cachedCatalog = catalog;
      return catalog;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * 读目录里的图片 / 视频模型。
 *
 * `fallback` 是画布作用域的 `taskCatalog`(首页通常拿不到,传 undefined 即可)。
 */
export async function listGenerateModels(fallback?: TaskCatalogService): Promise<HostModelOption[]> {
  let catalog = await fetchCatalog();
  if (!catalog && fallback) {
    try {
      if (fallback.getState().status !== "ready") await fallback.load();
      const state = fallback.getState();
      if (state.status === "ready") catalog = state.catalog;
    } catch {
      /* 两条路都失败:下拉只剩「自动」 */
    }
  }
  if (!catalog) return [];

  const models = catalog.models;
  const config = projectModelConfig(models, "", "");
  return models
    .filter((m) => KINDS.includes(m.modelType))
    .map((m) => {
      const defaults = config.defaultsByModel[m.modelKey] ?? {};
      const params: HostParamField[] = (config.parameterSchemaByModel[m.modelKey] ?? [])
        // 首页只有一行工具位,只放下拉型的参数;滑杆/数字进画布后仍可调
        .filter((f) => Array.isArray(f.options) && f.options.length > 0)
        .map((f) => ({
          key: f.key,
          label: f.label,
          value: String(defaults[f.key] ?? f.defaultValue ?? f.options?.[0]?.value ?? ""),
          options: (f.options ?? []).map((o) => ({ value: o.value, label: o.label })),
          ...(f.semantic ? { semantic: f.semantic } : {}),
          ...(f.adaptiveValue !== undefined ? { adaptiveValue: f.adaptiveValue } : {})
        }));
      return {
        modelKey: m.modelKey,
        label: m.title,
        kind: m.modelType as HostGenerateKind,
        params
      };
    });
}
