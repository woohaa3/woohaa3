import { getAppPublicFetch } from "./app-base-path.js";

export type RuntimeComponent = {
  id: string; version: string; source: "managed" | "npm-registry" | "local"; status: string;
  entry?: string; path?: string; error?: string; progress?: { received: number; total?: number };
  engine?: string; registry?: string; requests?: number;
};
export type RuntimeInstallPolicy = { installEnabled: boolean; sources: string[]; registry: string | null };
export type RuntimeComponentsSnapshot = {
  available: boolean; components: RuntimeComponent[]; configPath?: string;
  /** 部署侧安装策略；关闭运行期安装时 message 说明管理员原因。 */
  policy?: RuntimeInstallPolicy; installEnabled?: boolean; message?: string;
};
export type RuntimeComponentsState = { snapshot: RuntimeComponentsSnapshot | null; error: string | null };

/** One read/poller for every canvas node and the runtime settings page. Never installs implicitly. */
export function createRuntimeComponentsStore(fetcher: typeof fetch = (input, init) => getAppPublicFetch()(input, init)) {
  let state: RuntimeComponentsState = { snapshot: null, error: null };
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const schedule = () => {
    if (!listeners.size || timer !== null || (state.snapshot?.available === false && !state.error)) return;
    timer = setTimeout(() => { timer = null; void refresh(); }, 1500);
  };
  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    inFlight = (async () => {
      try {
        const response = await fetcher("/api/runtime-components", {});
        const snapshot = await response.json();
        if (!response.ok) throw new Error(snapshot.message ?? "无法读取组件状态");
        if (typeof snapshot.available !== "boolean" || !Array.isArray(snapshot.components)) throw new Error("组件状态响应无效");
        state = { snapshot, error: null };
      } catch (cause) {
        state = { snapshot: state.snapshot, error: cause instanceof Error ? cause.message : "无法读取组件状态" };
      } finally {
        inFlight = null;
        for (const listener of listeners) listener();
        schedule();
      }
    })();
    return inFlight;
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    if (listeners.size === 1) void refresh();
    return () => {
      listeners.delete(listener);
      if (!listeners.size && timer !== null) { clearTimeout(timer); timer = null; }
    };
  };
  return { getSnapshot: () => state, refresh, subscribe };
}
export const runtimeComponents = createRuntimeComponentsStore();
