// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RuntimeComponentsSection } from "./runtime-components-section.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("../../services/app-base-path.js", () => ({ getAppPublicFetch: () => globalThis.fetch }));
afterEach(() => vi.unstubAllGlobals());
it("does not install on opening settings and sends explicit download actions", async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ available: true, components: [{ id: "codex", version: "1", status: "missing", source: "managed" }] })));
  vi.stubGlobal("fetch", fetcher);
  const element = document.createElement("div");
  const root = createRoot(element);
  await act(async () => root.render(<RuntimeComponentsSection />));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toEqual(["/api/runtime-components", {}]);
  const button = [...element.querySelectorAll("button")].find((item) => item.textContent === "下载组件")!;
  await act(async () => button.click());
  expect(fetcher.mock.calls.some((args) => String(args[0]).endsWith("/codex/install"))).toBe(true);
  await act(async () => root.unmount());
});
