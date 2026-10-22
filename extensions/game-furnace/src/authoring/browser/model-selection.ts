import type { CatalogState } from "@woohaa3/frontend/extension-api";

/** 只从当前 language 目录解析 opaque modelKey；已选择但失效的模型不偷偷换用。 */
export function languageModelSelection(state: CatalogState, requested?: string) {
  const catalog = state.status === "ready" ? state.catalog : null;
  const models = catalog?.available ? catalog.models.filter(model => model.modelType === "language") : [];
  const preferred = catalog?.defaultModels.language;
  const modelKey = requested || (models.some(model => model.modelKey === preferred) ? preferred : models[0]?.modelKey);
  return {
    models,
    modelKey,
    executable: !!modelKey && models.some(model => model.modelKey === modelKey),
    message: state.status === "loading" ? "正在加载模型目录…" : state.status === "error" || !catalog?.available
      ? "模型目录不可用" : models.length === 0 ? "暂无可用语言模型" : requested && !models.some(model => model.modelKey === requested)
        ? "当前选择的模型已不可用，请重新选择" : null
  };
}

/**
 * 从 catalog 解析指定 language 模型声明的参考输入能力（任务 6.6）。
 *
 * 返回 `{ mediaKinds, mediaTypes }`：只有 catalog 的 `bindings` 显式声明该 kind（且 MIME 在允许
 * 集合内）的素材才会被后端送入模型；未声明/空 bindings 表示不接受参考输入，后端保守地只送描述。
 */
export function modelInputCapabilities(
  state: CatalogState,
  modelKey: string | undefined
): { mediaKinds: string[]; mediaTypes: string[] }[] {
  const catalog = state.status === "ready" ? state.catalog : null;
  const model = modelKey && catalog?.available
    ? catalog.models.find(entry => entry.modelKey === modelKey && entry.modelType === "language")
    : undefined;
  if (!model) return [];
  const bindings = model.bindings;
  if (!Array.isArray(bindings) || bindings.length === 0) return [];
  return bindings.map(binding => ({
    mediaKinds: [...binding.mediaKinds],
    mediaTypes: [...binding.mediaTypes]
  }));
}
