/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AssistantModelSelector, AssistantListSelector } from "./model-selector.js";
import { UiProvider } from "../primitives/UiProvider.js";
let root: Root; let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); });
function mount(node: React.ReactNode) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); act(() => root.render(<UiProvider>{node}</UiProvider>)); }
it("accepts the empty-string Variant exactly once and keeps model selection controlled", () => {
  const change = vi.fn(), variant = vi.fn(), open = vi.fn();
  mount(<AssistantModelSelector model="a" options={[{ value: "a", label: "模型" }, { value: "off", label: "失效", disabled: true }]} open onOpenChange={open} onChange={change} variant={{ value: "deep", options: [{ value: "", label: "默认 Variant" }], onChange: variant }} />);
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="失效"]')!.click()); expect(change).not.toHaveBeenCalled();
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="默认 Variant"]')!.click()); expect(variant).toHaveBeenCalledTimes(1); expect(variant).toHaveBeenCalledWith(""); expect(open).toHaveBeenCalledWith(false);
});
it("a disabled controlled selector cannot open or select stale entries", () => {
  const change = vi.fn(), open = vi.fn(); mount(<AssistantListSelector model="lost" options={[]} open disabled onOpenChange={open} onChange={change} />);
  expect(document.querySelector('[role="menu"]')).toBeNull(); act(() => host.querySelector("button")!.click()); expect(change).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(host.textContent).toContain("lost");
});
