/** @vitest-environment jsdom */
/**
 * 偏好订阅 hook 回归（U78）
 * （change: 2026-10-22-add-photocraft-workspace-customization）。
 *
 * 外壳渲染菜单/工具栏依赖这个 hook：偏好变化必须触发重渲染，且快照引用稳定（否则无限重渲染）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { CustomizationStore, type PreferenceStorage } from "./preferences.js";
import { useCustomizationPreferences, useCustomizationState } from "./use-customization-preferences.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function memoryStorage(): PreferenceStorage {
  const data: Record<string, string> = {};
  return { read: (key) => data[key] ?? null, write: (key, value) => { data[key] = value; } };
}

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

function renderProbe(store: CustomizationStore) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  const renders: number[] = [];
  function Probe() {
    const state = useCustomizationState(store);
    const preferences = useCustomizationPreferences(store);
    renders.push(preferences.toolbarHidden.length);
    return <span data-probe="true" data-persistence={state.persistence}>{preferences.menuHidden.join(",")}</span>;
  }
  act(() => root!.render(<Probe />));
  return { container, renders };
}

describe("偏好订阅 hook", () => {
  it("偏好变化触发重渲染，快照引用稳定不无限重渲染", () => {
    const store = new CustomizationStore(memoryStorage());
    const { container, renders } = renderProbe(store);
    expect(renders.length).toBeLessThanOrEqual(3);
    expect(container.querySelector("[data-probe]")?.getAttribute("data-persistence")).toBe("local");

    act(() => { store.setMenuHidden(["layer.delete"]); });
    expect(container.querySelector("[data-probe]")?.textContent).toBe("layer.delete");
    expect(renders.length).toBeLessThan(10);

    act(() => { store.setMenuHidden([]); });
    expect(container.querySelector("[data-probe]")?.textContent).toBe("");
  });

  it("同一快照重复渲染不再触发订阅通知", () => {
    const store = new CustomizationStore(memoryStorage());
    const { renders } = renderProbe(store);
    const before = renders.length;
    // 无变化写入不发布新状态（commit 提前返回），因此不应引发额外渲染。
    act(() => { store.setMenuHidden([]); });
    expect(renders.length).toBe(before);
  });
});
