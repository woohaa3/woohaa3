import { expect, it } from "vitest";
import { createTaskRemote } from "./task-remote.js";

const model = (extra: Record<string, unknown>) => ({
  modelKey: "ppserver:a", providerId: "ppserver", providerModelId: "a", modelType: "image", title: "Banana2.1-标准",
  interaction: { id: "generic", version: 1 }, inputSchema: {}, defaultInput: {}, bindings: [], taskTimeoutMs: 1000, ...extra
});
const catalogBody = (models: unknown[]) => ({ available: true, models, defaultModels: {} });
const remoteFor = (models: unknown[]) => createTaskRemote({
  fetchImpl: (async () => new Response(JSON.stringify(catalogBody(models)), { status: 200 })) as typeof fetch
});

it("目录解析保留 capabilities（模型选择器靠其中的 category 分组）", async () => {
  const catalog = await remoteFor([model({ capabilities: { category: "image-21" } })]).fetchCatalog();
  expect(catalog.models[0]?.capabilities).toEqual({ category: "image-21" });
});

it("没有 capabilities 的模型不带这个字段", async () => {
  const catalog = await remoteFor([model({})]).fetchCatalog();
  expect(catalog.models[0] && "capabilities" in catalog.models[0]).toBe(false);
});
