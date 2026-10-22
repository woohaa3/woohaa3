import { expect, it, vi } from "vitest";
import { beginPhotocraftProfile, endPhotocraftProfile, measurePhotocraft, photocraftPreview, submitPhotocraftTexture } from "./photocraft-performance.js";
it("records only during capture, correlates pixel identity, and resets", () => {
  const now = vi.spyOn(performance, "now"); let clock = 0; now.mockImplementation(() => clock);
  try {
    beginPhotocraftProfile();
    const preview = photocraftPreview("full", () => measurePhotocraft("full.kernel", () => {
      clock += 5; return { width: 1, height: 1, pixels: new Uint8Array(4) };
    }));
    clock += 3;
    submitPhotocraftTexture(preview.pixels, () => { clock += 2; return true; });
    submitPhotocraftTexture(new Uint8Array(4), () => true);
    const result = endPhotocraftProfile();
    expect(result.stages["full.kernel"]).toMatchObject({ calls: 1, totalMs: 5 });
    expect(result.stages["full.texture-submit"]).toMatchObject({ calls: 1, bytes: 4, totalMs: 2 });
    expect(result.stages["full.preview-to-submit"]).toMatchObject({ p95Ms: 10 });
    measurePhotocraft("disabled", () => true);
    beginPhotocraftProfile();
    expect(endPhotocraftProfile()).toEqual({ stages: {} });
  } finally { now.mockRestore(); endPhotocraftProfile(); }
});
