import { describe, expect, it } from "vitest";
import { CanvasEditScopeStore } from "./canvas-edit-scope.js";

describe("CanvasEditScopeStore", () => {
  it("keeps state local to the bound canvas and resets on switch", () => {
    const store = new CanvasEditScopeStore();
    store.bindCanvas("a");
    store.setMode("3d", "locked");
    expect(store.getSnapshot()["3d"]).toBe("locked");
    store.bindCanvas("b");
    expect(store.getSnapshot()).toEqual({ "2d": "edit", "3d": "edit" });
  });

  it("publishes changes and rejects invalid mode values", () => {
    const store = new CanvasEditScopeStore();
    let count = 0;
    store.subscribe(() => { count += 1; });
    store.setScope({ "2d": "hidden", "3d": "unknown" });
    expect(store.getSnapshot()).toEqual({ "2d": "hidden", "3d": "edit" });
    expect(count).toBe(1);
  });
});
