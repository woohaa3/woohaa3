/**
 * 宿主诊断缓冲测试：锁住三条性质。
 *
 * 1. **只收白名单**：remote-server 扩展事件与画布同步上游事件；其它模块的日志不进缓冲。
 * 2. **只投影白名单字段**：原始事件里的 token/body/url 等不会出现在条目里，说明文本还会
 *    再做一次令牌式脱敏。
 * 3. **有界**：环满丢最旧，读取有上限，返回副本。
 */
import { describe, expect, it } from "vitest";
import {
  MAX_DIAGNOSTIC_ENTRIES,
  createHostDiagnostics,
  projectHostLogEvent,
  sanitizeDiagnosticText
} from "./diagnostics.js";

const remote = (event: string, extra: Record<string, unknown> = {}) => ({
  module: "application",
  extensionId: "remote-server",
  event,
  ...extra
});

describe("宿主诊断缓冲", () => {
  it("只记录服务端接入与同步上游事件，其它模块一律丢弃", () => {
    const diagnostics = createHostDiagnostics({ now: () => 1_000 });
    diagnostics.record(remote("remote-probe-ok", { serverHost: "srv.example:443" }));
    diagnostics.record({ module: "canvas", event: "sync-upstream-synced", canvasId: "c1" });
    diagnostics.record({ module: "canvas", event: "canvas-sync-upstream" });
    diagnostics.record({ module: "application", extensionId: "other-extension", event: "other-event" });
    diagnostics.record({ module: "media", event: "media-import" });
    diagnostics.record({ module: "canvas", event: "unrelated-canvas-event" });

    expect(diagnostics.snapshot().map((entry) => entry.event)).toEqual([
      "remote-probe-ok",
      "sync-upstream-synced",
      "canvas-sync-upstream"
    ]);
    const first = diagnostics.snapshot()[0]!;
    expect(first).toMatchObject({
      seq: 1,
      time: 1_000,
      level: "info",
      category: "application",
      event: "remote-probe-ok",
      attributes: { server: "srv.example:443" }
    });
    // 只有细节、没有主文本时 message 缺省，细节仍在 attributes 里。
    expect(first.message).toBeUndefined();
  });

  it("只投影白名单字段：token/body/url 不进入条目", () => {
    const projected = projectHostLogEvent(
      remote("remote-login-failed", {
        code: "unauthenticated",
        message: "凭证无效",
        token: "session-secret",
        authorization: "Bearer session-secret",
        body: { token: "session-secret" },
        url: "https://srv.example/?token=session-secret",
        deviceCode: "device-secret"
      })
    );
    expect(projected).toEqual({
      level: "info",
      category: "application",
      event: "remote-login-failed",
      code: "unauthenticated",
      message: "凭证无效"
    });
    // 没有合法细节时连 attributes 这个键都不出现（与 code/message 的省略风格一致）。
    expect(projected).not.toHaveProperty("attributes");
    expect(JSON.stringify(projected)).not.toContain("session-secret");
  });

  it("结构化细节进 attributes，message 只保留人类可读主文本", () => {
    const projected = projectHostLogEvent(
      remote("remote-probe-failed", {
        message: "远端探测失败",
        status: 502,
        serverHost: "srv.example:443",
        method: "gateway",
        backendId: "be-1",
        phase: "probe",
        invalid: "token",
        missing: ["url", "token", "device-code"]
      })
    );
    expect(projected).toEqual({
      level: "info",
      category: "application",
      event: "remote-probe-failed",
      message: "远端探测失败",
      attributes: {
        status: "502",
        server: "srv.example:443",
        method: "gateway",
        backend: "be-1",
        phase: "probe",
        invalid: "token",
        missing: "url,token,device-code"
      }
    });
    // 键值形状必须落在契约范围内：键 [a-z][a-z0-9._-]{0,31}、值单行且 ≤256 字符。
    for (const [key, value] of Object.entries(projected!.attributes!)) {
      expect(key).toMatch(/^[a-z][a-z0-9._-]{0,31}$/);
      expect(value.length).toBeLessThanOrEqual(256);
      expect(value).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
  });

  it("missing 最多保留 8 项，逗号连接", () => {
    const projected = projectHostLogEvent(
      remote("remote-config-missing", { missing: Array.from({ length: 12 }, (_, index) => `k${index}`) })
    );
    expect(projected!.attributes).toEqual({
      missing: Array.from({ length: 8 }, (_, index) => `k${index}`).join(",")
    });
  });

  it("值超长截断、非法细节整对丢弃，条目仍然入库", () => {
    const diagnostics = createHostDiagnostics({ now: () => 1_000 });
    // 形状合法（SAFE_HOST 允许 ≤255 主机字符 + 端口）但超过 256 字符的值上限：截断而不是丢弃。
    const longHost = `${"a".repeat(255)}:65535`;
    diagnostics.record(remote("remote-probe-ok", { serverHost: longHost }));
    diagnostics.record(
      remote("remote-probe-failed", {
        message: "探测失败",
        // 以下字段都不合形状：整对丢弃，但不影响条目本身入库。
        status: 1_000,
        serverHost: "https://srv.example/?token=secret",
        method: "GET /v1",
        invalid: "Bad Key!"
      })
    );

    const [truncated, invalid] = diagnostics.snapshot();
    expect(truncated!.attributes).toEqual({ server: `${"a".repeat(255)}…` });
    expect(truncated!.message).toBeUndefined();
    expect(invalid).toMatchObject({ event: "remote-probe-failed", message: "探测失败" });
    // 非法细节没有退化成 message 片段，也没有留下空的 attributes。
    expect(invalid).not.toHaveProperty("attributes");
  });

  it("说明文本会再做令牌式脱敏并折叠控制字符", () => {
    expect(sanitizeDiagnosticText("failed ?token=abc123&x=1")).toBe("failed ?token=[redacted]&x=1");
    expect(sanitizeDiagnosticText("Authorization: Bearer abc.def")).not.toContain("abc.def");
    expect(sanitizeDiagnosticText("line1\nline2\ttab")).toBe("line1 line2 tab");
    expect(sanitizeDiagnosticText("x".repeat(2_000))!.length).toBeLessThanOrEqual(512);
  });

  it("拒绝不安全的标识符，而不是把它们当自由文本收下", () => {
    expect(projectHostLogEvent(remote("Remote Probe OK"))).toBeNull();
    expect(projectHostLogEvent(remote("ok", { code: "Bad Code!" }))).toMatchObject({ event: "ok" });
    expect(projectHostLogEvent(remote("ok", { code: "Bad Code!" }))!.code).toBeUndefined();
    expect(projectHostLogEvent({ module: "application", extensionId: "remote-server", event: "" })).toBeNull();
  });

  it("级别按白名单归一，未知级别退回 info", () => {
    expect(projectHostLogEvent(remote("remote-error", { level: "error" }))!.level).toBe("error");
    expect(projectHostLogEvent(remote("remote-odd", { level: "verbose" }))!.level).toBe("info");
  });

  it("环满只保留最新条目，读取返回副本", () => {
    const diagnostics = createHostDiagnostics({ capacity: 2 });
    diagnostics.record(remote("remote-a"));
    diagnostics.record(remote("remote-b"));
    diagnostics.record(remote("remote-c"));

    const entries = diagnostics.snapshot();
    expect(entries.map((entry) => entry.event)).toEqual(["remote-b", "remote-c"]);
    expect(entries.map((entry) => entry.seq)).toEqual([2, 3]);

    entries[0]!.event = "mutated";
    expect(diagnostics.snapshot()[0]!.event).toBe("remote-b");
  });

  it("snapshot 支持 since 与 limit，且不超过容量", () => {
    const diagnostics = createHostDiagnostics({ capacity: 10 });
    for (let index = 0; index < 8; index += 1) diagnostics.record(remote(`remote-${index}`));

    expect(diagnostics.snapshot({ since: 6 }).map((entry) => entry.seq)).toEqual([7, 8]);
    expect(diagnostics.snapshot({ limit: 3 }).map((entry) => entry.seq)).toEqual([6, 7, 8]);
    expect(diagnostics.snapshot({ limit: 99_999 })).toHaveLength(8);
    expect(diagnostics.capacity).toBe(10);
  });

  it("缺省容量是固定上限，不会无界增长", () => {
    const diagnostics = createHostDiagnostics();
    expect(diagnostics.capacity).toBe(MAX_DIAGNOSTIC_ENTRIES);
  });
});
