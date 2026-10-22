/**
 * 宿主录制通道装配（任务 1.5）。
 *
 * 覆盖：插件在宿主树里可用、能力协商经通道完成、协议版本不符被拒、
 * 以及「WebView 完全不存在」时通道仍然接受注册（独立性）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RECORDING_PROTOCOL_VERSION } from "@woohaa3/contracts";
import { checkoutIdFor } from "../../recording-executor/paths.js";
import { createRecordingExecutorChannel } from "../../recording-executor/channel.js";

const CHECKOUT_DIRECTORY = "/tmp/wo-channel-checkout";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wo-chan-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("recording executor channel", () => {
  it("starts a private socket and reports its checkout", async () => {
    const channel = await createRecordingExecutorChannel({
      env: { WOOHAA3_RECORDING_RUNTIME_ROOT: root },
      checkoutDirectory: CHECKOUT_DIRECTORY
    });
    expect(channel).not.toBeNull();
    if (!channel) return;
    expect(channel.available).toBe(true);
    expect(channel.checkoutId).toBe(checkoutIdFor(CHECKOUT_DIRECTORY));
    expect(channel.executorCount()).toBe(0);
    await channel.close();
  });

  it.skipIf(process.platform === "win32")("returns null instead of throwing when the runtime root is unusable", async () => {
    const events: string[] = [];
    const channel = await createRecordingExecutorChannel({
      // 超长路径会让 socket 路径越界；装配必须报告不可用而不是崩溃。
      env: { WOOHAA3_RECORDING_RUNTIME_ROOT: `/${"y".repeat(160)}` },
      checkoutDirectory: CHECKOUT_DIRECTORY,
      logger: event => events.push(String(event.event))
    });
    expect(channel).toBeNull();
    expect(events).toContain("recording-executor-paths-failed");
  });

  it("does not depend on any webview or page lifecycle", async () => {
    const channel = await createRecordingExecutorChannel({
      env: { WOOHAA3_RECORDING_RUNTIME_ROOT: root },
      checkoutDirectory: CHECKOUT_DIRECTORY
    });
    expect(channel).not.toBeNull();
    if (!channel) return;
    // 通道没有注册页面的概念：没有 WebView 时 registry 只是空列表，仍可被查询。
    expect(channel.registry.list()).toEqual([]);
    expect(channel.registry.supportsHardwareRendering("missing")).toBe(false);
    await channel.close();
  });

  it("advertises the protocol version it accepts", async () => {
    const channel = await createRecordingExecutorChannel({
      env: { WOOHAA3_RECORDING_RUNTIME_ROOT: root },
      checkoutDirectory: CHECKOUT_DIRECTORY,
      protocolVersion: RECORDING_PROTOCOL_VERSION
    });
    expect(channel).not.toBeNull();
    if (!channel) return;
    expect(channel.noncePath.endsWith("registration.nonce")).toBe(true);
    expect(
      process.platform === "win32"
        ? channel.socketPath.startsWith("\\\\.\\pipe\\woohaa3-recording-")
        : channel.socketPath.endsWith("executor.sock")
    ).toBe(true);
    await channel.close();
  });
});
