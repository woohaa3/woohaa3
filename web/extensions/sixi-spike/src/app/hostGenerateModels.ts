/**
 * 宿主模型目录里的图片 / 视频模型,给首页下拉用。
 *
 * 目录(`taskCatalog`)与生成执行都是**画布页作用域**的服务:首页在应用作用域,拿不到。
 * 所以首页下拉读不到目录时只剩「自动」,进画布后由 Runner 用目录的默认模型与默认参数补齐 ——
 * 这是宿主分层的限制,不是漏做。
 *
 * 参数由 `projectModelConfig` 投影(公共 SDK 导出的纯函数):选项与默认值都来自
 * Provider 声明的 `inputSchema` / `defaultInput`,这里**不写死**比例与分辨率。
 */
import { projectModelConfig, type TaskCatalogService } from "@woohaa3/frontend/extension-api";
import type { HostGenerateKind, HostModelOption, HostParamField } from "@/app/hostGenerate";

/** 只认图片/视频:首页「生成」对应的是画布里的生成节点,不是文本/音频 */
const KINDS: readonly string[] = ["image", "video"];

export async function listGenerateModels(
  service: TaskCatalogService | undefined
): Promise<HostModelOption[]> {
  if (!service) return [];
  try {
    if (service.getState().status !== "ready") await service.load();
    const state = service.getState();
    if (state.status !== "ready") return [];
    const models = state.catalog.models;
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
            options: (f.options ?? []).map((o) => ({ value: o.value, label: o.label }))
          }));
        return {
          modelKey: m.modelKey,
          label: m.title,
          kind: m.modelType as HostGenerateKind,
          params
        };
      });
  } catch {
    return [];
  }
}
