import { describe, expect, it } from "vitest";
import { resolveAuthingTarget } from "../src/backend/app-id.js";
import { SDPPPX_ERROR_CODES } from "../src/shared.js";
import { readTestConfig, FULL_ENV, createFetch, headersOf, jsonResponse, textResponse } from "./helpers.js";

describe("resolveAuthingTarget", () => {
  it("显式 SDPPPX_AUTHING_APP_ID 优先，不发任何请求", async () => {
    const { fetchImpl, calls } = createFetch(() => jsonResponse([]));
    const target = await resolveAuthingTarget(readTestConfig(FULL_ENV), { fetchImpl });
    expect(target).toMatchObject({ appId: "app-1", host: "https://core.authing.cn", scene: "WXAPP_AUTH" });
    expect(calls).toHaveLength(0);
  });

  it("未配置 appId 时依次查 public.tenants 与 biz_tenants", async () => {
    const { fetchImpl, calls } = createFetch(({ url }) =>
      url.includes("/rest/v1/tenants?")
        ? jsonResponse([{ id: "tenant-1" }])
        : jsonResponse([{ authing_id: "app-from-tenant", authing_url: "https://tenant.authing.cn/" }])
    );
    const config = readTestConfig({ ...FULL_ENV, SDPPPX_AUTHING_APP_ID: "" });
    const target = await resolveAuthingTarget(config, { fetchImpl });
    expect(target.appId).toBe("app-from-tenant");
    // 未显式配置 host 时采用租户表地址。
    expect(target.host).toBe("https://tenant.authing.cn");
    expect(calls[0]!.url).toContain("/rest/v1/tenants?id=eq.tenant-1&select=id&limit=1");
    expect(calls[1]!.url).toContain("tenants_auth_authing?tenant_id=eq.tenant-1");
    expect(headersOf(calls[1]!)["Accept-Profile"]).toBe("biz_tenants");
  });

  it("显式 SDPPPX_AUTHING_HOST 覆盖租户表地址", async () => {
    const { fetchImpl } = createFetch(({ url }) =>
      url.includes("/rest/v1/tenants?")
        ? jsonResponse([{ id: "tenant-1" }])
        : jsonResponse([{ authing_id: "app-1", authing_url: "https://tenant.authing.cn" }])
    );
    const config = readTestConfig({
      ...FULL_ENV,
      SDPPPX_AUTHING_APP_ID: "",
      SDPPPX_AUTHING_HOST: "https://core.authing.cn"
    });
    const target = await resolveAuthingTarget(config, { fetchImpl });
    expect(target.host).toBe("https://core.authing.cn");
  });

  it("租户不存在 / 没有 authing_id 都返回 authing-app-missing", async () => {
    const noTenant = createFetch(() => jsonResponse([]));
    await expect(
      resolveAuthingTarget(readTestConfig({ ...FULL_ENV, SDPPPX_AUTHING_APP_ID: "" }), {
        fetchImpl: noTenant.fetchImpl
      })
    ).rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.authingAppMissing });

    const noBinding = createFetch(({ url }) =>
      url.includes("/rest/v1/tenants?") ? jsonResponse([{ id: "tenant-1" }]) : jsonResponse([{ authing_id: "" }])
    );
    await expect(
      resolveAuthingTarget(readTestConfig({ ...FULL_ENV, SDPPPX_AUTHING_APP_ID: "" }), {
        fetchImpl: noBinding.fetchImpl
      })
    ).rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.authingAppMissing });
  });

  it("biz_tenants 不可用（400/404）按查不到处理，网络故障继续上抛", async () => {
    const missingTable = createFetch(({ url }) =>
      url.includes("/rest/v1/tenants?")
        ? jsonResponse([{ id: "tenant-1" }])
        : textResponse("not found", { status: 404 })
    );
    await expect(
      resolveAuthingTarget(readTestConfig({ ...FULL_ENV, SDPPPX_AUTHING_APP_ID: "" }), {
        fetchImpl: missingTable.fetchImpl
      })
    ).rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.authingAppMissing });

    const down = createFetch(({ url }) =>
      url.includes("/rest/v1/tenants?")
        ? jsonResponse([{ id: "tenant-1" }])
        : textResponse("down", { status: 503 })
    );
    await expect(
      resolveAuthingTarget(readTestConfig({ ...FULL_ENV, SDPPPX_AUTHING_APP_ID: "" }), {
        fetchImpl: down.fetchImpl
      })
    ).rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.serviceUnavailable });
  });
});
