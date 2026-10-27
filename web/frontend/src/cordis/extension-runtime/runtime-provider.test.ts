/**
 * Extension runtime provider 测试
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 2.5 / design D1/D2）。
 *
 * 验证：ABI / React major 精确整数匹配、未知分组拒绝、required export 校验、按组惰性加载并缓存、
 * 同 token 稳定、react 引用来自宿主实际实现。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { EXTENSION_SDK_ABI_VERSION, HOST_REACT_MAJOR, type ExtensionSdkGroup } from "@woohaa3/contracts";
import { createExtensionRuntimeProvider, ExtensionRuntimeCompatibilityError } from "./runtime-provider.js";
import type { ExtensionSdkGroupModule } from "./sdk-groups.js";

function provider(overrides: { loaded?: ExtensionSdkGroup[] } = {}) {
  const calls = new Map<ExtensionSdkGroup, number>();
  const module = (group: ExtensionSdkGroup, names: string[]): ExtensionSdkGroupModule => ({
    group,
    namedExports: Object.fromEntries(names.map((name) => [name, () => name]))
  });
  const instance = createExtensionRuntimeProvider({
    groupLoaders: {
      core: async () => {
        calls.set("core", (calls.get("core") ?? 0) + 1);
        return module("core", ["defineExtensionPlugin"]);
      },
      ui: async () => {
        calls.set("ui", (calls.get("ui") ?? 0) + 1);
        return module("ui", ["Button"]);
      },
      model: async () => module("model", ["ExecutionPanel"]),
      authoring: async () => module("authoring", [])
    }
  });
  return { instance, calls, overrides };
}

describe("createExtensionRuntimeProvider", () => {
  it("ABI 与 React major 精确匹配，整数不符拒绝", async () => {
    const { instance } = provider();
    await expect(
      instance.prepareBindings({ sdkAbi: 2, reactMajor: HOST_REACT_MAJOR, groups: [], exports: [] })
    ).rejects.toMatchObject({ code: "abi" });
    await expect(
      instance.prepareBindings({ sdkAbi: EXTENSION_SDK_ABI_VERSION, reactMajor: 17, groups: [], exports: [] })
    ).rejects.toMatchObject({ code: "abi" });
    expect(instance.sdkAbi).toBe(EXTENSION_SDK_ABI_VERSION);
    expect(instance.reactMajor).toBe(HOST_REACT_MAJOR);
  });

  it("未知分组与缺失导出在返回前拒绝", async () => {
    const { instance } = provider();
    await expect(
      instance.prepareBindings({
        sdkAbi: EXTENSION_SDK_ABI_VERSION,
        reactMajor: HOST_REACT_MAJOR,
        groups: ["nope" as ExtensionSdkGroup],
        exports: []
      })
    ).rejects.toBeInstanceOf(ExtensionRuntimeCompatibilityError);
    await expect(
      instance.prepareBindings({
        sdkAbi: EXTENSION_SDK_ABI_VERSION,
        reactMajor: HOST_REACT_MAJOR,
        groups: ["ui"],
        exports: ["Missing"]
      })
    ).rejects.toMatchObject({ code: "unknown-export" });
  });

  it("按组惰性加载并缓存（同组只加载一次），bindings 含宿主 React 引用与具名导出", async () => {
    const { instance, calls } = provider();
    const bindings = await instance.prepareBindings({
      sdkAbi: EXTENSION_SDK_ABI_VERSION,
      reactMajor: HOST_REACT_MAJOR,
      groups: ["core", "ui"],
      exports: ["defineExtensionPlugin", "Button"]
    });
    expect(calls.get("core")).toBe(1);
    expect(calls.get("ui")).toBe(1);
    expect(typeof bindings.sdk.defineExtensionPlugin).toBe("function");
    expect(typeof bindings.sdk.Button).toBe("function");
    expect(bindings.token).toBe(instance.token);
    expect(typeof (bindings.react as { createElement?: unknown }).createElement).toBe("function");
    expect(typeof (bindings.jsxRuntime as { jsx?: unknown }).jsx).toBe("function");
    // react-dom 必须来自宿主：内联第二份会因拿不到 React 内部状态在加载阶段失败。
    expect(typeof (bindings.reactDom as { createPortal?: unknown }).createPortal).toBe("function");
    expect(typeof (bindings.reactDom as { flushSync?: unknown }).flushSync).toBe("function");
    expect(
      (bindings.reactDom as Record<string, unknown>).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
    ).toBeDefined();
    expect(typeof (bindings.reactDomClient as { createRoot?: unknown }).createRoot).toBe("function");
    // 未请求的组不加载。
    expect(instance.loadedGroups()).toEqual(["core", "ui"]);
    // 第二次请求复用缓存。
    await instance.prepareBindings({
      sdkAbi: EXTENSION_SDK_ABI_VERSION,
      reactMajor: HOST_REACT_MAJOR,
      groups: ["core"],
      exports: []
    });
    expect(calls.get("core")).toBe(1);
  });

  it("token 默认稳定（同模块单例）", () => {
    expect(provider().instance.token).toBe(provider().instance.token);
  });

  it("真实 SDK 分组提供片场弹窗的助手选择器与 portal scope", async () => {
    const instance = createExtensionRuntimeProvider();
    const bindings = await instance.prepareBindings({
      sdkAbi: EXTENSION_SDK_ABI_VERSION,
      reactMajor: HOST_REACT_MAJOR,
      groups: ["ui", "model"],
      exports: ["Dialog", "Popover", "Listbox", "UiPortalScope", "AssistantConnectionPicker"]
    });
    const { UiPortalScope } = await import("../../shared/ui/UiProvider.js");
    expect(bindings.sdk.UiPortalScope).toBe(UiPortalScope);
    const { AssistantConnectionPicker } = await import("../plugins/task-execution/assistant-connection-picker.js");
    expect(bindings.sdk.AssistantConnectionPicker).toBe(AssistantConnectionPicker);
  });
});
