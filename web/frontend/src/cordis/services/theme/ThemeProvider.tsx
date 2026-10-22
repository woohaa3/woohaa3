/**
 * Theme Provider / React 桥（change: unify-application-theme-tokens，任务 2.1 / 2.4）。
 *
 * 职责：
 * - 把 Theme Service 的 `--app-*` variables 挂到应用**根容器**（portal/dialog host 都位于其下）；
 * - 通过 context 向 Cordis UI / plugins / showcase preview 暴露同一 snapshot；
 * - 订阅 Service，仅在 snapshot 引用变化时更新根元素（原子，无逐 token 中间态）。
 *
 * 不依赖 Cordis 运行时：可以注入任意 `ThemeService`（showcase 用注入的 sentinel preset）。
 */
import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { AppThemeSnapshot } from "@woohaa3/contracts";
import type { ThemeService } from "../../contracts.js";

type ThemeContextValue = { theme: AppThemeSnapshot; service: ThemeService };

const ThemeContext = createContext<ThemeContextValue | null>(null);

export type ThemeProviderProps = {
  service: ThemeService;
  children: ReactNode;
};

export function ThemeProvider({ service, children }: ThemeProviderProps) {
  const theme = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    return service.applyTo(root);
  }, [service]);

  return (
    <ThemeContext.Provider value={{ theme, service }}>
      <div ref={rootRef} className="app-theme-root" data-theme-id={theme.id}>
        {children}
      </div>
    </ThemeContext.Provider>
  );
}

/** 读取当前主题 snapshot（必须位于 ThemeProvider 内）。 */
export function useAppTheme(): AppThemeSnapshot {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useAppTheme 必须位于 ThemeProvider 内");
  return value.theme;
}

/** 读取主题 Service（showcase / 主题切换 UI 用）。 */
export function useThemeService(): ThemeService {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useThemeService 必须位于 ThemeProvider 内");
  return value.service;
}

/** 可选读取：不在 Provider 内时返回 null（组件可脱离主题独立渲染）。 */
export function useOptionalAppTheme(): AppThemeSnapshot | null {
  return useContext(ThemeContext)?.theme ?? null;
}
