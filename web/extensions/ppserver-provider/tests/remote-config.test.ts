import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REMOTE_CONFIG_URL,
  fetchRemoteSixiConfig,
  interpretRemoteConfig
} from "../src/remote-config.js";

describe("ppserver 远程配置", () => {
  it("解析出 PS 插件用的三个字段", () => {
    expect(
      interpretRemoteConfig({
        taskrouterBaseUrl: "https://pp.test/ppserver",
        supabaseUrl: "https://pp.test/supabase/proj",
        supabaseAnonKey: "eyJ.anon.key",
        rechargeUrl: "忽略"
      })
    ).toEqual({
      taskrouterBaseUrl: "https://pp.test/ppserver",
      supabaseUrl: "https://pp.test/supabase/proj",
      supabaseAnonKey: "eyJ.anon.key"
    });
  });

  it("地址必须是 http(s)，否则当没给", () => {
    expect(interpretRemoteConfig({ taskrouterBaseUrl: "javascript:alert(1)" }).taskrouterBaseUrl).toBeUndefined();
    expect(interpretRemoteConfig({ taskrouterBaseUrl: "   " }).taskrouterBaseUrl).toBeUndefined();
    // anon key 不是 URL，不做协议校验
    expect(interpretRemoteConfig({ supabaseAnonKey: "raw-key" }).supabaseAnonKey).toBe("raw-key");
  });

  it("坏结构不抛错，返回空配置", () => {
    expect(interpretRemoteConfig(null)).toEqual({});
    expect(interpretRemoteConfig([1, 2])).toEqual({});
  });

  it("默认地址指向 sdppp（不是 sdpppx）的公开配置", () => {
    expect(DEFAULT_REMOTE_CONFIG_URL).toBe("https://sdppp.zombee.tech/banners/sixi/config.json");
  });

  it("拉取成功时返回配置且没有 warning", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ taskrouterBaseUrl: "https://pp.test/ppserver", supabaseAnonKey: "k" })
    );
    const result = await fetchRemoteSixiConfig({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.warning).toBeUndefined();
    expect(result.config.taskrouterBaseUrl).toBe("https://pp.test/ppserver");
  });

  it("拉取失败时给 warning，且不抛", async () => {
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503 }));
    const result = await fetchRemoteSixiConfig({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.config).toEqual({});
    expect(result.warning).toMatch(/HTTP 503/);
  });

  it("网络异常也收口成 warning", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    });
    const result = await fetchRemoteSixiConfig({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.warning).toMatch(/boom/);
  });
});
