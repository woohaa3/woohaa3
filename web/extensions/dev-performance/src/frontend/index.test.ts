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

describe("性能读数扩展", () => {
  it.each([null, "false"])("浏览器开发标记缺席时不注册读数：%s", (marker) => {
    const { register, remove, effect, cleanup } = run(marker, false);
    expect(register).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
    cleanup();
    expect(remove).not.toHaveBeenCalled();
  });

  it("浏览器开发构建：注册读数并在作用域释放时移除", () => {
    const { register, remove, cleanup } = run("true", false);
    expect(register).toHaveBeenCalledWith("canvas.toolbar-status", expect.objectContaining({ owner: "dev-performance", wrapsStatus: true }));
    expect(register).toHaveBeenCalledOnce();
    cleanup();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("浏览器：读数留在右下角工具栏的同步状态位置", () => {
    const { register } = run("true", false);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]![0]).toBe("canvas.toolbar-status");
    expect(register).not.toHaveBeenCalledWith("canvas.topbar-status", expect.anything());
  });

  it("Tauri 开发：读数进入窗口顶栏，不再占用工具栏状态位", () => {
    const { register } = run("true", true);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]![0]).toBe("canvas.topbar-status");
    expect(register).not.toHaveBeenCalledWith("canvas.toolbar-status", expect.anything());
  });

  it.each([null, "false"])("Tauri 打包分发版（无开发标记）仍然注册顶栏读数：%s", (marker) => {
    // 打包桌面版按 `--mode desktop` 生产构建，HTML 里没有 `woohaa-development`：
    // 它正是需要 FPS/DC 的宿主，不能沿用只认开发标记的门禁。
    const { register } = run(marker, true);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]![0]).toBe("canvas.topbar-status");
    expect(register).not.toHaveBeenCalledWith("canvas.toolbar-status", expect.anything());
  });
});
