import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BOOT_FAILURE_MESSAGE_MAX,
  beginBoot,
  bootFailureFromLog,
  formatBootFailure,
  markReady,
  markRestartRequested,
  readBootState,
  recordBootFailure,
  sanitizeBootFailureMessage
} from "./boot-state.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function stateFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-boot-"));
  dirs.push(dir);
  return path.join(dir, "host", "boot-state.json");
}

describe("启动守卫（D7）", () => {
  it("就绪后清零；连续 3 次未就绪后第 4 次进入安全模式", () => {
    const file = stateFile();
    const first = beginBoot({ file, env: {} });
    expect(first).toMatchObject({ attempts: 1, safeMode: null });
    markReady(file);
    expect(readBootState(file).attempts).toBe(0);

    for (let i = 1; i <= 3; i += 1) expect(beginBoot({ file, env: {} }).safeMode).toBeNull();
    const fourth = beginBoot({ file, env: {} });
    expect(fourth.safeMode?.reason).toBe("boot-failures");
    // 就绪不退出安全模式：要管理员显式退出。
    markReady(file);
    expect(beginBoot({ file, env: {} }).safeMode?.reason).toBe("boot-failures");
  });

  it("受控重启不计数；exitSafeMode 清除安全模式与计数", () => {
    const file = stateFile();
    for (let i = 0; i < 4; i += 1) beginBoot({ file, env: {} });
    expect(readBootState(file).safeMode).toBeDefined();
    markRestartRequested(file, { reason: "test" });
    const restarted = beginBoot({ file, env: {} });
    expect(restarted.restarted).toBe(true);
    expect(restarted.attempts).toBe(4);
    expect(readBootState(file).restartRequested).toBeUndefined();

    markRestartRequested(file, { reason: "exit", exitSafeMode: true });
    const after = beginBoot({ file, env: {} });
    expect(after.safeMode).toBeNull();
    expect(after.attempts).toBe(0);
  });

  it("状态文件损坏按零次处理并告警，不误入安全模式", () => {
    const file = stateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    const events: Array<Record<string, unknown>> = [];
    const decision = beginBoot({ file, env: { WOOHAA3_SAFE_MODE_AFTER: "1" }, log: (event) => events.push(event) });
    expect(decision).toMatchObject({ attempts: 1, safeMode: null });
    expect(events.some((event) => event.event === "boot-state-corrupt")).toBe(true);
  });

  it("WOOHAA3_SAFE_MODE 强制进入与强制关闭；阈值可配置", () => {
    const file = stateFile();
    expect(beginBoot({ file, env: { WOOHAA3_SAFE_MODE: "1" } }).safeMode?.reason).toBe("forced");
    expect(beginBoot({ file, env: { WOOHAA3_SAFE_MODE: "0" } }).safeMode).toBeNull();
    markReady(file);
    beginBoot({ file, env: { WOOHAA3_SAFE_MODE_AFTER: "1" } });
    expect(beginBoot({ file, env: { WOOHAA3_SAFE_MODE_AFTER: "1" } }).safeMode?.reason).toBe("boot-failures");
  });

  it("就绪前的扩展启动失败写入摘要，安全模式启动时带出；正常就绪后清除", () => {
    const file = stateFile();
    beginBoot({ file, env: {} });
    recordBootFailure(file, { extensionId: "slow-provider", code: "activation-timeout", message: "插件激活超过 30000ms 仍未完成" });
    // 正常启动就绪：摘要清除。
    markReady(file);
    expect(readBootState(file).lastFailure).toBeUndefined();

    for (let i = 0; i < 3; i += 1) {
      beginBoot({ file, env: {} });
      recordBootFailure(file, { extensionId: `ext-${i}`, code: "activation-failed", message: "boom" });
    }
    const safe = beginBoot({ file, env: {} });
    expect(safe.safeMode?.reason).toBe("boot-failures");
    // 最近一次失败覆盖前面的。
    expect(safe.lastFailure).toMatchObject({ extensionId: "ext-2", code: "activation-failed", message: "boom" });
    expect(formatBootFailure(safe.lastFailure!)).toBe("ext-2：[activation-failed] boom");
    // 安全模式就绪：摘要随安全模式保留；退出安全模式时清除。
    markReady(file);
    expect(readBootState(file).lastFailure?.extensionId).toBe("ext-2");
    markRestartRequested(file, { reason: "exit", exitSafeMode: true });
    expect(readBootState(file).lastFailure).toBeUndefined();
  });

  it("安全消息：去掉路径与凭据，压成单行并截断到 200 字", () => {
    const message = sanitizeBootFailureMessage(
      "连接失败 /srv/woohaa/shared/config/secret.yml\napiKey=sk-abc Bearer eyJhbGciOi token: t0k " + "x".repeat(10) + " " + "a".repeat(40)
    );
    expect(message).not.toMatch(/\/srv|sk-abc|eyJhbGciOi|t0k|a{40}/);
    expect(message).toContain("<path>");
    expect(message).toContain("<redacted>");
    expect(message).not.toContain("\n");
    expect(sanitizeBootFailureMessage("长".repeat(500)).length).toBe(BOOT_FAILURE_MESSAGE_MAX);
  });

  it("只从扩展启动失败事件取摘要，且只取 extensionId / code / message", () => {
    expect(bootFailureFromLog({ event: "extension-start-failed", extension: "p", code: "activation-timeout", message: "m", values: { apiKey: "x" } })).toEqual({
      extensionId: "p",
      code: "activation-timeout",
      message: "m"
    });
    expect(bootFailureFromLog({ event: "site-extension-activation-failed", extensionId: "s", message: "m" })).toEqual({
      extensionId: "s",
      code: "activation-failed",
      message: "m"
    });
    expect(bootFailureFromLog({ event: "extension-activated", extensionId: "s" })).toBeNull();
    expect(bootFailureFromLog({ event: "extension-start-failed", message: "无身份" })).toBeNull();
  });

  it("损坏的 lastFailure 字段被忽略，不影响计数", () => {
    const file = stateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ attempts: 1, lastFailure: { extensionId: 1 } }));
    const state = readBootState(file);
    expect(state.attempts).toBe(1);
    expect(state.lastFailure).toBeUndefined();
  });
});
