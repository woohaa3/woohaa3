/**
 * 装配期服务访问守护的回归：这条机制的价值全在"能抓到人"。
 *
 * 覆盖三件事：① 装配期读了"稍后才被提供"的服务 → 启动结算时报错；② 读了一个始终不存在的
 * 服务（可选能力 / 测试脚手架没装）→ 不报；③ 装配结束后的读取 → 不算装配错误。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { markServiceAccessGuardScope, reportLateServiceReads, withApplyGuard } from "./service-access-guard.js";
import { definePlugin } from "./plugin.js";
import { startFrontendRuntime } from "./kernel.js";

describe("装配期服务访问守护", () => {
  it("装配期读了稍后才提供的服务：结算后报错并指名服务", () => {
    const { ctx, guard } = markServiceAccessGuardScope(new Context());
    withApplyGuard(ctx, "consumer", (scoped) => {
      scoped.get("lateThing" as never);
    });
    ctx.provide("lateThing" as never, { ok: true } as never);
    expect(() => reportLateServiceReads(guard, ctx)).toThrow(/lateThing/);
  });

  it("读了一个始终不存在的服务：不报（可选能力不算装配错误）", () => {
    const { ctx, guard } = markServiceAccessGuardScope(new Context());
    withApplyGuard(ctx, "consumer", (scoped) => {
      scoped.get("optionalThing" as never);
    });
    expect(() => reportLateServiceReads(guard, ctx)).not.toThrow();
  });

  it("装配结束后的读取不记录：闭包里的惰性读是合法的", () => {
    const { ctx, guard } = markServiceAccessGuardScope(new Context());
    let captured: Context | null = null;
    withApplyGuard(ctx, "consumer", (scoped) => {
      captured = scoped;
    });
    ctx.provide("laterThing" as never, { ok: true } as never);
    captured!.get("laterThing" as never);
    expect(guard.misses).toHaveLength(0);
  });

  it("经 definePlugin 接入真实启动路径：required 插件装配期读晚到服务会让启动失败", async () => {
    const provider = definePlugin(
      (ctx: Context) => {
        ctx.provide("lateThing" as never, { ok: true } as never);
      },
      { name: "provider", inject: [] }
    );
    const consumer = definePlugin(
      (ctx: Context) => {
        // 故意保留装配期快照写法：守护必须把它抓出来。
        ctx.get("lateThing" as never);
      },
      { name: "consumer", inject: [] }
    );

    await expect(
      startFrontendRuntime({
        installPlatform: () => undefined,
        plugins: [
          { id: "provider", required: true, plugin: provider },
          { id: "consumer", required: true, plugin: consumer }
        ]
      })
    ).rejects.toThrow(/lateThing/);
  });
});
