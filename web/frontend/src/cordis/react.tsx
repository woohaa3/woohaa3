/**
 * React Host 与页面级 Plugin Runtime 的桥接
 * （change: adopt-frontend-cordis-plugin-runtime，design D2/D8）。
 *
 * Host 通过稳定 snapshot/subscription 读取 runtime status、services 和 slots，并负责
 * DOM/Canvas 挂载。它**不**为已插件化功能维护第二套权威状态。
 */
import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode
} from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { RuntimeStatus } from "./contracts.js";
import type { FrontendRuntime } from "./kernel.js";

const RuntimeContext = createContext<FrontendRuntime | null>(null);

export function RuntimeProvider({ runtime, children }: { runtime: FrontendRuntime; children: ReactNode }) {
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

export function useRuntime(): FrontendRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("Frontend plugin runtime 未挂载：缺少 RuntimeProvider");
  return runtime;
}

export function useRuntimeContext(): Context {
  return useRuntime().ctx;
}

/** 读取当前 Context 中的任意 Service。 */
export function useService<K extends keyof Context>(key: K): Context[K] {
  const ctx = useRuntimeContext();
  return ctx[key];
}

/**
 * 可选读取 Service：无 RuntimeProvider 或 Service 缺失时返回 undefined 而不是抛错。
 *
 * 供生产组件在 Showcase/fixture 等无完整 runtime 的宿主中降级渲染
 * （change: 2026-10-12-unify-generation-history-strip）。
 */
export function useOptionalService<K extends keyof Context>(key: K): Context[K] | undefined {
  const runtime = useContext(RuntimeContext);
  return runtime ? (runtime.ctx[key] as Context[K]) : undefined;
}

export function useRuntimeStatus(): RuntimeStatus {
  const runtime = useRuntime();
  return useSyncExternalStore(runtime.subscribe, runtime.status, runtime.status);
}
