/**
 * ModelInteractionService 行为测试
 * （change: 2026-09-29-add-pluggable-model-interactions，任务 3.2 / design D3）。
 */
import { describe, expect, it } from "vitest";
import { ModelInteractionService } from "./model-interaction-service.js";
import type { ModelPanelProps } from "../contract/model-interaction.js";

function panel(): React.ComponentType<ModelPanelProps> {
  return () => null;
}

function definition(id: string, version: number, owner: string) {
  return { id, version, owner, Panel: panel() };
}

describe("ModelInteractionService", () => {
  it("精确 id+version 解析，不隐式替代", () => {
    const registry = new ModelInteractionService();
    const dispose = registry.register(definition("generic-model", 1, "a"));
    expect(registry.resolve({ id: "generic-model", version: 1 })).not.toBeNull();
    // version 不匹配 / id 不匹配都解析为 null（不回落 generic）。
    expect(registry.resolve({ id: "generic-model", version: 2 })).toBeNull();
    expect(registry.resolve({ id: "seedance-video", version: 1 })).toBeNull();
    dispose();
  });

  it("重复 identity 稳定拒绝，保留原 definition", () => {
    const registry = new ModelInteractionService();
    const first = registry.register(definition("generic-model", 1, "owner-a"));
    expect(() => registry.register(definition("generic-model", 1, "owner-b"))).toThrow(/已被 owner owner-a/);
    expect(registry.list()).toEqual([{ id: "generic-model", version: 1, owner: "owner-a" }]);
    first();
  });

  it("disposer 幂等且只删除自己的注册", () => {
    const registry = new ModelInteractionService();
    const dispose = registry.register(definition("generic-model", 1, "owner-a"));
    dispose();
    dispose();
    expect(registry.resolve({ id: "generic-model", version: 1 })).toBeNull();
    // 释放后可重新注册相同 identity（StrictMode 重放）。
    const again = registry.register(definition("generic-model", 1, "owner-c"));
    expect(registry.resolve({ id: "generic-model", version: 1 })?.owner).toBe("owner-c");
    again();
  });

  it("list 稳定排序且不暴露 component/closure", () => {
    const registry = new ModelInteractionService();
    registry.register(definition("seedance-video", 1, "owner-s"));
    registry.register(definition("generic-model", 1, "owner-g"));
    expect(registry.list()).toEqual([
      { id: "generic-model", version: 1, owner: "owner-g" },
      { id: "seedance-video", version: 1, owner: "owner-s" }
    ]);
    expect(Object.keys(registry.list()[0]!)).toEqual(["id", "version", "owner"]);
  });

  it("dispose 清空全部 registrations", () => {
    const registry = new ModelInteractionService();
    registry.register(definition("generic-model", 1, "owner-a"));
    registry.register(definition("seedance-video", 1, "owner-s"));
    registry.dispose();
    expect(registry.list()).toEqual([]);
  });

  it("非法 definition 拒绝", () => {
    const registry = new ModelInteractionService();
    expect(() => registry.register({ id: "", version: 1, owner: "o", Panel: panel() })).toThrow();
    expect(() => registry.register({ id: "x", version: 0, owner: "o", Panel: panel() })).toThrow();
    expect(() => registry.register({ id: "x", version: 1, owner: "", Panel: panel() })).toThrow();
  });
});
