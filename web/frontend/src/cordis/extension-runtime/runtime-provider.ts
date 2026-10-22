/**
 * Extension 宿主 App 级 runtime provider
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 2.3 / design D1/D2/D7）。
 *
 * 责任边界：
 * - 提供当前 document **稳定的 App runtime token**（模块级单例对象；同 document 只有一个）；
 * - 提供宿主**实际** React / `react/jsx-runtime` 导出引用（绝不另打包第二份 React）；
 * - 按 SDK 能力分组**惰性**动态 import 宿主公开 adapter，并按组分缓存加载 Promise；
 * - 在扩展实现求值前校验 ABI/React major 与 required export 是否全部存在。
 *
 * bindings 只保存 app-level 不可变的运行时引用；MUST NOT 保存 page Context、store、canvasId、
 * 凭据或业务 service 实例——这些仍由当前 Cordis scope 注入（`ctx.*`）。
 */
import * as ReactNamespace from "react";
import * as JsxRuntimeNamespace from "react/jsx-runtime";
import {
  EXTENSION_SDK_ABI_VERSION,
  EXTENSION_SDK_GROUPS,
  HOST_REACT_MAJOR,
  type ExtensionRuntimeBindings,
  type ExtensionSdkGroup
} from "@woohaa3/contracts";
import type { ExtensionSdkGroupModule } from "./sdk-groups.js";

/**
 * 当前 document 的 App runtime 稳定 token。
 *
 * 模块级单例：同一 document 内所有 page scope 共享同一 token，跨页面复用 module/immutable
 * SDK 缓存。不同测试宿主必须用隔离 module loader/URL，不能用不同 token 覆盖同一绑定。
 */
export const APP_RUNTIME_TOKEN: object = Object.freeze({ runtime: "woohaa3-frontend-app-runtime" });

/** 各能力分组的惰性 loader；首个需要该组的扩展触发宿主公开 adapter chunk 的下载。 */
const GROUP_LOADERS: Record<ExtensionSdkGroup, () => Promise<ExtensionSdkGroupModule>> = {
  core: () => import("./sdk-core.js"),
  ui: () => import("./sdk-ui.js"),
  model: () => import("./sdk-model.js"),
  authoring: () => import("./sdk-authoring.js")
};

export type ExtensionRuntimeCompatibility = {
  sdkAbi: number;
  reactMajor: number;
};

/**
 * 兼容性校验失败（在扩展实现求值和业务注册之前抛出）。`code` 供 loader 归类为 `abi`，
 * `message` 为安全文案。
 */
export class ExtensionRuntimeCompatibilityError extends Error {
  readonly code: "abi" | "unknown-export" | "unknown-group";
  constructor(code: "abi" | "unknown-export" | "unknown-group", message: string) {
    super(message);
    this.name = "ExtensionRuntimeCompatibilityError";
    this.code = code;
  }
}

export type ExtensionRuntimeProvider = {
  /** 当前 App runtime 稳定 token（不可序列化、不跨浏览器）。 */
  readonly token: object;
  readonly sdkAbi: number;
  readonly reactMajor: number;
  /** 已加载的分组（诊断/测试）。 */
  loadedGroups(): ExtensionSdkGroup[];
  /**
   * 按 artifact 声明的要求准备 bindings：校验 ABI/React major 与 required export，惰性加载
   * 所需分组并返回不可变 bindings。任何不兼容都在返回前拒绝（不产生部分绑定副作用）。
   */
  prepareBindings(requirements: {
    sdkAbi: number;
    reactMajor: number;
    groups: readonly ExtensionSdkGroup[];
    exports: readonly string[];
  }): Promise<ExtensionRuntimeBindings>;
};

export type ExtensionRuntimeProviderOptions = {
  token?: object;
  sdkAbi?: number;
  reactMajor?: number;
  /** 注入分组 loader（测试；缺省使用宿主真实 adapter 动态 import）。 */
  groupLoaders?: Record<ExtensionSdkGroup, () => Promise<ExtensionSdkGroupModule>>;
};

export function createExtensionRuntimeProvider(
  options: ExtensionRuntimeProviderOptions = {}
): ExtensionRuntimeProvider {
  const token = options.token ?? APP_RUNTIME_TOKEN;
  const sdkAbi = options.sdkAbi ?? EXTENSION_SDK_ABI_VERSION;
  const reactMajor = options.reactMajor ?? HOST_REACT_MAJOR;
  const loaders = options.groupLoaders ?? GROUP_LOADERS;
  /** 分组成员缓存（App 级；跨 scope 复用，不缓存业务实例）。 */
  const groupCache = new Map<ExtensionSdkGroup, Promise<ExtensionSdkGroupModule>>();

  const loadGroup = (group: ExtensionSdkGroup): Promise<ExtensionSdkGroupModule> => {
    const loader = loaders[group];
    if (!loader) throw new ExtensionRuntimeCompatibilityError("unknown-group", `未知 SDK 分组：${String(group)}`);
    let pending = groupCache.get(group);
    if (!pending) {
      pending = loader();
      groupCache.set(group, pending);
    }
    return pending;
  };

  return {
    token,
    sdkAbi,
    reactMajor,
    loadedGroups: () => [...groupCache.keys()].sort(),
    async prepareBindings(requirements) {
      if (requirements.sdkAbi !== sdkAbi) {
        throw new ExtensionRuntimeCompatibilityError(
          "abi",
          `扩展要求 SDK ABI ${requirements.sdkAbi}，当前宿主为 ${sdkAbi}`
        );
      }
      if (requirements.reactMajor !== reactMajor) {
        throw new ExtensionRuntimeCompatibilityError(
          "abi",
          `扩展要求 React major ${requirements.reactMajor}，当前宿主为 ${reactMajor}`
        );
      }
      const groups = [...requirements.groups];
      for (const group of groups) {
        if (!EXTENSION_SDK_GROUPS.includes(group)) {
          throw new ExtensionRuntimeCompatibilityError("unknown-group", `未知 SDK 分组：${String(group)}`);
        }
      }
      const modules = await Promise.all(groups.map((group) => loadGroup(group)));
      const sdk: Record<string, unknown> = {};
      for (const module of modules) {
        for (const [name, value] of Object.entries(module.namedExports)) {
          sdk[name] = value;
        }
      }
      const missing = requirements.exports.filter((name) => !(name in sdk));
      if (missing.length > 0) {
        throw new ExtensionRuntimeCompatibilityError(
          "unknown-export",
          `当前宿主缺少扩展要求的公开导出：${missing.join(", ")}`
        );
      }
      return {
        token,
        sdkAbi,
        react: ReactNamespace as unknown as object,
        jsxRuntime: JsxRuntimeNamespace as unknown as object,
        sdk
      };
    }
  };
}
