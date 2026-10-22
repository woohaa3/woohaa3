/**
 * 最小 extension 前端能力验收
 * （change: 2026-10-10-unify-extension-frontend-entry，任务 2.3 / design D1/D6）。
 *
 * 在独立 fake Context 验证扩展作者仅用自己的包即可：
 * - 注入平台依赖（slot registry）并提供业务 Service；
 * - 贡献类型化 UI（slot）；
 * - 注册可释放副作用（effect）；
 * - 依赖就绪前不激活，dispose 后零残留。
 */
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { defineExtensionFrontend, defineExtensionPlugin } from "./index.js";
import { SlotRegistry } from "../cordis/slots.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const MESSAGE = (label: string) => label;

describe("extension 公共前端 API 能力（任务 2.3）", () => {
  it("入口工厂无副作用；装配后注入依赖、提供 Service、贡献 UI，dispose 后零残留", async () => {
    const ctx = new Context();
    const slots = new SlotRegistry();
    ctx.provide("slots" as never, slots as never);

    let applied = 0;
    const effects: string[] = [];
    const descriptor = defineExtensionFrontend({
      extensionId: "demo",
      activation: "server-active",
      plugin: () =>
        defineExtensionPlugin(
          (scope: Context & { slots: SlotRegistry }) => {
            applied += 1;
            scope.provide("business" as never, { hello: () => "world" } as never);
            const remove = scope.slots.register("authoring.generate", {
              id: "demo-generate",
              owner: "demo",
              render: () => MESSAGE("demo")
            });
            scope.effect(() => () => {
              effects.push("ui");
              remove();
            });
          },
          { name: "demo", inject: ["slots"], provide: "business" }
        )
    });

    // 工厂未调用前无副作用。
    expect(applied).toBe(0);

    // 宿主装配：无副作用工厂 + 当前 scope 注入。
    const fiber = ctx.plugin(descriptor.plugin()) as import("@deepseek-ai/cordis").Fiber;
    await fiber.await();
    expect(applied).toBe(1);
    expect(ctx.get("business" as never)).toBeTruthy();
    expect(slots.list("authoring.generate")).toHaveLength(1);

    await fiber.dispose();
    expect(slots.list("authoring.generate")).toHaveLength(0);
    expect(effects).toEqual(["ui"]);
  });

  it("必需依赖缺失时保持未激活且无部分副作用；提供后激活", async () => {
    const ctx = new Context();
    const slots = new SlotRegistry();
    ctx.provide("slots" as never, slots as never);

    const log: string[] = [];
    const plugin = defineExtensionPlugin(
      (scope: Context) => {
        log.push("apply");
        scope.effect(() => () => log.push("dispose"));
      },
      { name: "needs-remote", inject: ["slots", "applicationRemote"] }
    );
    const fiber = ctx.plugin(plugin) as import("@deepseek-ai/cordis").Fiber;
    await flush();
    expect(log).toEqual([]);

    ctx.provide("applicationRemote" as never, {} as never);
    await fiber.await();
    expect(log).toEqual(["apply"]);
    await fiber.dispose();
    expect(log).toEqual(["apply", "dispose"]);
  });
});
