import { afterEach, expect, it, vi } from "vitest";
import {
  offersDeveloperChannel,
  readUpdateChannel,
  writeUpdateChannel
} from "./update-channel.js";

afterEach(() => vi.unstubAllGlobals());

it("浏览器里没有桌面能力时直接拒绝，不发请求", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(readUpdateChannel()).rejects.toThrow("更新通道仅支持桌面版");
  expect(fetch).not.toHaveBeenCalled();
});

it("读通道携带宿主令牌；写通道提交通道名", async () => {
  vi.stubGlobal("__WOOHAA_DESKTOP__", { protocol: "woohaa-window-v1", token: "channel-test" });
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    ok: true,
    value: { channel: "stable", pendingRollback: false, available: ["stable", "alpha"] }
  })));
  vi.stubGlobal("fetch", fetch);

  await expect(readUpdateChannel()).resolves.toMatchObject({ channel: "stable" });
  expect(fetch).toHaveBeenLastCalledWith("woohaa-native://localhost/update-channel", expect.objectContaining({
    method: "GET",
    headers: { "Content-Type": "application/json", "X-Woohaa-Token": "channel-test" }
  }));

  await expect(writeUpdateChannel("alpha")).resolves.toMatchObject({ channel: "stable" });
  expect(fetch).toHaveBeenLastCalledWith("woohaa-native://localhost/update-channel", expect.objectContaining({
    method: "POST",
    body: '{"channel":"alpha"}'
  }));
});

it("失败回包抛出宿主给的原因，不伪造成功状态", async () => {
  vi.stubGlobal("__WOOHAA_DESKTOP__", { protocol: "woohaa-window-v1", token: "channel-test" });
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    ok: false,
    error: "本安装包不提供 alpha 通道"
  })));
  vi.stubGlobal("fetch", fetch);
  await expect(writeUpdateChannel("alpha")).rejects.toThrow("本安装包不提供 alpha 通道");
});

it("只有可用集合含 alpha 时才认为提供开发者通道", () => {
  expect(offersDeveloperChannel({ channel: "stable", pendingRollback: false, available: ["stable"] })).toBe(false);
  expect(offersDeveloperChannel({ channel: "stable", pendingRollback: false, available: ["stable", "alpha"] })).toBe(true);
});
