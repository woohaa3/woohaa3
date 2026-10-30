import { describe, expect, it } from "vitest";
import { CARD_META_HEIGHT, hitsCardTitleRow } from "./card-title-hit.js";

const rect = { x: 100, y: 200, width: 248, height: 232 };

describe("hitsCardTitleRow", () => {
  it("hits the row above the card, not inside it", () => {
    expect(hitsCardTitleRow({ x: 150, y: rect.y - 4 }, { type: "image" }, rect)).toBe(true);
    expect(hitsCardTitleRow({ x: 150, y: rect.y - CARD_META_HEIGHT }, { type: "text" }, rect)).toBe(true);
  });

  it("misses the card body, the gap, and points outside", () => {
    expect(hitsCardTitleRow({ x: 150, y: rect.y + 40 }, { type: "image" }, rect)).toBe(false);
    expect(hitsCardTitleRow({ x: 150, y: rect.y - CARD_META_HEIGHT - 1 }, { type: "image" }, rect)).toBe(false);
    expect(hitsCardTitleRow({ x: 90, y: rect.y - 4 }, { type: "image" }, rect)).toBe(false);
  });

  it("ignores node types and compact cards without the row", () => {
    expect(hitsCardTitleRow({ x: 150, y: rect.y - 4 }, { type: "model3d" }, rect)).toBe(false);
    expect(hitsCardTitleRow({ x: 150, y: rect.y - 4 }, { type: "group" }, rect)).toBe(false);
    expect(hitsCardTitleRow({ x: 110, y: 196 }, { type: "image" }, { x: 100, y: 200, width: 180, height: 64 })).toBe(false);
  });
});
