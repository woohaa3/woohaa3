import { describe, expect, it, vi } from "vitest";
import { fetchTemplateCatalog, normalizeCatalogRow, templateKindFromCategory } from "../src/catalog.js";

const UUID = "8f14e45f-ceea-467a-9f0b-1c1e2c3d4e5f";
const SUPABASE = "https://pp.test/supabase/proj";

function harness(rows: unknown, status = 200) {
  const requests: Array<{ url: string; apikey?: string | null; authorization?: string | null; profile?: string | null }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(input),
      apikey: headers.get("apikey"),
      authorization: headers.get("authorization"),
      profile: headers.get("accept-profile")
    });
    return new Response(JSON.stringify(rows), { status, headers: { "content-type": "application/json" } });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests };
}

describe("ppserver 模板目录", () => {
  it("图片类分类认成 image，其余认成 video", () => {
    expect(templateKindFromCategory("image")).toBe("image");
    expect(templateKindFromCategory("image-g")).toBe("image");
    expect(templateKindFromCategory("image-s")).toBe("image");
    expect(templateKindFromCategory("video")).toBe("video");
    expect(templateKindFromCategory("")).toBe("image");
  });

  it("行归一：中文名优先，cost_coins 列覆盖 display_meta", () => {
    const template = normalizeCatalogRow({
      id: UUID,
      name_zhcn: "Nano Banana Pro",
      name_en: "Nano Banana Pro",
      category: "image",
      cost_coins: 32,
      display_meta: { cost_coins: 10, icon: "🍌", success_rate: 98 }
    });
    expect(template).toMatchObject({
      modelId: UUID,
      templateId: UUID,
      kind: "image",
      title: "Nano Banana Pro",
      category: "image",
      cost: 32
    });
    expect(template?.displayMeta).toMatchObject({ icon: "🍌" });
  });

  it("没有 id 的行丢掉，不编造", () => {
    expect(normalizeCatalogRow({ name_zhcn: "x" })).toBeUndefined();
    expect(normalizeCatalogRow(null)).toBeUndefined();
  });

  it("请求同时带 apikey 与用户令牌，并声明 schema", async () => {
    const { fetchImpl, requests } = harness([]);
    await fetchTemplateCatalog({
      supabaseUrl: SUPABASE,
      anonKey: "anon-1",
      accessToken: "jwt-1",
      tenantId: "t1",
      fetchImpl
    });
    expect(requests[0]).toMatchObject({ apikey: "anon-1", authorization: "Bearer jwt-1", profile: "biz_tasks" });
    expect(requests[0]?.url).toContain("is_active=eq.true");
    expect(requests[0]?.url).toContain("tenant_id=eq.t1");
  });

  it("空结果说明可能是被行级权限过滤，而不是「没有模板」", async () => {
    const { fetchImpl } = harness([]);
    const result = await fetchTemplateCatalog({ supabaseUrl: SUPABASE, anonKey: "a", accessToken: "t", fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/行级权限/);
  });

  it("缺令牌时直接说清楚，不发请求", async () => {
    const { fetchImpl, requests } = harness([]);
    const result = await fetchTemplateCatalog({ supabaseUrl: SUPABASE, anonKey: "a", accessToken: "", fetchImpl });
    expect(result.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it("401 时报令牌无效", async () => {
    const { fetchImpl } = harness({ message: "bad jwt" }, 401);
    const result = await fetchTemplateCatalog({ supabaseUrl: SUPABASE, anonKey: "a", accessToken: "t", fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/令牌无效或已过期/);
  });

  it("有数据时给出可直接注册的模板", async () => {
    const { fetchImpl } = harness([
      { id: UUID, name_zhcn: "Pro", category: "image", cost_coins: 40, is_active: true }
    ]);
    const result = await fetchTemplateCatalog({ supabaseUrl: SUPABASE, anonKey: "a", accessToken: "t", fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]?.cost).toBe(40);
  });
});
