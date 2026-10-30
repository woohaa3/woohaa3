import { describe, expect, it } from "vitest";
import { createFilmSetSnapshot, createMotionSnapshot, createFilmSetItemMotion } from "@woohaa3/contracts";
import { legacyFilmSetAnimations } from "../src/authoring/backend/legacy/legacy-film-set-animations.js";
const ITEM_ID = "model";
const CAMERA = { azimuth: 0, elevation: Math.PI / 4, distance: 8, aspect: "16:9", focusOffset: { x: 0, y: 0, z: 0 } } as const;
function cameraMotion() { return createMotionSnapshot({ motionScript: `motion.camera.tween({ id: "orbit", property: "azimuth", startTime: 0, endTime: 5, from: 0, to: 1 });`, basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" } }); }
describe("offline legacy clip migration", () => {
  it("legacy 折叠保留镜头语义且不改动源数据", () => {
    const model = createFilmSetSnapshot({
      title: "跑酷",
      model: { modelScript: `scene.box({id:"body"});`, modelScriptVersion: "woohaa-model-js-v2" },
      motionScript: "",
      timeline: { duration: 5, loop: false }
    }).filmSetContent.items.find(item => item.kind === "model")!;
    const legacyInput = {
      motion: cameraMotion(),
      camera: CAMERA,
      timeline: { duration: 5, loop: false },
      filmSetContent: {
        schemaVersion: 2 as const,
        items: [{ ...model, motion: createFilmSetItemMotion({ item: model, motionScript: `motion.model.rotate("body", { speed: 1 });` }), playback: { startTime: 0, duration: 5, timeScale: 1, loop: false } }]
      }
    };
    const before = JSON.stringify(legacyInput);
    const converted = legacyFilmSetAnimations(legacyInput);
    expect(JSON.stringify(legacyInput)).toBe(before);
    // 对象动作折叠为该 item 的 binding；镜头动作成为独立 cameraMotion。
    const clip = converted.animations.clips[0]!;
    expect(clip.bindings[0]!.itemId).toBe(ITEM_ID);
    expect(clip.cameraMotion).toEqual(legacyInput.motion);
    expect(clip.initialCamera).toEqual(CAMERA);
    // 正时长 + 镜头动作 → 显式 dynamic（D1，行为不靠 cameraMotion 推断）。
    expect(converted.animations.schemaVersion).toBe(3);
    expect(clip.kind).toBe("dynamic");
    // 折叠后的 items 不再携带 motion/playback。
    expect((converted.content.items[0] as { motion?: unknown }).motion).toBeUndefined();
  });

});
