import * as publicUi from "@woohaa3/ui";
/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { Button, UiProvider, ThemeProvider, useAppTheme, usePortalContainer } from "@woohaa3/ui";
import { Button as LegacyButton, UiProvider as LegacyProvider } from "../../extension-api/index.js";
import { namedExports } from "./sdk-ui.js";
import { AppThemeService } from "../services/theme/service.js";
it("new/legacy SDK components and portals use the same host React contexts", () => {
  expect(namedExports.Button).toBe(Button); expect(LegacyButton).toBe(Button);
  expect(namedExports.UiProvider).toBe(UiProvider); expect(LegacyProvider).toBe(UiProvider);
  const service = new AppThemeService({ storage: null }); const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  function ExtensionProbe() { const theme = useAppTheme(); const portal = usePortalContainer(); return <output data-theme={theme.id} data-portal={Boolean(portal)} />; }
  act(() => root.render(<ThemeProvider service={service}><LegacyProvider><ExtensionProbe /></LegacyProvider></ThemeProvider>));
  expect(host.querySelector("output")?.getAttribute("data-portal")).toBe("true");
  act(() => { service.select("dark"); }); expect(host.querySelector("output")?.getAttribute("data-theme")).toBe("dark");
  const previous = service.getSnapshot(); expect(service.setPreset({ id: "invalid", tokens: {} }).ok).toBe(false); expect(service.getSnapshot()).toBe(previous);
  act(() => root.unmount()); service.dispose(); host.remove();
});

it("every public UI runtime export is provided by the host adapter", () => {
  for (const [name, value] of Object.entries(publicUi)) expect(namedExports[name as keyof typeof namedExports], name).toBe(value);
});
