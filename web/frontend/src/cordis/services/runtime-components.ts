declare const __WOOHAA_NATIVE_ONLY__: boolean;
import { getAppPublicFetch } from "./app-base-path.js";

export type RuntimeComponent = {
  id: string; version: string; source: "managed" | "local"; status: string;
  entry?: string; path?: string; error?: string; progress?: { received: number; total?: number };
};
export type RuntimeComponentsSnapshot = {
  available: boolean; components: RuntimeComponent[]; configPath?: string;
};
export type RuntimeComponentsState = { snapshot: RuntimeComponentsSnapshot | null; error: string | null };
export type EditorReadiness = { phase: "loading" | "missing" | "failed" | "ready"; label: string; tip: string };

/** One read/poller for every canvas node and the runtime settings page. Never installs implicitly. */
export function createRuntimeComponentsStore(fetcher: typeof fetch = (input, init) => getAppPublicFetch()(input, init), managedImageEditor = true) {
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
  let preparing: Promise<void> | null = null;
  const prepareImageEditor = (): Promise<void> => {
    if (!managedImageEditor) return Promise.resolve();
    if (preparing) return preparing;
    preparing = (async () => {
      await refresh();
      if (state.error) throw new Error(state.error);
      if (imageEditorReadiness(state).phase === "ready") return;
      const component = state.snapshot?.components.find(item => item.id === "image-editor");
      if (!component || ["missing", "failed", "incompatible"].includes(component.status)) {
        const response = await fetcher("/api/runtime-components/image-editor/install", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message ?? "无法下载图片编辑组件");
      }
      await new Promise<void>((resolve, reject) => {
        let missingReads = 0;
        const check = () => {
          const readiness = imageEditorReadiness(state);
          if (readiness.phase === "ready") { off(); resolve(); }
          else if (readiness.phase === "failed" || (readiness.phase === "missing" && ++missingReads > 3)) { off(); reject(new Error(readiness.tip)); }
        };
        const off = subscribe(check);
        // The installation endpoint starts a background job; read its new state now.
        void refresh().then(check);
      });
    })().finally(() => { preparing = null; });
    return preparing;
  };
  return {
    getSnapshot: () => state,
    refresh,
    subscribe,
    subscribeImageEditor: managedImageEditor ? subscribe : (_listener: () => void) => () => {},
    prepareImageEditor
  };
}

export const runtimeComponents = createRuntimeComponentsStore(undefined, typeof __WOOHAA_NATIVE_ONLY__ !== "undefined" && __WOOHAA_NATIVE_ONLY__);

export function imageEditorReadiness({ snapshot, error }: RuntimeComponentsState): EditorReadiness {
  if (error) return { phase: "failed", label: "编辑器暂不可用", tip: error };
  if (!snapshot) return { phase: "loading", label: "正在检查编辑器…", tip: "图片仍可查看，检查完成后可进入编辑。" };
  // Browser builds carry their own WASM and do not use desktop runtime management.
  if (!snapshot.available) return { phase: "ready", label: "", tip: "" };
  const component = snapshot.components.find(item => item.id === "image-editor");
  if (component?.status === "ready") return { phase: "ready", label: "", tip: "" };
  const busy: Record<string, string> = { checking: "正在检查编辑器…", downloading: "正在下载编辑器…", verifying: "正在校验编辑器…", extracting: "正在安装编辑器…" };
  const label = component && busy[component.status];
  if (label) return { phase: "loading", label, tip: "图片仍可查看，准备完成后可进入编辑。" };
  if (!component || component.status === "missing") return { phase: "missing", label: "编辑组件未安装", tip: "图片仍可查看。安装图片编辑组件后即可编辑。" };
  return { phase: "failed", label: component.status === "incompatible" ? "编辑组件需要更新" : "编辑器准备失败", tip: component.error ?? "请在运行时组件设置中重新安装图片编辑组件。" };
}
