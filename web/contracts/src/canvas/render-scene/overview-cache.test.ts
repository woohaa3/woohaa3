import { describe, expect, it } from "vitest";
import { overviewCacheFingerprint } from "./overview-cache.js";
import type { BevyCompositeAssetPresentation } from "./wire-scene.js";

const presentation = (x = 10): BevyCompositeAssetPresentation => ({ x, y: 20, width: 300, height: 200, itemPlacements: { a: { offset: { x: 1, y: 2, z: 3 }, scale: 1, yaw: 0 } } });

describe("overviewCacheFingerprint", () => {
  it("ignores absolute position while tracking pixel-affecting changes", () => {
    const base = { presentation: presentation(), resourceKey: "model:a", signature: "sig", themeFingerprint: "theme", tier: 256 as const };
    expect(overviewCacheFingerprint(base)).toBe(overviewCacheFingerprint({ ...base, presentation: presentation(999) }));
    expect(overviewCacheFingerprint(base)).not.toBe(overviewCacheFingerprint({ ...base, mediaRevision: 1 }));
    expect(overviewCacheFingerprint(base)).not.toBe(overviewCacheFingerprint({ ...base, tier: 512 }));
    expect(overviewCacheFingerprint(base)).not.toBe(overviewCacheFingerprint({ ...base, presentation: { ...base.presentation, contentExtent: 42 } }));
    expect(overviewCacheFingerprint(base)).not.toBe(overviewCacheFingerprint({ ...base, presentation: { ...base.presentation, layoutAabb: { min: [0, 0, 0], max: [1, 2, 3] } } }));
  });

  it("tracks media plane local position", () => {
    const plane = { id: "image", kind: "image" as const, x: 1, y: 2, z: 3, width: 10, height: 5, yaw: 0, hasTexture: true };
    const base = { presentation: { ...presentation(), media: [plane] }, tier: 256 as const };
    for (const axis of ["x", "y", "z"] as const) {
      expect(overviewCacheFingerprint(base)).not.toBe(overviewCacheFingerprint({
        ...base, presentation: { ...base.presentation, media: [{ ...plane, [axis]: plane[axis] + 1 }] }
      }));
    }
  });
});
