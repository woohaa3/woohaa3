/**
 * 测试用通用 extension page 前端入口 fixture
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 0.5/8.1/9.4 / design D10）。
 *
 * 生产清单由构建期扫描各扩展包的约定前端入口得到；测试不能依赖具体扩展包
 * 的页面实现（页面已迁出核心），因此这里构造一个**形状等价**的确定性 fixture：它声明
 * `appPages`（pageId/path/旧路径/查询编解码）并在 page scope 注册 `app.route` contribution，
 * 用于验证宿主 Router/scope 生命周期的通用行为。fixture 绝不进入生产清单。
 *
 * 只属于核心 frontend 的测试支撑，不 import 任何具体业务扩展。
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import type {
  ApplicationExtensionFrontendEntry,
  ExtensionAppPageEntry,
  ExtensionAppPageQuery
} from "@woohaa3/contracts";

export type FakeAppPageProbe = {
  /** page-scope plugin 进入次数。 */
  entered: number;
  /** page-scope plugin 释放次数。 */
  disposed: number;
  /** 已注册的 route path（诊断/断言）。 */
  routes: string[];
};

export type FakeAppPageSpec = {
  extensionId?: string;
  pageId: string;
  path: string;
  legacyRedirectPaths?: readonly string[];
  title?: string;
  /** 只允许出现在查询中的已知键（缺省不限制）。 */
  queryKeys?: readonly string[];
};

export type FakeExtensionPageEntry = {
  entry: ApplicationExtensionFrontendEntry;
  probe: FakeAppPageProbe;
};

/**
 * 构造一个测试用可信前端入口：站点 scope、server-active，携带一个通用 extension page。
 *
 * `createPlugin` 无副作用；宿主在 page scope 装配时才注册 route contribution 并计入 probe。
 */
export function createFakeExtensionPageEntry(spec: FakeAppPageSpec): FakeExtensionPageEntry {
  const extensionId = spec.extensionId ?? "fake-extension";
  const probe: FakeAppPageProbe = { entered: 0, disposed: 0, routes: [] };

  const page: ExtensionAppPageEntry = {
    extensionId,
    pageId: spec.pageId,
    path: spec.path,
    ...(spec.legacyRedirectPaths ? { legacyRedirectPaths: [...spec.legacyRedirectPaths] } : {}),
    requiresAuth: true,
    ...(spec.title ? { title: spec.title } : {}),
    decodeQuery: (search) => decodeFakeQuery(search, spec.queryKeys),
    encodeQuery: (query) => encodeFakeQuery(query),
    createPlugin: () => {
      const plugin = ((ctx: Context) => {
        probe.entered += 1;
        probe.routes.push(spec.path);
        const remove = ctx.slots.register("app.route", {
          id: `${spec.pageId}-route`,
          owner: extensionId,
          path: spec.path,
          render: () => null
        });
        ctx.effect(() => () => {
          remove();
          probe.disposed += 1;
        }, `${spec.pageId}-route`);
      }) as Plugin;
      Object.defineProperty(plugin, "name", { value: `${spec.pageId}-page`, configurable: true });
      Object.defineProperty(plugin, "inject", { value: ["slots"], configurable: true });
      return plugin;
    }
  };

  const entry: ApplicationExtensionFrontendEntry = {
    extensionId,
    configScope: "site",
    activation: "server-active",
    appPages: [page],
    createPlugin: () => {
      const plugin = ((_ctx: Context) => undefined) as Plugin;
      Object.defineProperty(plugin, "name", { value: `${extensionId}-site`, configurable: true });
      return plugin;
    }
  };

  return { entry, probe };
}

function decodeFakeQuery(search: URLSearchParams, keys?: readonly string[]): ExtensionAppPageQuery {
  const out: Record<string, string> = {};
  for (const [key, value] of search.entries()) {
    if (value === "") continue;
    if (keys && !keys.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

function encodeFakeQuery(query: ExtensionAppPageQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== "") params.set(key, value);
  return params;
}
