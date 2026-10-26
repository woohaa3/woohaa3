import { describe, expect, it } from "vitest";
import { createSiteGate, type SiteGateHandle } from "./site-gate.js";

function handle(log: string[]): SiteGateHandle {
  return {
    acquire: async () => void log.push("acquire"),
    release: async () => void log.push("release"),
    health: () => ({ state: "degraded", diagnostics: [{ code: "x", message: "y" }] })
  };
}

describe("siteGate 运行期 add / remove", () => {
  it("add 后 managed 为真；attach 后 activate 启动、dispose 释放；重复 add 返回同一定义", async () => {
    const gate = createSiteGate([]);
    expect(gate.managed("late")).toBe(false);
    const definition = gate.add("late");
    expect(gate.add("late")).toBe(definition);
    expect(gate.managed("late")).toBe(true);
    expect(gate.definitions).toEqual([]);
    const log: string[] = [];
    const activation = definition.activate({} as never);
    gate.attach("late", handle(log));
    const active = await activation;
    expect(log).toEqual(["acquire"]);
    expect(definition.health?.()).toMatchObject({ state: "degraded" });
    await active?.dispose?.();
    expect(log).toEqual(["acquire", "release"]);
  });

  it("remove：等待中的 activate 与之后的 activate 都以 extension-unavailable 拒绝；managed 变假；未登记 remove 为 no-op", async () => {
    const gate = createSiteGate(["boot"]);
    const definition = gate.add("late");
    const waiting = definition.activate({} as never);
    gate.remove("late");
    await expect(waiting).rejects.toMatchObject({ code: "extension-unavailable" });
    await expect(definition.activate({} as never)).rejects.toMatchObject({ code: "extension-unavailable" });
    expect(definition.health?.()).toBeUndefined();
    expect(gate.managed("late")).toBe(false);
    gate.remove("nope");
    // 重新 add 得到新的定义，可以正常激活（卸载后重装）。
    const again = gate.add("late");
    expect(again).not.toBe(definition);
    const log: string[] = [];
    gate.attach("late", handle(log));
    await again.activate({} as never);
    expect(log).toEqual(["acquire"]);
    // 启动期定义不受影响。
    expect(gate.definitions.map((entry) => entry.extensionId)).toEqual(["boot"]);
  });

  it("未被等待的 remove 不产生未处理拒绝", async () => {
    const gate = createSiteGate([]);
    gate.add("x");
    gate.remove("x");
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
