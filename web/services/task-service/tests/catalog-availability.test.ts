import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import type { GenerationProvider } from "@woohaa3/contracts";
import { createCatalogRuntime } from "../src/composition/catalog-runtime.js";
import { createCatalogHandler } from "../src/composition/http-handlers.js";

it("缺少 API Key 时目录读取成功并提示配置；配置后出现视频模型", async () => {
  const provider: GenerationProvider = {
    extensionId: "ark-provider", providerId: "ark", available: false, provider: undefined,
    models: [{ providerId: "ark", providerModelId: "seedance2_0", modelType: "video" }]
  };
  const runtime = createCatalogRuntime({ modelsConfig: { version: 1, models: [] }, generationProviders: () => [provider] });
  const handler = createCatalogHandler(runtime.resolveCatalog);
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/pptask/catalog`;
  try {
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ available: false, reason: expect.stringContaining("配置 API Key"), models: [] });
    provider.available = true;
    provider.provider = {};
    const ready = await fetch(url);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ available: true, models: [{ modelKey: "ark:seedance2_0", modelType: "video" }] });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
