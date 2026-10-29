/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Listbox } from "./Listbox.js";
it("all disabled and empty lists cannot emit a selection on keyboard movement", () => {
  const host = document.createElement("div"); const root = createRoot(host); const change = vi.fn();
  for (const options of [[], [{ value: "lost", label: "不可用", disabled: true }]]) {
    act(() => root.render(<Listbox value="lost" label="选项" options={options} onValueChange={change} />));
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) act(() => host.firstElementChild!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
  }
  expect(change).not.toHaveBeenCalled(); act(() => root.unmount());
});
