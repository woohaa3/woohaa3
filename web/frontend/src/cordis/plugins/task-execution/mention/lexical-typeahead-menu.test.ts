import { expect, it } from "vitest";
import { typeaheadMenuPosition } from "./lexical-typeahead-menu.js";
it("uses a readable width and unfolds bottom dock menus upward", () => {
  expect(typeaheadMenuPosition({ left: 1200, top: 780, bottom: 800 }, 180, 1440, 900, true))
    .toMatchObject({ position: "fixed", width: 360, left: 1068, top: 592, maxHeight: 220 });
});
it("flips when space below is insufficient and keeps the popup within viewport height", () => {
  expect(typeaheadMenuPosition({ left: 100, top: 860, bottom: 880 }, 180, 1440, 900, false).top).toBe(672);
  expect(typeaheadMenuPosition({ left: 100, top: 100, bottom: 120 }, 180, 1440, 900, true))
    .toMatchObject({ top: 12, maxHeight: 80 });
});
