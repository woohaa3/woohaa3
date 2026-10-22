/**
 * 主插件装配回归：运行中的扩展必须自己提供设置面板与调试窗口。
 *
 * 这条用例锁的是一个真实故障：设置面板一度只注册在 `settingsPlugin()`（设置专用工厂）里，
 * 而宿主对**正在运行**的扩展直接复用已有贡献、不会调用那个工厂。结果是插件卡片显示
 * 「无可配置项」、详情页空白——正常状态反而看不到配置。
 *
 * 所以这里在真实 Cordis Context 上跑主插件，断言 `settings.plugin-config` 确实被注册，
 * 以及「服务端日志」窗口（dialog）也被注册、可打开、随插件释放而注销。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { Context, type Fiber } from "@deepseek-ai/cordis";
import type { SlotsService } from "@woohaa3/frontend/extension-api";
import { remoteServerExtension, remoteServerSettingsExtension } from "../src/frontend/index.js";
import { REMOTE_SERVER_COLLABORATORS_DIALOG_ID } from "../src/frontend/collaborators-dialog.js";
import { REMOTE_SERVER_DEBUG_DIALOG_ID } from "../src/frontend/debug-dialog.js";
import { REMOTE_SERVER_EXTENSION_ID } from "../src/shared.js";
import { DialogService } from "../../../frontend/src/cordis/services/dialogs/service.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  document.body.innerHTML = "";
});

type Registered = { id: string; owner?: string; pluginId?: string };

/** 最小 slots 替身：只记录注册，不渲染。 */
function fakeSlots(): { service: SlotsService; registered: Map<string, Registered[]> } {
  const registered = new Map<string, Registered[]>();
  const service = {
    register(slot: string, entry: Registered) {
      const list = registered.get(slot) ?? [];
      list.push(entry);
      registered.set(slot, list);
      return () => {
        const current = registered.get(slot) ?? [];
        registered.set(slot, current.filter((item) => item !== entry));
      };
    },
    list: () => [],
    subscribe: () => () => undefined,
    version: () => 0,
    owners: () => []
  } as unknown as SlotsService;
  return { service, registered };
}

const unavailableTransport = {
  request: async () => ({ ok: false as const, code: "unavailable" as const, error: "未配置" })
};

function boot(): {
  ctx: Context;
  fiber: Fiber;
  registered: Map<string, Registered[]>;
  dialogs: DialogService;
} {
  const ctx = new Context();
  const { service, registered } = fakeSlots();
  const dialogs = new DialogService();
  ctx.provide("slots" as never, service as never);
  ctx.provide("dialogs" as never, dialogs as never);
  ctx.provide("applicationRemote" as never, { transport: unavailableTransport } as never);
  const fiber = ctx.plugin(remoteServerExtension() as never, {} as never) as unknown as Fiber;
  return { ctx, fiber, registered, dialogs };
}

