import { describe, expect, it, vi } from "vitest";
import { protectWasmModule } from "./wasm-call-boundary.js";
import { RuntimeIssues } from "./runtime-issues.js";

describe("WASM trap 门禁", () => {
  it("不可变模块 namespace 可以包装，恢复/销毁立即门禁调用", () => {
    const issues = new RuntimeIssues();
    let allowed = true;
    const raw = Object.freeze({ default: vi.fn(async () => {}) });
    const module = protectWasmModule(raw, issues, () => allowed);
    expect(() => module.default()).not.toThrow();
    allowed = false;
    expect(() => module.default()).toThrow("不可用");
    expect(raw.default).toHaveBeenCalledOnce();
  });
  it("跨 realm 的 RuntimeError 和真实 unreachable 指令都阻止旧实例后续调用", async () => {
    const issues = new RuntimeIssues();
    const crossRealm = protectWasmModule({ crash: () => { throw { name: "RuntimeError", message: "unreachable" }; } }, issues);
    expect(() => crossRealm.crash()).toThrow();
    expect(issues.getSnapshot()[0]?.recoverable).toBe(false);
    const { instance } = await WebAssembly.instantiate(new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,7,9,1,5,99,114,97,115,104,0,0,10,5,1,3,0,0,11]));
    const query = vi.fn();
    const module = protectWasmModule({ crash: instance.exports.crash as () => void, query }, new RuntimeIssues());
    expect(() => module.crash()).toThrow("unreachable");
    expect(() => module.query()).toThrow("unreachable");
    expect(query).not.toHaveBeenCalled();
  });
  it("普通拒绝可继续，RuntimeError 后阻止所有后续导出调用", () => {
    const issues = new RuntimeIssues();
    const raw = { texture: vi.fn(() => { throw "Invalid texture"; }), query: vi.fn(() => "hit") };
    const module = protectWasmModule(raw, issues);
    expect(() => module.texture()).toThrow();
    expect(module.query()).toBe("hit");
    raw.texture = vi.fn(() => { throw new WebAssembly.RuntimeError("unreachable"); });
    expect(() => module.texture()).toThrow("unreachable");
    const calls = raw.query.mock.calls.length;
    expect(() => module.query()).toThrow("unreachable");
    expect(raw.query).toHaveBeenCalledTimes(calls);
    expect(issues.getSnapshot()[0]).toMatchObject({ scope: "runtime", recoverable: false });
    issues.clearRecoverable();
    expect(issues.getSnapshot()).toHaveLength(1);
  });
});
