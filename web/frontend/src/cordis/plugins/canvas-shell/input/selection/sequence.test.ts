import { describe, expect, it } from "vitest";
import { recordSelectionPress, shouldSuppressDoubleClickFocus } from "./sequence.js";
import type { SelectionPressState } from "./types.js";

const state = (): SelectionPressState => ({ lastSelectionPress: null, previousSelectionPress: null });

describe("shouldSuppressDoubleClickFocus", () => {
  it("treats a double click that selected the model as selection only", () => {
    const press = state();
    recordSelectionPress(press, { nodeId: "model", selectedBefore: [], reason: "child", x: 10, y: 10, at: 100 });
    recordSelectionPress(press, { nodeId: "model", selectedBefore: ["model"], reason: "already-selected", x: 10, y: 10, at: 200 });
    expect(shouldSuppressDoubleClickFocus(press, "model", 250)).toBe(true);
  });

  it("keeps focus when the model was already selected before the sequence", () => {
    const press = state();
    recordSelectionPress(press, { nodeId: "model", selectedBefore: ["model"], reason: "already-selected", x: 10, y: 10, at: 100 });
    recordSelectionPress(press, { nodeId: "model", selectedBefore: ["model"], reason: "already-selected", x: 10, y: 10, at: 200 });
    expect(shouldSuppressDoubleClickFocus(press, "model", 250)).toBe(false);
  });

  it("also suppresses when the first click entered the container", () => {
    const press = state();
    recordSelectionPress(press, { nodeId: "model", selectedBefore: [], reason: "scope-entry", x: 10, y: 10, at: 100 });
    recordSelectionPress(press, { nodeId: "model", selectedBefore: ["area"], reason: "child", x: 10, y: 10, at: 200 });
    expect(shouldSuppressDoubleClickFocus(press, "model", 250)).toBe(true);
  });

  it("uses blank presses when the model was only hit by dblclick picking", () => {
    const press = state();
    recordSelectionPress(press, { nodeId: null, selectedBefore: [], reason: "empty", x: 10, y: 10, at: 100 });
    recordSelectionPress(press, { nodeId: null, selectedBefore: [], reason: "empty", x: 10, y: 10, at: 200 });
    expect(shouldSuppressDoubleClickFocus(press, "model", 250)).toBe(true);
  });

  it("ignores stale presses and other nodes", () => {
    const press = state();
    recordSelectionPress(press, { nodeId: "model", selectedBefore: [], reason: "child", x: 10, y: 10, at: 100 });
    expect(shouldSuppressDoubleClickFocus(press, "model", 1000)).toBe(false);
    expect(shouldSuppressDoubleClickFocus(press, "other", 150)).toBe(false);
  });
});
