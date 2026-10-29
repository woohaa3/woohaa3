import { useState } from "react";
import type { StoryDefault } from "@ladle/react";
import { APP_THEME_CSS_VARIABLES, APP_THEME_TOKEN_NAMES, defaultAppTheme, darkAppTheme, sentinelAppTheme, validateAppThemePreset } from "@woohaa3/contracts";
import { ThemeProvider, useAppTheme, type ThemeSource } from "./index.js";
import { Button, Popover, UiProvider } from "../primitives/index.js";
import { ComponentStage } from "../test-support/story-stage.js";
export default { title: "公共 UI/主题桥" } satisfies StoryDefault;
/** In-memory injected source; no storage or host dependency. */
function source() {
  let theme = defaultAppTheme(); const listeners = new Set<() => void>();
  const apply = (root: HTMLElement) => {
    root.style.colorScheme = theme.id === "dark" ? "dark" : "light";
    root.dataset.appTheme = theme.id;
    for (const name of APP_THEME_TOKEN_NAMES) root.style.setProperty(APP_THEME_CSS_VARIABLES[name], theme.tokens[name]);
  };
  return {
    getSnapshot: () => theme,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    applyTo: (root: HTMLElement) => { apply(root); const update = () => apply(root); listeners.add(update); return () => { listeners.delete(update); }; },
    set: (input: unknown) => { const result = validateAppThemePreset(input); if (!result.ok) return false; theme = result.theme; listeners.forEach(fn => fn()); return true; }
  } satisfies ThemeSource & { set(input: unknown): boolean };
}
function Probe() { const theme = useAppTheme(); return <output>当前快照：{theme.id}</output>; }
export function InjectedSource() {
  const [service] = useState(source); const [open, show] = useState(false);

  return <ComponentStage>{record => <ThemeProvider service={service}><UiProvider>
    {[defaultAppTheme(), darkAppTheme(), sentinelAppTheme()].map(preset => <Button key={preset.id} onClick={() => record(`主题 ${preset.id}: ${service.set(preset)}`)}>{preset.id}</Button>)}
    <Button onClick={() => record(`非法输入拒绝：${!service.set({ id: "invalid", tokens: {} })}`)}>非法主题</Button>
    <Probe /><Popover open={open} onOpenChange={show} trigger={<Button>同快照 portal</Button>}><Probe /></Popover>
  </UiProvider></ThemeProvider>}</ComponentStage>;
}

/** 三套预设逐项切换：根容器 data-app-theme、colorScheme 与 token 同步更新。 */
export function PresetSwitch() {
  const [service] = useState(source);
  return <ComponentStage>{record => <ThemeProvider service={service}><UiProvider>
    <div className="showcase__row">
      {[defaultAppTheme(), darkAppTheme(), sentinelAppTheme()].map(preset => <Button key={preset.id} onClick={() => record(`切换到 ${preset.id}：${service.set(preset)}`)}>{preset.id}</Button>)}
    </div>
    <Probe />
    <output>根容器 data-theme-id={service.getSnapshot().id}；colorScheme 由 Provider 写入。</output>
  </UiProvider></ThemeProvider>}</ComponentStage>;
}

/** 非法预设被拒绝；Provider 卸载后释放订阅，重新挂载读取最新快照。 */
export function InvalidAndRelease() {
  const [service] = useState(source);
  const [mounted, setMounted] = useState(true);
  return <ComponentStage>{record => <>
    <div className="showcase__row">
      <Button size="sm" onClick={() => record(`拒绝非法预设：${!service.set({ id: "invalid", tokens: {} })}`)}>提交非法预设</Button>
      <Button size="sm" onClick={() => { setMounted(v => !v); record(mounted ? "卸载 Provider" : "重新挂载 Provider"); }}>{mounted ? "卸载" : "重新挂载"}</Button>
      <Button size="sm" onClick={() => record(`离线切换 dark：${service.set(darkAppTheme())}`)}>卸载时切到 dark</Button>
    </div>
    {mounted ? <ThemeProvider service={service}><UiProvider><Probe /></UiProvider></ThemeProvider> : <p>Provider 已卸载；service 仍持有快照。</p>}
  </>}</ComponentStage>;
}