describe("remote-server 主插件", () => {
  it("运行中（主插件装配）就注册了设置面板：卡片不再是「无可配置项」", async () => {
    const { ctx, fiber, registered } = boot();
    disposers.push(() => ctx.fiber.dispose());
    await fiber.await();

    const panels = registered.get("settings.plugin-config") ?? [];
    expect(panels).toHaveLength(1);
    // pluginId 必须与站点目录的 extensionId 一致，否则设置里认不到归属。
    expect(panels[0]?.pluginId).toBe(REMOTE_SERVER_EXTENSION_ID);
    expect(panels[0]?.owner).toBe(REMOTE_SERVER_EXTENSION_ID);
  });

  it("运行中注册画布目录条目动作，插件释放后一并注销", async () => {
    const { ctx, fiber, registered } = boot();
    disposers.push(() => ctx.fiber.dispose());
    await fiber.await();

    const actions = registered.get("canvas.catalog-item-action") ?? [];
    // 两个动作互斥：仅本机画布渲染「同步远端」，已在远端的画布渲染「协作」。
    expect(actions).toHaveLength(2);
    // 同一 slot 内 id 必须稳定且只注册一次，否则宿主启动会因重复 ID 失败。
    expect(actions[0]?.id).toBe(`${REMOTE_SERVER_EXTENSION_ID}-catalog-sync`);
    expect(actions[0]?.owner).toBe(REMOTE_SERVER_EXTENSION_ID);
    expect(actions[1]?.id).toBe(`${REMOTE_SERVER_EXTENSION_ID}-collaborators`);
    expect(actions[1]?.owner).toBe(REMOTE_SERVER_EXTENSION_ID);

    await ctx.fiber.dispose();
    expect(registered.get("canvas.catalog-item-action") ?? []).toHaveLength(0);
  });

  it("运行中注册「服务端接入日志」dialog，且可打开、可解析渲染器", async () => {
    const { ctx, fiber, dialogs } = boot();
    disposers.push(() => ctx.fiber.dispose());
    await fiber.await();

    expect(dialogs.registeredDialogIds()).toContain(REMOTE_SERVER_DEBUG_DIALOG_ID);
    expect(dialogs.resolveRenderer(REMOTE_SERVER_DEBUG_DIALOG_ID)).not.toBeNull();

    const opened = dialogs.open({ dialogId: REMOTE_SERVER_DEBUG_DIALOG_ID, payload: {} });
    expect(opened.ok).toBe(true);
    expect(dialogs.top()?.dialogId).toBe(REMOTE_SERVER_DEBUG_DIALOG_ID);
  });

  it("运行中注册「协作」dialog：payload 校验生效，可打开，随插件释放注销", async () => {
    const { ctx, fiber, dialogs } = boot();
    disposers.push(() => ctx.fiber.dispose());
    await fiber.await();

    expect(dialogs.registeredDialogIds()).toContain(REMOTE_SERVER_COLLABORATORS_DIALOG_ID);
    expect(dialogs.resolveRenderer(REMOTE_SERVER_COLLABORATORS_DIALOG_ID)).not.toBeNull();
    // 没有画布身份就没有协作对象：缺 canvasId 的 payload 必须被拒。
    expect(dialogs.open({ dialogId: REMOTE_SERVER_COLLABORATORS_DIALOG_ID, payload: {} }).ok).toBe(false);
    expect(
      dialogs.open({
        dialogId: REMOTE_SERVER_COLLABORATORS_DIALOG_ID,
        payload: { canvasId: "canvas-1", title: "画布一" }
      }).ok
    ).toBe(true);
    expect(dialogs.top()?.dialogId).toBe(REMOTE_SERVER_COLLABORATORS_DIALOG_ID);

    await ctx.fiber.dispose();
    expect(dialogs.registeredDialogIds()).not.toContain(REMOTE_SERVER_COLLABORATORS_DIALOG_ID);
  });

  it("插件释放后 dialog 一并注销（不留注册残留）", async () => {
    const { ctx, fiber, dialogs } = boot();
    disposers.push(() => ctx.fiber.dispose());
    await fiber.await();
    expect(dialogs.registeredDialogIds()).toContain(REMOTE_SERVER_DEBUG_DIALOG_ID);

    await ctx.fiber.dispose();
    expect(dialogs.registeredDialogIds()).not.toContain(REMOTE_SERVER_DEBUG_DIALOG_ID);
    expect(dialogs.resolveRenderer(REMOTE_SERVER_DEBUG_DIALOG_ID)).toBeNull();
  });

  it("设置专用工厂用同一个 slot id 与 pluginId（两处不能漂移）", async () => {
    const ctx = new Context();
    const { service, registered } = fakeSlots();
    ctx.provide("slots" as never, service as never);
    ctx.provide("applicationRemote" as never, { transport: unavailableTransport } as never);
    const fiber = ctx.plugin(remoteServerSettingsExtension() as never, {} as never) as unknown as Fiber;
    disposers.push(() => ctx.fiber.dispose());
    await fiber.await();

    const panels = registered.get("settings.plugin-config") ?? [];
    expect(panels).toHaveLength(1);
    expect(panels[0]?.id).toBe(`${REMOTE_SERVER_EXTENSION_ID}-settings-panel`);
    expect(panels[0]?.pluginId).toBe(REMOTE_SERVER_EXTENSION_ID);
  });

  it("设置专用装配在宿主提供 dialogs 时也注册窗口（扩展未运行时按钮要能打开）", async () => {
    const ctx = new Context();
    const { service, registered } = fakeSlots();
    const dialogs = new DialogService();
    ctx.provide("slots" as never, service as never);
    ctx.provide("dialogs" as never, dialogs as never);
    ctx.provide("applicationRemote" as never, { transport: unavailableTransport } as never);
    const fiber = ctx.plugin(remoteServerSettingsExtension() as never, {} as never) as unknown as Fiber;
    disposers.push(() => ctx.fiber.dispose());
    await fiber.await();

    expect(registered.get("settings.plugin-config")).toHaveLength(1);
    expect(dialogs.registeredDialogIds()).toContain(REMOTE_SERVER_DEBUG_DIALOG_ID);
    expect(dialogs.open({ dialogId: REMOTE_SERVER_DEBUG_DIALOG_ID, payload: {} }).ok).toBe(true);
  });

  it("宿主没有 dialogs 时设置专用装配仍成立（入口退化为不渲染）", async () => {
    const ctx = new Context();
    const { service, registered } = fakeSlots();
    ctx.provide("slots" as never, service as never);
    ctx.provide("applicationRemote" as never, { transport: unavailableTransport } as never);
    const fiber = ctx.plugin(remoteServerSettingsExtension() as never, {} as never) as unknown as Fiber;
    disposers.push(() => ctx.fiber.dispose());
    await fiber.await();

    // 面板照常注册；只是没有窗口可开（不注入 dialogs 也不会让装配失败）。
    expect(registered.get("settings.plugin-config")).toHaveLength(1);
  });
});
