/**
 * 基础层 · gateway：WebView 经同源 HTTP / WebSocket 进入本机宿主的唯一入口。
 *
 * 各插件把自己的处理器登记进来，插件卸载时随 effect 撤出；这里只做按顺序分发，不认识业务路径。
 */
import type { GatewayService, HostPlugin, HttpHandler, ReadinessResult, UpgradeHandler } from "../context.js";

type Ordered<T> = { order: number; value: T };

function insert<T>(list: Ordered<T>[], entry: Ordered<T>): () => void {
  list.push(entry);
  list.sort((a, b) => a.order - b.order);
  return () => {
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
  };
}

export const gatewayPlugin: HostPlugin = {
  name: "gateway",
  apply(ctx) {
    const routes: Ordered<HttpHandler>[] = [];
    const upgrades: Ordered<UpgradeHandler>[] = [];
    const checks: Ordered<() => Promise<ReadinessResult>>[] = [];
    const service: GatewayService = {
      route: (order, handler) => insert(routes, { order, value: handler }),
      upgrade: (handler) => insert(upgrades, { order: upgrades.length, value: handler }),
      readiness: (order, check) => insert(checks, { order, value: check }),
      async handle(req, res) {
        for (const { value } of [...routes]) {
          if (await value(req, res)) return true;
        }
        return false;
      },
      handleUpgrade(req, socket, head) {
        return upgrades.some(({ value }) => value(req, socket, head));
      },
      async ready() {
        const results = await Promise.all(checks.map(({ value }) => value()));
        const failed = results.find((result) => !result.ready);
        return failed ? { ready: false, ...(failed.reason ? { reason: failed.reason } : {}) } : { ready: true };
      }
    };
    ctx.provide("gateway", service);
  }
};
