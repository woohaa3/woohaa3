/**
 * 上游凭据解析测试：远端接入只有插件提供的动态来源，没有静态配置回落。
 *
 * 动态来源按**画布**回答：同一份来源对「已在远端」的画布返回链路、对普通本地画布返回
 * null（登录不等于上传）。这里用不同的 canvasId 验证调用方把目标传了进去。
 *
 * 静态 `canvas.syncUpstream.*` 已移除：绕过插件全局配置中继会让「逐画布显式启用」失效，
 * 因此「没有来源 / 来源拒绝 / 来源故障」都必须回到纯本地，而不是偷偷连到另一个地址。
 */
import { describe, expect, it, vi } from "vitest";
import { resolveUpstreamConfig } from "./relay-upstream.js";

describe("上游配置解析", () => {
  it("没有动态来源时保持纯本地（undefined 与 null 同语义）", async () => {
    await expect(resolveUpstreamConfig(null, "canvas-a")).resolves.toBeNull();
    await expect(resolveUpstreamConfig(undefined, "canvas-a")).resolves.toBeNull();
  });

  it("动态来源给出会话时使用它，并把 canvasId 传给来源", async () => {
    const resolve = vi.fn(async () => ({ url: "wss://session.example.com", token: "session-token" }));
    await expect(resolveUpstreamConfig({ resolve }, "canvas-a")).resolves.toEqual({
      url: "wss://session.example.com",
      token: "session-token"
    });
    expect(resolve).toHaveBeenCalledWith("canvas-a");
  });

  it("动态来源返回 null（未登录 / 这张画布未启用同步）时保持本地", async () => {
    const dynamic = { resolve: async () => null };
    await expect(resolveUpstreamConfig(dynamic, "canvas-a")).resolves.toBeNull();
  });

  it("动态来源抛错时不阻塞画布，回到本地", async () => {
    const dynamic = {
      resolve: async () => {
        throw new Error("扩展故障");
      }
    };
    await expect(resolveUpstreamConfig(dynamic, "canvas-a")).resolves.toBeNull();
  });

  it("动态来源给空值时不接管（避免把同步指向不完整配置）", async () => {
    await expect(resolveUpstreamConfig({ resolve: async () => ({ url: "", token: "t" }) }, "canvas-a")).resolves.toBeNull();
    await expect(resolveUpstreamConfig({ resolve: async () => ({ url: "wss://x", token: "" }) }, "canvas-a")).resolves.toBeNull();
  });

  it("来源每次调用都重新求值（登录/启用状态变化后不必重建 room）", async () => {
    const resolve = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ url: "wss://session.example.com", token: "t" });
    const dynamic = { resolve };
    await expect(resolveUpstreamConfig(dynamic, "canvas-a")).resolves.toBeNull();
    await expect(resolveUpstreamConfig(dynamic, "canvas-a")).resolves.toMatchObject({ url: "wss://session.example.com" });
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
