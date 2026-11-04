import { describe, it } from "vitest";
import { executeSceneIr } from "./script-executor.js";
import { createRendererClient } from "../model-renderer/client.js";
describe("tmp renderer", () => {
  it("renders with swiftshader", async () => {
    const ex = await executeSceneIr("scene.box({ id: 'body', size: [1, 1, 1], position: [0, 0, 0] });", "woohaa-model-js-v2", {});
    if (!ex.ok) throw new Error(JSON.stringify(ex));
    const client = createRendererClient({ command: "/data/workspace/woohaa3/client/bevy/target/x86_64-unknown-linux-gnu/release/model-renderer", env: { ...process.env, WGPU_BACKEND: "vulkan", VK_ICD_FILENAMES: "/root/.cache/ms-playwright/chromium-1243/chrome-linux64/vk_swiftshader_icd.json", VK_DRIVER_FILES: "/root/.cache/ms-playwright/chromium-1243/chrome-linux64/vk_swiftshader_icd.json" } });
    const result = await client.render({ requestId: "r1", sceneVersion: "woohaa-model-scene-ir-v2", signature: "sig", extent: 2, ops: ex.ops, capture: { width: 64, height: 64, background: "#ffffff", cameraPreset: "dimetric" } });
    console.log(result);
    await client.close();
  }, 60000);
});
