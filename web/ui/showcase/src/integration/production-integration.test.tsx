import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeProvider, UiProvider } from "@woohaa3/ui";
import { showcaseThemeService } from "../theme.js";
import { SettingsIntegration } from "./settings-fixture.js";
import { CapabilityIntegration } from "./capability-fixture.js";
import { ConfigurationIntegration } from "./configuration-fixture.js";
import { InstallationIntegration } from "./installation-fixture.js";
import { MonitorIntegration, TelemetryIntegration } from "./observability-fixture.js";
import { FocusIntegration, FeedbackIntegration } from "./focus-feedback-fixture.js";

let host: HTMLDivElement;
let root: Root;
let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  fetchSpy = vi.fn(() => { throw new Error("Integration fixtures must not access a real network"); });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function mount(node: ReactNode) {
  await act(async () => root.render(<ThemeProvider service={showcaseThemeService}><UiProvider>{node}</UiProvider></ThemeProvider>));
}
async function click(text: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === text);
  expect(button, text).toBeDefined(); await act(async () => button!.click());
}
it.each([
  ["settings", SettingsIntegration, "设置工作区"],
  ["capability", CapabilityIntegration, "能力总览"],
  ["configuration", ConfigurationIntegration, "SDK"],
  ["installation", InstallationIntegration, "插件"],
  ["monitor", MonitorIntegration, "任务"],
  ["telemetry", TelemetryIntegration, "遥测"],
  ["focus", FocusIntegration, "长名称模型"],
  ["feedback", FeedbackIntegration, "安全模式"]
] as const)("mounts the real %s integration without external IO", async (_name, Component, text) => {
  await mount(<Component />); expect(host.textContent).toContain(text); expect(fetchSpy).not.toHaveBeenCalled();
  expect(host.querySelector("[data-integration-recorder]")).not.toBeNull();
});
it("MCP failure remains diagnostic and retries through the real panel", async () => {
  await mount(<CapabilityIntegration />); await click("error");
  expect(host.textContent).toContain("客户端检测失败"); await click("重新检测");
  expect(host.textContent).not.toContain("客户端检测失败"); expect(host.textContent).toContain("Codex");
  expect(fetchSpy).not.toHaveBeenCalled();
});
it("telemetry error refreshes and focus recovery stays in the fixture owner", async () => {
  await mount(<TelemetryIntegration />); await click("error");
  expect(host.textContent).toContain("遥测服务暂不可用");
  await click("刷新"); expect(host.textContent).not.toContain("遥测服务暂不可用");
  await mount(<FocusIntegration />); await click("error");
  expect(host.textContent).toContain("内容目标已失效"); await click("恢复目标");
  expect(host.textContent).not.toContain("内容目标已失效"); expect(fetchSpy).not.toHaveBeenCalled();
});
