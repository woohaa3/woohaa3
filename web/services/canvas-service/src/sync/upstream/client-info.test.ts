import { afterEach, describe, expect, it } from "vitest";
import pkg from "../../../package.json";
import { defaultUpstreamClientInfo, UPSTREAM_CLIENT_NAME, upstreamUserAgent } from "./client-info.js";

const original = process.env.WOOHAA3_APP_VERSION;

afterEach(() => {
  if (original === undefined) delete process.env.WOOHAA3_APP_VERSION;
  else process.env.WOOHAA3_APP_VERSION = original;
});

describe("defaultUpstreamClientInfo", () => {
  it("没有注入发布版本时回落到本包版本", () => {
    delete process.env.WOOHAA3_APP_VERSION;
    const info = defaultUpstreamClientInfo();
    expect(info.name).toBe(UPSTREAM_CLIENT_NAME);
    expect(info.version).toBe(pkg.version);
    expect(info.platform).toBe(process.platform + "-" + process.arch);
  });

  it("宿主注入 WOOHAA3_APP_VERSION 时以真实发布版本为准", () => {
    process.env.WOOHAA3_APP_VERSION = "0.1.7";
    expect(defaultUpstreamClientInfo().version).toBe("0.1.7");
  });

  it("空字符串按未上报处理", () => {
    process.env.WOOHAA3_APP_VERSION = "";
    expect(defaultUpstreamClientInfo().version).toBe(pkg.version);
  });
});

describe("upstreamUserAgent", () => {
  it("拼出 woohaa3-host/<version> <platform>", () => {
    expect(upstreamUserAgent({ name: "woohaa3-host", version: "0.1.7", platform: "darwin-arm64" })).toBe(
      "woohaa3-host/0.1.7 darwin-arm64"
    );
  });

  it("版本未知时只留产品名", () => {
    expect(upstreamUserAgent({ name: "woohaa3-host", version: "", platform: "win32-x64" })).toBe(
      "woohaa3-host win32-x64"
    );
  });

  it("移除换行，避免构造非法请求头", () => {
    expect(upstreamUserAgent({ name: "woohaa3-host", version: "0.1.7\r\nx", platform: "darwin-arm64" })).toBe(
      "woohaa3-host/0.1.7 x darwin-arm64"
    );
  });
});
