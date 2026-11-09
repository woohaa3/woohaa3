import { currentAppBasePath } from "./app-base-path.js";

/** Browser-local canvas presentation. Never written to canonical canvas state. */
export const CANVAS_APPEARANCE_STORAGE_KEY = `woohaa:canvas-appearance:v1|${currentAppBasePath()}`;

type AppearanceSnapshot = { globalLightEnabled: boolean; error: string | null };
type AppearanceStorage = Pick<Storage, "getItem" | "setItem">;

export function createCanvasAppearanceStore(storage: AppearanceStorage | null, key = CANVAS_APPEARANCE_STORAGE_KEY) {
  let snapshot: AppearanceSnapshot = { globalLightEnabled: true, error: null };
  const listeners = new Set<() => void>();
  try {
    const raw: unknown = JSON.parse(storage?.getItem(key) ?? "null");
    if (raw && typeof raw === "object" && "globalLightEnabled" in raw && typeof raw.globalLightEnabled === "boolean") {
      snapshot = { globalLightEnabled: raw.globalLightEnabled, error: null };
    }
  } catch { /* Invalid/unavailable storage retains the default-on setting. */ }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setGlobalLightEnabled(enabled: boolean) {
      let error: string | null = null;
      try {
        if (!storage) throw new Error("storage unavailable");
        storage.setItem(key, JSON.stringify({ globalLightEnabled: enabled }));
      } catch {
        error = "无法保存外观偏好，本次会话内仍会生效。";
      }
      snapshot = { globalLightEnabled: enabled, error };
      for (const listener of listeners) listener();
    }
  };
}

function browserStorage(): AppearanceStorage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export const canvasAppearanceStore = createCanvasAppearanceStore(browserStorage());
