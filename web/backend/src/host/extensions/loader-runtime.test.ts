/**
 * 扩展层运行期追加 / 卸载（change: 2026-10-21-isolate-extension-host-process，任务 8.4）。
 *
 * 与启动期同一条 `loadExtension` 路径：配置段登记、站点门禁 attach、serial 队列；同名拒绝；disposeAll 覆盖运行期追加的插件。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { defineConfigSchema, type HostExtensionPlugin } from "@woohaa3/contracts";
import { createSettingsService } from "../../settings/settings-service.js";
import { loadBaseLayer } from "../base/index.js";
import type { HostContext } from "../context.js";
import { createSiteGate } from "../core/site-gate.js";
import { loadExtensionLayer } from "./loader.js";

const CONFIG = defineConfigSchema({
  greeting: { kind: "string", label: "问候", description: "d", reload: "hot", default: "hi" }
});

function plugin(name: string, events: string[]): HostExtensionPlugin<typeof CONFIG.fields> {
  return {
    name,
    label: name,
    configPrefix: `providers.${name}`,
    inject: [],
    Config: CONFIG,
    apply(ctx, config) {
      events.push(`start:${name}:${config.greeting}`);
      ctx.effect(() => () => events.push(`stop:${name}`));
    }
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(config = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-loader-runtime-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, "woohaa.config.yml");
  fs.writeFileSync(configFile, config);
  const settings = await createSettingsService({ configFile, secretsFile: path.join(dir, "s.yml"), env: {}, watch: false });
  cleanups.push(() => settings.close());
  const ctx = new Context() as HostContext;
  const base = await loadBaseLayer(ctx, { env: {}, sink: () => undefined, settings });
  cleanups.push(async () => {
    for (const fiber of base.reverse()) await fiber.dispose();
  });
  return { ctx, settings };
}

describe("扩展层运行期追加（任务 8.4）", () => {
  it("add：登记配置段与插件清单并按配置启动；remove：停 fiber、撤登记；可再次 add", async () => {
    const { ctx, settings } = await setup("providers:\n  late:\n    greeting: hello\n");
    const events: string[] = [];
    const layer = await loadExtensionLayer(ctx, [plugin("early", events)]);
    cleanups.push(() => layer.disposeAll());
    await layer.settled;
    const added = layer.add(plugin("late", events));
    await added!.started;
    expect(events).toEqual(["start:early:hi", "start:late:hello"]);
    expect(layer.has("late")).toBe(true);
    expect(settings.plugins().map((entry) => entry.id)).toContain("late");
    await layer.remove("late");
    expect(events).toContain("stop:late");
    expect(layer.has("late")).toBe(false);
    expect(settings.plugins().map((entry) => entry.id)).not.toContain("late");
    const again = layer.add(plugin("late", events));
    await again!.started;
    expect(events.filter((event) => event === "start:late:hello")).toHaveLength(2);
  });

  it("同名插件已装载：add 抛 extension-exists，原插件不受影响", async () => {
    const { ctx } = await setup();
    const events: string[] = [];
    const layer = await loadExtensionLayer(ctx, [plugin("early", events)]);
    cleanups.push(() => layer.disposeAll());
    await layer.settled;
    expect(() => layer.add(plugin("early", events))).toThrow(expect.objectContaining({ code: "extension-exists" }));
    expect(events).toEqual(["start:early:hi"]);
  });

  it("运行期新登记到站点门禁的插件走 gated 分支：装载不启动，等控制面 activate", async () => {
    const { ctx } = await setup();
    const siteGate = createSiteGate([]);
    ctx.provide("application", { siteGate } as never);
    const events: string[] = [];
    const layer = await loadExtensionLayer(ctx, []);
    cleanups.push(() => layer.disposeAll());
    const definition = siteGate.add("gated");
    layer.add(plugin("gated", events));
    expect(events).toEqual([]);
    const activation = await definition.activate({} as never);
    expect(events).toEqual(["start:gated:hi"]);
    await activation?.dispose?.();
    expect(events).toEqual(["start:gated:hi", "stop:gated"]);
  });

  it("disposeAll 卸载启动期与运行期追加的全部插件；remove 未装载的名字是 no-op", async () => {
    const { ctx } = await setup();
    const events: string[] = [];
    const layer = await loadExtensionLayer(ctx, [plugin("early", events)]);
    await layer.settled;
    await layer.add(plugin("late", events))!.started;
    await layer.remove("missing");
    await layer.disposeAll();
    expect(events.filter((event) => event.startsWith("stop:")).sort()).toEqual(["stop:early", "stop:late"]);
    expect(layer.has("early")).toBe(false);
  });
});