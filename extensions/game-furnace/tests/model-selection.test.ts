import { expect, it } from "vitest";
import { languageModelSelection, modelInputCapabilities } from "../src/frontend/model-selection.js";

const catalog = { status: "ready" as const, catalog: { available: true,
  models: [{ modelKey: "image", modelType: "image" }, { modelKey: "language-a", modelType: "language" }, { modelKey: "language-b", modelType: "language" }],
  defaultModels: { language: "language-b" } } };
it("仅列出 language 模型，使用有效默认 modelKey，失效的用户选择不静默替换", () => {
  expect(languageModelSelection(catalog as never)).toMatchObject({ modelKey: "language-b", executable: true });
  expect(languageModelSelection(catalog as never).models.map(model => model.modelKey)).toEqual(["language-a", "language-b"]);
  expect(languageModelSelection(catalog as never, "missing")).toMatchObject({ modelKey: "missing", executable: false });
});
it("加载、断连或无语言模型时禁止生成", () => {
  expect(languageModelSelection({ status: "loading" }).executable).toBe(false);
  expect(languageModelSelection({ status: "error", error: "secret" }).message).toBe("模型目录不可用");
  expect(languageModelSelection({ status: "ready", catalog: { available: true, models: [], defaultModels: {} } }).executable).toBe(false);
});
it("只有 catalog 显式声明 bindings 的模型才导出参考输入能力（任务 6.6）", () => {
  const withBindings = { status: "ready" as const, catalog: { available: true, defaultModels: {},
    models: [{ modelKey: "language-a", modelType: "language", bindings: [
      { field: "images", semantic: "reference-image", roles: ["image"], mediaKinds: ["image"], mediaTypes: ["image/png"], maxItems: 4, valueFormat: "reference" }
    ] }, { modelKey: "language-b", modelType: "language" }] } };
  expect(modelInputCapabilities(withBindings as never, "language-a")).toEqual([{ mediaKinds: ["image"], mediaTypes: ["image/png"] }]);
  expect(modelInputCapabilities(withBindings as never, "language-b")).toEqual([]);
  expect(modelInputCapabilities(withBindings as never, undefined)).toEqual([]);
  expect(modelInputCapabilities({ status: "loading" } as never, "language-a")).toEqual([]);
});
