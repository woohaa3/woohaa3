import { describe, expect, it } from "vitest";
import {
  SDPPPX_DEPLOYMENT_SUPABASE_KEY_FIELD,
  SDPPPX_DEPLOYMENT_SUPABASE_URL_FIELD,
  SDPPPX_DEPLOYMENT_TENANT_FIELD,
  isSdpppxConfigured,
  readSdpppxConfig,
  summarizeSdpppxConfig
} from "../src/backend/config.js";
import { SDPPPX_DEPLOYMENT } from "../src/backend/deployment-config.js";
import {
  DEFAULT_SDPPPX_AUTHING_HOST,
  DEFAULT_SDPPPX_AUTHING_SCENE,
  DEFAULT_SDPPPX_BASE_URL,
  DEFAULT_SDPPPX_PROMPT_FIELD,
  DEFAULT_SDPPPX_TASK_TIMEOUT_MS,
  DEFAULT_SDPPPX_UPLOAD_PROVIDER,
  SDPPPX_ERROR_CODES
} from "../src/shared.js";
import { FULL_ENV, TEST_DEPLOYMENT } from "./helpers.js";

describe("readSdpppxConfig", () => {
  it("内置部署身份直接生效，不再依赖环境变量", () => {
    const config = readSdpppxConfig({});
    expect(config.tenantId).toBe(SDPPPX_DEPLOYMENT.tenantId);
    expect(config.supabaseUrl).toBe(SDPPPX_DEPLOYMENT.supabaseUrl.replace(/\/+$/, ""));
    expect(config.supabaseAnonKey).toBe(SDPPPX_DEPLOYMENT.supabaseAnonKey);
    expect(config.missing).toEqual([]);
    expect(config.degradedCode).toBeNull();
    expect(isSdpppxConfigured(config)).toBe(true);
    expect(config.bridgeUrl).toBe(
      `${SDPPPX_DEPLOYMENT.supabaseUrl.replace(/\/+$/, "")}/functions/v1/authing-bridge3`
    );

    const withEnv = readSdpppxConfig({
      SDPPPX_TENANT_ID: "env-tenant",
      SDPPPX_SUPABASE_URL: "https://env.example",
      SDPPPX_SUPABASE_ANON_KEY: "env-key"
    });
    expect(withEnv.tenantId).toBe(SDPPPX_DEPLOYMENT.tenantId);
    expect(withEnv.supabaseUrl).toBe(SDPPPX_DEPLOYMENT.supabaseUrl.replace(/\/+$/, ""));
    expect(withEnv.supabaseAnonKey).toBe(SDPPPX_DEPLOYMENT.supabaseAnonKey);
  });

  it("内置部署身份缺少值时降级，诊断用部署字段名而不是环境变量名", () => {
    const config = readSdpppxConfig({}, { tenantId: " ", supabaseUrl: "", supabaseAnonKey: "" });
    expect(config.missing).toEqual([
      SDPPPX_DEPLOYMENT_TENANT_FIELD,
      SDPPPX_DEPLOYMENT_SUPABASE_URL_FIELD,
      SDPPPX_DEPLOYMENT_SUPABASE_KEY_FIELD
    ]);
    expect(config.degradedCode).toBe(SDPPPX_ERROR_CODES.configIncomplete);
    expect(isSdpppxConfigured(config)).toBe(false);
    expect(config.bridgeUrl).toBeNull();
  });

  it("可调参数仍读环境变量：bridge 覆盖、显式 Authing host 优先", () => {
    const config = readSdpppxConfig(
      {
        ...FULL_ENV,
        SDPPPX_BRIDGE_URL: "https://bridge.example.com/hook/",
        SDPPPX_AUTHING_HOST: "https://auth.example.com/"
      },
      TEST_DEPLOYMENT
    );
    expect(config.bridgeUrl).toBe("https://bridge.example.com/hook");
    expect(config.authingHost).toBe("https://auth.example.com");
    expect(config.authingHostExplicit).toBe(true);
    expect(config.authingHost).not.toBe(DEFAULT_SDPPPX_AUTHING_HOST);
  });

  it("模板类型映射只接受 image/video，坏 JSON 给出告警但不失败", () => {
    const valid = readSdpppxConfig(
      { ...FULL_ENV, SDPPPX_TEMPLATE_MODEL_TYPES: '{"tpl-a":"video","tpl-b":"image","tpl-c":"audio"}' },
      TEST_DEPLOYMENT
    );
    expect(valid.templateModelTypes).toEqual({ "tpl-a": "video", "tpl-b": "image" });
    expect(valid.warnings).toEqual(["sdpppx-template-map-invalid-entry"]);

    const broken = readSdpppxConfig({ ...FULL_ENV, SDPPPX_TEMPLATE_MODEL_TYPES: "{not json" }, TEST_DEPLOYMENT);
    expect(broken.templateModelTypes).toEqual({});
    expect(broken.warnings).toEqual(["sdpppx-template-map-invalid"]);
    expect(broken.degradedCode).toBeNull();
  });

  it("超时必须是正整数，非法值回落默认", () => {
    expect(
      readSdpppxConfig({ ...FULL_ENV, SDPPPX_TASK_TIMEOUT_MS: "120000" }, TEST_DEPLOYMENT).taskTimeoutMs
    ).toBe(120000);
    expect(
      readSdpppxConfig({ ...FULL_ENV, SDPPPX_TASK_TIMEOUT_MS: "abc" }, TEST_DEPLOYMENT).taskTimeoutMs
    ).toBe(DEFAULT_SDPPPX_TASK_TIMEOUT_MS);
  });

  it("安全投影不包含 anon key，也不猜 appId 值", () => {
    const config = readSdpppxConfig(FULL_ENV, TEST_DEPLOYMENT);
    const summary = summarizeSdpppxConfig(config);
    const text = JSON.stringify(summary);
    expect(text).not.toContain(TEST_DEPLOYMENT.supabaseAnonKey);
    expect(summary.supabaseHost).toBe("project.supabase.co");
    expect(summary.authingAppIdConfigured).toBe(true);
    expect(summary.baseUrl).toBe(DEFAULT_SDPPPX_BASE_URL);
    expect(summary.authingScene).toBe(DEFAULT_SDPPPX_AUTHING_SCENE);
    expect(summary.promptField).toBe(DEFAULT_SDPPPX_PROMPT_FIELD);
    expect(summary.uploadProvider).toBe(DEFAULT_SDPPPX_UPLOAD_PROVIDER);
  });
});
