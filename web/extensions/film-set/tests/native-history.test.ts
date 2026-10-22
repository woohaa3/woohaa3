import { describe, expect, it } from "vitest";
import { createFilmSetSnapshot, filmSetAnimationsOf } from "@woohaa3/contracts";
import { prepareFilmSetHistoryFrame } from "../src/backend/history-frame.js";
const saved = () => {
  const scene = createFilmSetSnapshot({ title: "history", timeline: { duration: 0, loop: false }, model: { modelScript: "scene.box({id:'saved-part'});", modelScriptVersion: "woohaa-model-js-v2" }, modelItemId: "saved-item" });
  return { schemaVersion: 3 as const, scenePlacement: scene.scenePlacement, sceneCamera: scene.sceneCamera, filmSetContent: scene.filmSetContent, filmSetAnimations: filmSetAnimationsOf(scene) };
};
describe("历史原生完整片场帧", () => {
  it("从保存的 items 与静态镜头生成，不依赖顶层脚本或前端状态", async () => {
    const definition = saved();
    const frame = await prepareFilmSetHistoryFrame({ nodeId: "film", definition, assets: [] });
    expect(frame.ops.some(op => JSON.stringify(op).includes("saved-part"))).toBe(true);
    expect(frame.motion.initialCamera.distance).toBe(definition.sceneCamera.distance);
    expect(frame.motion.duration).toBe(0);
    expect(frame.compositeAssetFrame.media).toEqual([]);
  });
  it("根或镜头改变使完整历史身份失效", async () => {
    const definition = saved();
    const first = await prepareFilmSetHistoryFrame({ nodeId: "film", definition, assets: [] });
    const changed = await prepareFilmSetHistoryFrame({ nodeId: "film", definition: { ...definition, sceneCamera: { ...definition.sceneCamera, distance: definition.sceneCamera.distance + 1 } }, assets: [] });
    expect(changed.identity).not.toBe(first.identity);
  });
  it("缺少媒体读取能力时拒绝整帧，不返回漏素材的成功结果", async () => {
    const definition = saved();
    definition.filmSetContent.items.push({ id: "image", kind: "image", name: "saved image", assetId: "asset", aspectRatio: 1, localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } });
    await expect(prepareFilmSetHistoryFrame({ nodeId: "film", definition, assets: [] })).rejects.toThrow("稳定媒体读取");
  });
});
