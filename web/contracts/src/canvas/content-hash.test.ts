import { describe, expect, it, vi } from "vitest";
import { fnv1a64Hex } from "./content-hash";

function originalHash(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

describe("fnv1a64Hex", () => {
  it.each([
    ["", "cbf29ce484222325"],
    ["a", "af63dc4c8601ec8c"],
    ["foobar", "85944171f73967e8"],
    ["hello", "a430d84680aabd0b"],
    ["\u0000", "af63bd4c8601b7df"],
    ["\uffff", "b01d724c873d466e"],
    ["😀", "e5e45a0a241b88d8"],
  ])("preserves the UTF-16 vector %j", (input, expected) => {
    expect(fnv1a64Hex(input)).toBe(expected);
  });

  it("matches the original BigInt hash for seeded arbitrary UTF-16 code units", () => {
    let seed = 0x193a7bce;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const extremes = [0, 0xffff, 0xd800, 0xdbff, 0xdc00, 0xdfff];
    for (let sample = 0; sample < 400; sample += 1) {
      const length = next() % 1024;
      let input = String.fromCharCode(...extremes);
      for (let i = 0; i < length; i += 1) {
        input += String.fromCharCode(next() >>> 16);
      }
      expect(fnv1a64Hex(input)).toBe(originalHash(input));
    }
    for (const code of extremes) {
      const input = String.fromCharCode(code).repeat(8192);
      expect(fnv1a64Hex(input)).toBe(originalHash(input));
    }
  });

  it("does not convert each code unit to BigInt on long inputs", () => {
    const input = "resource\u0000\uffff😀".repeat(8192);
    const expected = originalHash(input);
    const conversion = vi.spyOn(globalThis, "BigInt");
    try {
      expect(fnv1a64Hex(input)).toBe(expected);
      expect(conversion.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      conversion.mockRestore();
    }
  });
});
