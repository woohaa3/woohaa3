import { describe, expect, it } from "vitest";
import { CompositeAssetRegistry } from "@woohaa3/frontend/extension-api";
import { createFilmSetModelAdapter } from "../src/preview/browser/model-adapter.js";
import { createFilmSetCanvasContentRuntime } from "../src/integration/backend/content-runtime.js";

describe("片场内容贡献注册", () => {
  it("浏览器 adapter 和宿主运行时登记同一份 nodeData codec", () => {
    const registry = new CompositeAssetRegistry();
    registry.register(createFilmSetModelAdapter());
    const browser = registry.getContent()?.resolve("film-set");
    const host = createFilmSetCanvasContentRuntime().contributions?.find((entry) => entry.extensionId === "film-set");
    expect(browser?.nodeData).toBe(host?.nodeData);
    expect(browser?.nodeData?.validatePatch({}, { filmSetGroup: { schemaVersion: 99, sceneBindings: [] } })).toEqual({
      code: "film-set-group-invalid",
      reason: "film-set-group-invalid"
    });
  });
});
