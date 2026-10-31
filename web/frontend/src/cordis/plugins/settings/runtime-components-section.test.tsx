// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RuntimeComponentsSection } from "./runtime-components-section.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("../../services/app-base-path.js", () => ({ getAppPublicFetch: () => globalThis.fetch }));
afterEach(() => vi.unstubAllGlobals());
it("does not install on opening settings and sends explicit download actions", async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ available: true, configPath: "/Users/private-user/Library/Application Support/app/config/runtime-downloads.json", components: [{ id: "codex", version: "1", status: "missing", source: "managed" }] })));
  vi.stubGlobal("fetch", fetcher);
  const element = document.createElement("div");
  const root = createRoot(element);
  await act(async () => root.render(<RuntimeComponentsSection />));
  expect(element.textContent).not.toContain("/Users/private-user");
  expect(element.textContent).not.toContain("runtime-downloads.json");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toEqual(["/api/runtime-components", {}]);
  const button = [...element.querySelectorAll("button")].find((item) => item.textContent === "下载组件")!;
  await act(async () => button.click());
  expect(fetcher.mock.calls.some((args) => String(args[0]).endsWith("/codex/install"))).toBe(true);
  await act(async () => root.unmount());
});
it("surfaces why a typed local path is unusable instead of reporting nothing found", async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => String(url).endsWith("/codex/discover")
    ? new Response(JSON.stringify({ candidates: [], selected: { path: "/Users/me/bin/codex", error: "env: node: No such file or directory" } }))
    : new Response(JSON.stringify({ available: true, components: [{ id: "codex", version: "1", status: "incompatible", source: "local", path: "/Users/me/bin/codex" }] })),
  );
  vi.stubGlobal("fetch", fetcher);
  const element = document.createElement("div");
  const root = createRoot(element);
  await act(async () => root.render(<RuntimeComponentsSection />));
  const discover = [...element.querySelectorAll("button")].find((item) => item.textContent === "探测本机程序")!;
  await act(async () => discover.click());
  // The configured path is sent so the host can explain it, rather than only listing candidates.
  const sent = fetcher.mock.calls.find((args) => String(args[0]).endsWith("/codex/discover"));
  expect(JSON.parse(String((sent as [RequestInfo | URL, RequestInit])[1].body))).toEqual({ path: "/Users/me/bin/codex" });
  expect(element.textContent).toContain("该路径不可用");
  expect(element.textContent).toContain("node");
  await act(async () => root.unmount());
});
