/**
 * 日志脱敏测试（change: unify-host-client-logging，任务 1.3）。
 *
 * 表驱动：每种已知凭据形状一条。同时锁定**刻意不做**的部分——高熵字符串不自动打码，
 * 否则 traceId / 内容哈希会被误伤。
 */
import { describe, expect, it } from "vitest";
import { REDACTED, isSensitiveLogKey, redactLogPatterns, redactLogText } from "./redact.js";

describe("redactLogPatterns", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["查询参数 token", "GET /x?token=abc123&a=1", `GET /x?token=${REDACTED}&a=1`],
    ["查询参数 signature", "url?sig=deadbeef", `url?sig=${REDACTED}`],
    ["key=value 文本", "token: abc123", `token: ${REDACTED}`],
    ["等号形式", "password=hunter2", `password=${REDACTED}`],
    ["带引号的值", 'secret="my secret"', `secret=${REDACTED}`],
    ["Authorization Bearer", "Authorization: Bearer eyJhbGciOi.J9", `Authorization: ${REDACTED}`],
    ["Authorization Basic", "Authorization: Basic dXNlcjpwYXNz", `Authorization: ${REDACTED}`],
    ["裸 Bearer", "sent Bearer abc.def.ghi", `sent Bearer ${REDACTED}`],
    ["URL userinfo", "https://user:pw@example.com/x", `https://${REDACTED}@example.com/x`]
  ];

  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(redactLogPatterns(input)).toBe(expected);
    });
  }

  it("不误伤普通文本", () => {
    const text = "canvas saved, 12 nodes";
    expect(redactLogPatterns(text)).toBe(text);
  });

  it("不误伤 traceId（32 位十六进制）", () => {
    const text = "trace 4bf92f3577b34da6a3ce929d0e0e4736";
    expect(redactLogPatterns(text)).toBe(text);
  });

  it("不误伤内容哈希", () => {
    const text = "hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    expect(redactLogPatterns(text)).toBe(text);
  });
});

describe("redactLogText", () => {
  it("先折叠成单行再脱敏（跨行的 token 也能命中）", () => {
    expect(redactLogText("token:\nabc123")).toBe(`token: ${REDACTED}`);
  });

  it("遵守码点上限", () => {
    expect(Array.from(redactLogText("x".repeat(1000), 16)).length).toBe(16);
  });

  it("非字符串输入走序列化后脱敏", () => {
    expect(redactLogText(new Error("password=abc"))).toBe(`password=${REDACTED}`);
  });
});

describe("isSensitiveLogKey", () => {
  it("命中凭据键名", () => {
    for (const key of ["token", "access_token", "apiKey", "api_key", "password", "authorization", "device_code", "userCode"]) {
      expect(isSensitiveLogKey(key), key).toBe(true);
    }
  });

  it("不误判普通键名", () => {
    for (const key of ["module", "event", "status", "server", "phase", "count"]) {
      expect(isSensitiveLogKey(key), key).toBe(false);
    }
  });
});
