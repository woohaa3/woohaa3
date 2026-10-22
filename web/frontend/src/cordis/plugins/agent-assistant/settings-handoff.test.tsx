/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { startFrontendScope } from "../../kernel.js";
import { SlotRegistry } from "../../slots.js";
import { localAgentSettingsExtension } from "../../../../../extensions/local-agent/src/frontend/plugin.js";
import { sdkAgentSettingsExtension } from "../../../../../extensions/sdk-agent/src/frontend/plugin.js";
import { oauthAgentSettingsExtension } from "../../../../../extensions/oauth-agent/src/frontend/plugin.js";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it.each([
  ["installed", localAgentSettingsExtension],
  ["api-key", sdkAgentSettingsExtension],
  ["login", oauthAgentSettingsExtension],
] as const)("未激活的 %s 设置只跳转 AI，不装配授权、检测或连接表单", async (kind, factory) => {
  const slots = new SlotRegistry();
  const runtime = await startFrontendScope(new Context(), {
    install(ctx) {
      ctx.provide("slots" as never, slots as never);
      ctx.provide("appRouter" as never, { getLocation: () => ({ page: "canvas" }) } as never);
    },
    plugins: [{ id: `settings-${kind}`, required: true, plugin: factory() }],
  });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const close = vi.fn();
  const opened = vi.fn();
  globalThis.addEventListener("woohaa3-open-agent-assistant", opened);
  try {
    const panels = slots.list("settings.plugin-config");
    expect(panels).toHaveLength(1);
    expect(slots.list("agent-assistant.configuration")).toHaveLength(0);
    expect(slots.list("provider-credentials.top")).toHaveLength(0);
    const Panel = panels[0]!.render;
    await act(async () => root.render(<Panel requestClose={close} />));
    expect(host.querySelector("input")).toBeNull();
    expect(host.textContent).toContain("打开 AI 助手");
    await act(async () => host.querySelector("button")!.click());
    expect(close).toHaveBeenCalledOnce();
    expect(opened).toHaveBeenCalledOnce();
    expect((opened.mock.calls[0]![0] as CustomEvent).detail).toEqual({ kind });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.removeEventListener("woohaa3-open-agent-assistant", opened);
    await runtime.dispose();
  }
  expect(slots.list("settings.plugin-config")).toHaveLength(0);
});
