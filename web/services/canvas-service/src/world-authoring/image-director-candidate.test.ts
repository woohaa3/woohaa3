import { describe, expect, it } from "vitest";
import { IMAGE_DIRECTOR_SCENE_VERSION, SHARED_WORLD_VERSION } from "@woohaa3/contracts";
import { prepareImageDirectorCandidate } from "./image-director-candidate.js";

function candidate(script: string) {
  return { version: IMAGE_DIRECTOR_SCENE_VERSION, models: [{ key: "subject", name: "Subject", script, transform: { version: SHARED_WORLD_VERSION, position: { u: 3, v: 4, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } }], camera: { position: { u: 0, v: 2, h: 1 }, rotation: [0, 0, 0, 1], projection: { kind: "perspective", verticalFovRadians: 1, nearMeters: 0.1, farMeters: 100 } } };
}

describe("image director candidate preparation", () => {
  it("executes geometry and calculates its world footprint", async () => {
    const result = await prepareImageDirectorCandidate(candidate("scene.box({ id: 'body', size: [2, 2, 2] });"), { width: 4, height: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.footprints[0]).toEqual({ min: { u: 2, v: 3 }, max: { u: 4, v: 5 } });
  });
  it("rejects empty and invalid scripts with diagnostics", async () => {
    expect(await prepareImageDirectorCandidate(candidate("const x = 1;"), { width: 4, height: 3 })).toMatchObject({ ok: false, diagnostic: expect.stringContaining("geometry") });
    expect(await prepareImageDirectorCandidate(candidate("scene.notAFunction();"), { width: 4, height: 3 })).toMatchObject({ ok: false, diagnostic: expect.stringContaining("subject") });
    expect(await prepareImageDirectorCandidate(candidate("scene.box({ id: 'body', size: [1, 1, 1] }); scene.rotate('body', { axis: 'y', speed: 1 });"), { width: 4, height: 3 })).toMatchObject({ ok: false, diagnostic: expect.stringContaining("animation") });
  });
});
