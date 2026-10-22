/**
 * 配置写入后刷新运行时状态（`withRuntimeStateRefresh`）。
 *
 * 站点插件状态是 revision 有界的增量拉取，配置写入不推进它的 revision；Provider 补上 API Key 这类
 * 写入要让界面从「降级运行 / 不可执行」回到「运行中 / 可执行」，只能靠写入成功后主动重取。
 */
import { describe, expect, it } from "vitest";
import { withRuntimeStateRefresh, type BackendSettingsRemote } from "./backend-settings-store.js";

const snapshot = { settings: [], plugins: [] };

function remote(result: Awaited<ReturnType<BackendSettingsRemote["write"]>>): BackendSettingsRemote {
  return {
    fetchSnapshot: async () => ({ ok: true, snapshot: snapshot as never }),
    write: async () => result
  };
}

describe("withRuntimeStateRefresh", () => {
  it("写入成功后刷新全部运行时状态", async () => {
    const calls: string[] = [];
    const wrapped = withRuntimeStateRefresh(remote({ ok: true, snapshot: snapshot as never }), [
      async () => {
        calls.push("status");
      },
      async () => {
        calls.push("models");
      }
    ]);
    const result = await wrapped.write({ "providers.runninghub.apiKey": "k" });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["status", "models"]);
  });

  it("写入失败不刷新（配置没落地，状态不会变）", async () => {
    const calls: string[] = [];
    const wrapped = withRuntimeStateRefresh(remote({ ok: false, code: "unauthorized", error: "拒绝" }), [
      async () => {
        calls.push("status");
      }
    ]);
    const result = await wrapped.write({ x: 1 });
    expect(result).toEqual({ ok: false, code: "unauthorized", error: "拒绝" });
    expect(calls).toEqual([]);
  });

  it("刷新失败不影响写入结果", async () => {
    const wrapped = withRuntimeStateRefresh(remote({ ok: true, snapshot: snapshot as never }), [
      async () => {
        throw new Error("刷新失败");
      }
    ]);
    const result = await wrapped.write({ x: 1 });
    expect(result.ok).toBe(true);
  });

  it("读快照直接透传", async () => {
    const wrapped = withRuntimeStateRefresh(remote({ ok: true, snapshot: snapshot as never }), []);
    expect(await wrapped.fetchSnapshot()).toEqual({ ok: true, snapshot });
  });
});
