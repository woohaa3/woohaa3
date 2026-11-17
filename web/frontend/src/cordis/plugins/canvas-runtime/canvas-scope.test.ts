import { describe, expect, it, vi } from "vitest";
import { CanvasScopeCoordinator, canvasScopeCapability, type CanvasScopeModule } from "./canvas-scope.js";

function moduleWithTokens(): CanvasScopeModule {
  let next = 0;
  return { begin_canvas_scope: vi.fn(() => String(++next)), end_canvas_scope: vi.fn() };
}

describe("CanvasScopeCoordinator", () => {
  it("freezes visits across A to B to A and refuses stale close", () => {
    const module = moduleWithTokens();
    const coordinator = new CanvasScopeCoordinator(module);
    const a = coordinator.open("a");
    expect(coordinator.open("a")).toBe(a);
    const b = coordinator.open("b");
    const again = coordinator.open("a");
    expect([a.token, b.token, again.token]).toEqual(["1", "2", "3"]);
    expect(coordinator.isCurrent(a)).toBe(false);
    expect(coordinator.close(a)).toBe(false);
    expect(coordinator.snapshot()).toBe(again);
    expect(coordinator.close(again)).toBe(true);
    expect(module.end_canvas_scope).toHaveBeenCalledTimes(1);
    expect(module.end_canvas_scope).toHaveBeenCalledWith("3");
  });

  it("invalidates the previous scope when begin fails", () => {
    const module = moduleWithTokens();
    const coordinator = new CanvasScopeCoordinator(module);
    const a = coordinator.open("a");
    vi.mocked(module.begin_canvas_scope).mockImplementationOnce(() => { throw new Error("failed"); });
    expect(() => coordinator.open("b")).toThrow("failed");
    expect(coordinator.isCurrent(a)).toBe(false);
    expect(coordinator.snapshot()).toBeNull();
  });

  it("distinguishes a replacement renderer even when token strings repeat", () => {
    const first = moduleWithTokens(), second = moduleWithTokens();
    const coordinator = new CanvasScopeCoordinator(first);
    const old = coordinator.open("a");
    coordinator.replace(second);
    const next = coordinator.open("a");
    expect(old.token).toBe(next.token);
    expect(coordinator.isCurrent(old)).toBe(false);
    expect(coordinator.isCurrent(next)).toBe(true);
    expect(first.end_canvas_scope).toHaveBeenCalledTimes(1);
    expect(first.end_canvas_scope).toHaveBeenCalledWith("1");
  });

  it("invalidates the previous scope when begin advances a numeric active token then loses the response", () => {
    let active = 0;
    const module = moduleWithTokens();
    vi.mocked(module.begin_canvas_scope)
      .mockImplementationOnce(() => {
        active = 1;
        return "1";
      })
      .mockImplementationOnce(() => {
        active = 2;
        throw new Error("response lost");
      })
      .mockImplementationOnce(() => {
        active = 3;
        return "3";
      });
    const coordinator = new CanvasScopeCoordinator(module);
    const a = coordinator.open("a");
    expect(a.token).toBe("1");
    expect(active).toBe(1);
    expect(() => coordinator.open("b")).toThrow("response lost");
    expect(active).toBe(2);
    expect(coordinator.isCurrent(a)).toBe(false);
    expect(coordinator.snapshot()).toBeNull();
    const c = coordinator.open("c");
    expect(c.token).toBe("3");
    expect(active).toBe(3);
    expect(coordinator.isCurrent(c)).toBe(true);
    expect(coordinator.snapshot()).toBe(c);
    expect(coordinator.close(a)).toBe(false);
    expect(module.end_canvas_scope).not.toHaveBeenCalled();
    expect(coordinator.close(c)).toBe(true);
    expect(module.end_canvas_scope).toHaveBeenCalledTimes(1);
    expect(module.end_canvas_scope).toHaveBeenCalledWith("3");
  });
});

describe("canvasScopeCapability", () => {
  it("returns legacy for an empty object", () => {
    expect(canvasScopeCapability({})).toBe("legacy");
  });

  it("throws when only begin_canvas_scope is present", () => {
    expect(() => canvasScopeCapability({ begin_canvas_scope() {} })).toThrow("Incomplete canvas scope capability");
  });

  it("returns scoped when all seven methods are functions", () => {
    const module = {
      begin_canvas_scope() {},
      end_canvas_scope() {},
      set_scene_scoped() {},
      set_texture_scoped() {},
      set_model_media_texture_scoped() {},
      set_image_focus_details_scoped() {},
      poll_texture_receipts_scoped() {},
    };
    expect(canvasScopeCapability(module)).toBe("scoped");
  });
});
