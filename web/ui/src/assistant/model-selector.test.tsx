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
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
it("长模型目录提供搜索，按名称或 provider 过滤并给出无匹配提示", () => {
  const options = Array.from({ length: 10 }, (_, index) => ({ value: `m${index}`, label: `模型 ${index} (provider-${index % 2})` }));
  mount(<AssistantModelSelector model="m0" options={options} open onOpenChange={vi.fn()} onChange={vi.fn()} />);
  const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索模型"]')!;
  expect(input).not.toBeNull();
  typeInto(input, "provider-1");
  const labels = [...document.querySelectorAll(".assistant-model-panel__option")].map(option => option.textContent);
  expect(labels).toHaveLength(5);
  expect(labels.every(label => label?.includes("provider-1"))).toBe(true);
  typeInto(input, "没有这个模型");
  expect(document.querySelectorAll(".assistant-model-panel__option")).toHaveLength(0);
  expect(document.body.textContent).toContain("没有匹配的模型");
});
it("短列表不显示搜索框", () => {
  mount(<AssistantModelSelector model="a" options={[{ value: "a", label: "模型 A" }, { value: "b", label: "模型 B" }]} open onOpenChange={vi.fn()} onChange={vi.fn()} />);
  expect(document.querySelector('input[aria-label="搜索模型"]')).toBeNull();
});
it("带 group 的模型列表分二级：一级是系列，二级是该系列的模型，选中才触发 onChange", () => {
  const change = vi.fn();
  mount(<AssistantListSelector model="a1" open onOpenChange={vi.fn()} onChange={change} options={[
    { value: "a1", label: "Banana2.1-标准", group: "Banana2.1" },
    { value: "a2", label: "Banana2.1-特惠", group: "Banana2.1" },
    { value: "b1", label: "Image2-标准", group: "GPT-Image2" },
    { value: "c1", label: "无分类模型" }
  ]} />);
  const triggers = [...document.querySelectorAll(".ui-menu__submenu-trigger")].map(node => node.textContent);
  expect(triggers).toEqual(["Banana2.1", "GPT-Image2", "其他"]);
  expect(document.body.textContent).not.toContain("Banana2.1-特惠");
  expect(change).not.toHaveBeenCalled();
});
it("没有任何 group 时保持原来的单列", () => {
  mount(<AssistantListSelector model="a" open onOpenChange={vi.fn()} onChange={vi.fn()} options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} />);
  expect(document.querySelector(".ui-menu__submenu-trigger")).toBeNull();
  expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(2);
});
