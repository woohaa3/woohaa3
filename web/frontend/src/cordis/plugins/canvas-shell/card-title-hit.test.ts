import { describe, expect, it } from "vitest";
import { CARD_TITLE_ROW_HEIGHT, hitsCardTitleRow } from "./card-title-hit.js";

const rect = { x: 100, y: 200, width: 248, height: 232 };
const bottom = rect.y + rect.height;

describe("hitsCardTitleRow", () => {
  it("hits the bottom title band of rich cards", () => {
    expect(hitsCardTitleRow({ x: 150, y: bottom - 5 }, { type: "image" }, rect)).toBe(true);
    expect(hitsCardTitleRow({ x: 150, y: bottom - CARD_TITLE_ROW_HEIGHT }, { type: "text" }, rect)).toBe(true);
  });

  it("misses the preview area and points outside the card", () => {
    expect(hitsCardTitleRow({ x: 150, y: bottom - CARD_TITLE_ROW_HEIGHT - 1 }, { type: "image" }, rect)).toBe(false);
    expect(hitsCardTitleRow({ x: 90, y: bottom - 5 }, { type: "image" }, rect)).toBe(false);
    expect(hitsCardTitleRow({ x: 150, y: bottom + 1 }, { type: "image" }, rect)).toBe(false);
  });

  it("ignores node types and compact cards without a bottom title row", () => {
    expect(hitsCardTitleRow({ x: 150, y: bottom - 5 }, { type: "model3d" }, rect)).toBe(false);
    expect(hitsCardTitleRow({ x: 150, y: bottom - 5 }, { type: "group" }, rect)).toBe(false);
    expect(hitsCardTitleRow({ x: 110, y: 230 }, { type: "image" }, { x: 100, y: 200, width: 180, height: 64 })).toBe(false);
  });
});
