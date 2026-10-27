/**
 * 装配期服务访问守护（change: 2026-10-27-harden-plugin-service-access）。
 *
 * cordis 4 的 `ctx.get(name, strict = true)` 只在提供者 fiber 已经 active 时返回实现；而 apply
 * 窗口内整个启动批次都还没结算，提供者（哪怕是本插件自己刚 `ctx.provide` 的）都还停在 loading。
 * 于是"在 apply 里读一次服务存成变量"必然拿到 undefined，而且会被闭包永久记住：
 * 徽标变成点不动的文本、订阅根本没建立、面板永远不刷新。症状离原因很远，每次都要重查一遍。
 *
 * 判定方式刻意分成两阶段，避免误伤：
 * 1. apply 期间只**记录**取空的服务名，不打断装配（此刻无法区分"晚到"与"本来就没有"）；
 * 2. 启动结算后再看这些名字**是否已经可用**——可用了，说明它只是晚到，那次读取就是错的；
 *    仍然没有，说明这个能力确实不存在（可选能力、测试脚手架未装），不是竞态。
 *
 * 行为按环境分级：测试环境抛错（用例指着插件与服务名），开发环境告警，生产不介入。
 * 正确写法见 docs/design/plugin-service-access.md。
 */
import type { Context } from "@deepseek-ai/cordis";

type Mode = "throw" | "warn" | "off";

function mode(): Mode {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NODE_ENV;
  if (env === "test") return "throw";
  if (env === "production") return "off";
  return "warn";
}

type Miss = { plugin: string; service: string };

/** 一次 scope 启动期间的装配期取空记录（由 kernel 读取，用来在结算后判真伪）。 */
export type ServiceAccessGuard = { misses: Miss[] };

type GuardScope = { guard: ServiceAccessGuard };

/**
 * 标记键必须是 **Symbol**：cordis 的上下文是 Proxy，读一个未声明的字符串属性会直接抛
 * `cannot get property "x" without inject`；符号属性走它的特殊分支，未设置就是 undefined。
 */
const GUARD_SCOPE = Symbol.for("woohaa3.serviceAccessGuard");

/**
 * 标记一棵上下文树"这是真实 page scope"；只有这样的树才值守，避免单测里裸 Context 装配插件时
 * （本来就没有 install 服务）产生满屏假阳性，最终把这条守护关掉。
 */
export function markServiceAccessGuardScope<T extends Context>(ctx: T): { ctx: T; guard: ServiceAccessGuard } {
  const guard: ServiceAccessGuard = { misses: [] };
  return { ctx: ctx.extend({ [GUARD_SCOPE]: { guard } } as never) as T, guard };
}

type RawGet = (name: string, strict?: boolean) => unknown;

/** 在 `body` 执行期间把 `ctx.get` 换成带侦测的版本；`body` 返回什么就返回什么。 */
export function withApplyGuard<T extends Context, R>(ctx: T, pluginName: string, body: (ctx: T) => R): R {
  const how = mode();
  const scope = (ctx as unknown as Record<symbol, GuardScope | undefined>)[GUARD_SCOPE];
  if (how === "off" || !scope) return body(ctx);

  const rawGet = ctx.get.bind(ctx) as RawGet;
  const seen = new Set<string>();
  // 守护只覆盖 apply 的**同步区间**：这个 ctx 会被插件闭包记住，装配结束后回调里的读
  // 是"此刻确实没有这个能力"，不该算装配错误。
  let applying = true;
  const guardedGet = (name: string, strict?: boolean): unknown => {
    const value = rawGet(name, strict);
    if (!applying || value !== undefined || strict === false || seen.has(name)) return value;
    seen.add(name);
    scope.guard.misses.push({ plugin: pluginName, service: name });
    return value;
  };

  const guarded = ctx.extend({ get: guardedGet } as never) as T;
  try {
    return body(guarded);
  } finally {
    applying = false;
  }
}

/**
 * 启动结算后判真伪：装配期取空、但现在已经可用的服务 = 晚到的提供者，那次读取写错了。
 * 由 kernel 在 `Promise.all(fibers.await())` 之后调用。
 */
export function reportLateServiceReads(guard: ServiceAccessGuard, ctx: Context): void {
  if (!guard.misses.length) return;
  const how = mode();
  const late = guard.misses.filter((miss) => ctx.get(miss.service as never) !== undefined);
  guard.misses.length = 0;
  if (!late.length || how === "off") return;

  const detail = late.map((miss) => `${miss.plugin} → ${miss.service}`).join(", ");
  const message =
    `插件在装配期读取了"稍后才就绪"的服务：${detail}。` +
    `apply 窗口内 ctx.get 只会拿到 undefined 且不会重试，快照会被闭包永久记住（症状是功能静默失效）。` +
    `改用 inject / ctx.inject 声明依赖，或在回调里每次重新取。见 docs/design/plugin-service-access.md`;
  if (how === "throw") throw new Error(message);
  console.warn("[cordis] " + message);
}
