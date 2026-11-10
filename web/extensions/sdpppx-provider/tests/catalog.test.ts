import { describe, expect, it } from "vitest";
import { fetchSdpppxCatalog, templateFromRow } from "../src/backend/catalog.js";
import { readTestConfig, FULL_ENV, createFetch, headersOf, jsonResponse, textResponse } from "./helpers.js";

describe("template catalog", () => {
  it("按租户与 is_active 过滤，updated_at 倒序，并映射标题/类型", async () => {
    const { fetchImpl, calls } = createFetch(() =>
      jsonResponse([
        { id: "tpl-1", is_active: true, name_zhcn: "中文名", name_en: "English" },
        { id: "tpl-2", is_active: true, name_en: "English only" },
        { id: "tpl-3", is_active: false, name_zhcn: "停用模板" },
        { id: "tpl-4", is_active: true, name_zhcn: "", name_en: "" }
      ])
    );
    const config = readTestConfig({ ...FULL_ENV, SDPPPX_TEMPLATE_MODEL_TYPES: '{"tpl-2":"video"}' });
    const templates = await fetchSdpppxCatalog({ config, accessToken: "jwt-1", fetchImpl });
    expect(templates).toEqual([
      { templateId: "tpl-1", title: "中文名", modelType: "image" },
      { templateId: "tpl-2", title: "English only", modelType: "video" },
      { templateId: "tpl-4", title: "tpl-4", modelType: "image" }
    ]);

    const call = calls[0]!;
    expect(call.url).toContain("/rest/v1/tasks_template?tenant_id=eq.tenant-1");
    expect(call.url).toContain("is_active=eq.true");
    expect(call.url).toContain("order=updated_at.desc");
    expect(headersOf(call)["Accept-Profile"]).toBe("biz_tasks");
    expect(headersOf(call).Authorization).toBe("Bearer jwt-1");
    expect(headersOf(call).apikey).toBe("anon-key");
  });

  it("空目录与请求失败是两种结果", async () => {
    const empty = createFetch(() => jsonResponse([]));
    const config = readTestConfig(FULL_ENV);
    await expect(
      fetchSdpppxCatalog({ config, accessToken: "jwt", fetchImpl: empty.fetchImpl })
    ).resolves.toEqual([]);

    const failing = createFetch(() => textResponse("down", { status: 503 }));
    await expect(
      fetchSdpppxCatalog({ config, accessToken: "jwt", fetchImpl: failing.fetchImpl })
    ).rejects.toMatchObject({ code: "sdpppx-service-unavailable" });
  });

  it("缺 id 的行被忽略，未知类型默认图片", () => {
    expect(templateFromRow({ name_zhcn: "无 id" }, {})).toBeNull();
    expect(templateFromRow({ id: "tpl", name_zhcn: "图" }, { tpl: "image" })).toEqual({
      templateId: "tpl",
      title: "图",
      modelType: "image"
    });
    expect(templateFromRow({ id: "tpl" }, { tpl: "video" })).toEqual({
      templateId: "tpl",
      title: "tpl",
      modelType: "video"
    });
  });
});
