/**
 * App 级宿主连通性装配（从 page-scope.ts 抽出，纯重构；change: 2026-10-21-harden-extension-fault-isolation，D6）。
 *
 * 同源请求失败与画布会话断线进入重连；恢复后按 releaseId 决定是否提示重开画布。重开时先把 App 级
 * 发布目录改固定到新 release（失败保留旧 release，仍按旧 release 重开），再只重建 Canvas scope，
 * 不刷新整页。
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  createHostConnectivityService,
  createReleaseDiscoveryProbe,
  type HostConnectivityService,
  type HostProbeResult
} from "./services/host-connectivity.js";
import { getAppPublicFetch, observeAppPublicFetch } from "./services/app-base-path.js";
import type { CanvasSession } from "./contract/session.js";
import type { ExtensionRuntimeService } from "./extension-runtime/service.js";
import type { FrontendRuntime } from "./kernel.js";
import type { AppPageLocation } from "./navigation/app-router.js";

export type { HostConnectivityService, HostProbeResult };

/** AppRuntime 上与宿主连通性相关的字段（重连遮罩/「扩展已更新」数据源与只重建当前页面 scope）。 */
export type AppConnectivityRuntime = { hostConnectivity: HostConnectivityService; reopenCurrentPage(): Promise<void> };
/** startApp 的连通性测试注入：宿主探测（缺省读 `/extension-releases/current.json`）。 */
export type AppConnectivityOptions = { hostProbe?: () => Promise<HostProbeResult> };

export type AppHostConnectivity = {
  service: HostConnectivityService;
  /** 跟随当前页面 scope 的画布会话断线（换页时传入新 runtime，离开时传 null）。 */
  watchPage(runtime: FrontendRuntime | null): void;
  /** 绑定页面重开：只对 Canvas 用同一 location（去掉一次性 openSettings）重新走 transition。 */
  bindPageReopen(input: { location: () => AppPageLocation; apply: (location: AppPageLocation) => Promise<void> }): void;
  reopenCurrentPage(): Promise<void>;
  /** 交给 AppRuntime 的公开字段。 */
  runtimeFields(): AppConnectivityRuntime;
  dispose(): void;
};

export function installAppHostConnectivity(input: {
  appCtx: Context;
  runtime: ExtensionRuntimeService;
  probe?: () => Promise<HostProbeResult>;
}): AppHostConnectivity {
  let reopen: () => Promise<void> = async () => undefined;
  const service = createHostConnectivityService({
    probe: input.probe ?? createReleaseDiscoveryProbe(getAppPublicFetch()),
    pinnedReleaseId: () => input.runtime.current()?.releaseId ?? null,
    reopenCanvas: async (next) => {
      if (next.href) {
        try {
          await input.runtime.repin(next.href);
        } catch {
          /* 新目录不可用：保留旧 release，重开仍可用 */
        }
      }
      await reopen();
    }
  });
  const detachFetchObserver = observeAppPublicFetch((ok) => service.reportHttp(ok));
  input.appCtx.provide("hostConnectivity" as never, service as never);
  let sessionWatch: (() => void) | null = null;
  return {
    service,
    watchPage(runtime) {
      sessionWatch?.();
      sessionWatch = null;
      const session = runtime?.ctx.get("canvasSession" as never) as CanvasSession | undefined;
      if (!session?.subscribe) return;
      let wasOnline = session.getStatus().remote.mode === "remote";
      sessionWatch = session.subscribe((status) => {
        const online = status.remote.mode === "remote";
        // 只在「已连上 → 断线」时上报：页面刚打开还在连接时不算掉线。
        if (wasOnline && status.remote.mode === "offline") service.reportTransport("closed");
        wasOnline = online;
      });
    },
    bindPageReopen({ location, apply }) {
      reopen = async () => {
        const current = location();
        if (current.page !== "canvas") return;
        const { openSettings: _openSettings, ...plain } = current;
        await apply(plain);
      };
    },
    reopenCurrentPage: () => reopen(),
    runtimeFields: () => ({ hostConnectivity: service, reopenCurrentPage: () => reopen() }),
    dispose() {
      sessionWatch?.();
      sessionWatch = null;
      detachFetchObserver();
      service.dispose();
    }
  };
}
