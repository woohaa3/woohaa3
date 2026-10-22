import { afterEach, describe, expect, it, vi } from "vitest";
import { descriptor } from "./index.js";

afterEach(() => vi.unstubAllGlobals());

/** 运行 descriptor 插件；返回注册调用记录与清理函数。 */
function run(marker: string | null, desktop: boolean) {
  vi.stubGlobal("document", {
    querySelector: () => marker === null ? null : { getAttribute: () => marker }
  });
  if (desktop) vi.stubGlobal("__WOOHAA_DESKTOP__", { protocol: "woohaa-window-v1", token: "test" });
  const remove = vi.fn();
  const register = vi.fn((_slot: string, _contribution: unknown) => remove);
  let cleanup: (() => void) | undefined;
  const effect = vi.fn((setup: () => () => void) => { cleanup = setup(); });
  const plugin = descriptor.plugin() as (ctx: unknown) => void;
  plugin({ slots: { register }, effect });
  return { register, remove, effect, cleanup: () => cleanup?.() };
}

describe("开发性能扩展", () => {
  it.each([null, "false", "true"])("仅开发 HTML 标记为 true 时注册读数：%s", (marker) => {
    const { register, remove, effect, cleanup } = run(marker, false);
    if (marker === "true") {
      expect(register).toHaveBeenCalledWith("canvas.toolbar-status", expect.objectContaining({ owner: "dev-performance", wrapsStatus: true }));
      expect(register).toHaveBeenCalledOnce();
      cleanup();
      expect(remove).toHaveBeenCalledOnce();
    } else {
      expect(register).not.toHaveBeenCalled();
      expect(effect).not.toHaveBeenCalled();
    }
  });

  it("浏览器：读数留在右下角工具栏的同步状态位置", () => {
    const { register } = run("true", false);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]![0]).toBe("canvas.toolbar-status");
    expect(register).not.toHaveBeenCalledWith("canvas.topbar-status", expect.anything());
  });

  it("Tauri：读数进入窗口顶栏，不再占用工具栏状态位", () => {
    const { register } = run("true", true);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]![0]).toBe("canvas.topbar-status");
    expect(register).not.toHaveBeenCalledWith("canvas.toolbar-status", expect.anything());
  });
});
