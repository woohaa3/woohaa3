import { createContext, useContext, useState, type SetStateAction } from "react";
import type { PaintingGestureSettings } from "./gesture-settings.js";
import type { PaintingToolSettings } from "./tool-settings-state.js";

export const PaintingControlsContext = createContext<{
  painting: PaintingGestureSettings;
  tool: string;
  choose(tool: string): void;
} | null>(null);

/** 面板和上下文栏直接编辑画布编译器使用的同一份设置。精简宿主保留本地退化。 */
export function usePaintingSetting<K extends keyof PaintingToolSettings>(key: K, initial: PaintingToolSettings[K]) {
  const controls = useContext(PaintingControlsContext);
  const [fallback, setFallback] = useState(initial);
  const value = controls ? controls.painting.settings[key] : fallback;
  const set = (action: SetStateAction<PaintingToolSettings[K]>) => {
    const next = typeof action === "function" ? (action as (old: PaintingToolSettings[K]) => PaintingToolSettings[K])(value) : action;
    if (!controls) { setFallback(next); return; }
    if (key === "blendMode") controls.painting.setBlendMode(next as PaintingToolSettings["blendMode"]);
    else controls.painting.update(key, next);
  };
  return [value, set] as const;
}
