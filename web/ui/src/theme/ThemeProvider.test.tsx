/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { defaultAppTheme, darkAppTheme } from "@woohaa3/contracts";
import { expect, it, vi } from "vitest";
import { ThemeProvider, useAppTheme, type ThemeSource } from "./index.js";
it("uses the injected snapshot and releases subscriptions and root binding", () => {
  let theme = defaultAppTheme(); const listeners = new Set<() => void>(); const releaseRoot = vi.fn();
  const source: ThemeSource = { getSnapshot: () => theme, subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, applyTo: () => releaseRoot };
  const host = document.createElement("div"); const root = createRoot(host);
  function Probe() { return <output>{useAppTheme().id}</output>; }
  act(() => root.render(<ThemeProvider service={source}><Probe /></ThemeProvider>)); expect(host.textContent).toBe("default");
  act(() => { theme = darkAppTheme(); listeners.forEach(fn => fn()); }); expect(host.textContent).toBe("dark");
  act(() => root.unmount()); expect(listeners.size).toBe(0); expect(releaseRoot).toHaveBeenCalledTimes(1);
});
