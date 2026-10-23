/**
 * 片场坐标契约 schema 4 的重放/拒绝回归
 * （change: 2026-10-23-isolate-film-set-camera-space，任务 1.3 / 4.3 / design D5）。
 *
 * 覆盖三件事：
 * - 旧 schema 3 内容被**在线**解码严格拒绝（旧客户端不接受新版本，新客户端也不静默重解释旧值）；
 * - 旧 schema 3 只在离线路径被显式许可读取，且不因此改写版本；
 * - 新版本片场写出后原样重读，内容/镜头不变（幂等）。
 */
import { describe, expect, it } from "vitest";
import { decodeFilmSetContent, emptyFilmSetContent, FILM_SET_CONTENT_VERSION } from "./film-set-content.js";
import { decodeFilmSetNodeData } from "./canvas-node-model.js";
import { filmSetNodeDataFields, createFilmSetSnapshot } from "./animation-snapshot.js";

function modelItem(id: string) {
  return {
    id,
    kind: "model" as const,
    name: id,
    localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
    model: {
      modelScript: "scene.box({id:'body'});",
      modelScriptLanguage: "javascript" as const,
      modelScriptVersion: "woohaa-model-js-v2" as const,
      contentVersion: { revision: 1, sourceHash: "s", contentHash: "c" },
      placement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
    }
  };
}

describe("片场坐标契约版本门禁", () => {
  it("在线解码只接受当前 schema，旧 schema 3 被明确拒绝", () => {
    expect(FILM_SET_CONTENT_VERSION).toBe(4);
    for (const schemaVersion of [1, 2, 3, 5]) {
      const decoded = decodeFilmSetContent({ schemaVersion, items: [modelItem("a")] });
      expect(decoded.ok).toBe(false);
      if (decoded.ok) return;
      expect(decoded.reason).toContain("schemaVersion");
    }
    expect(decodeFilmSetContent({ schemaVersion: 4, items: [modelItem("a")] }).ok).toBe(true);
  });

  it("离线许可只对显式传入的旧版本生效，且不改写版本", () => {
    const legacy = { schemaVersion: 3, items: [modelItem("a")] };
    const decoded = decodeFilmSetContent(legacy, { acceptedVersions: [3, 4] });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.schemaVersion).toBe(3);
    // 生产入口（不传 acceptedVersions）仍拒绝。
    expect(decodeFilmSetContent(legacy).ok).toBe(false);
  });

  it("节点数据：schema 3 内容在在线路径被拒绝，离线许可后可读", () => {
    const nodeData = {
      extensionId: "film-set",
      title: "片场",
      scenePlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
      sceneCamera: { azimuth: 0, elevation: 0.785, distance: 2.65, aspect: "16:9", focusOffset: { x: 0, y: 0, z: 0 } },
      filmSetContent: { schemaVersion: 3, items: [modelItem("a")] },
      filmSetAnimations: { schemaVersion: 3, defaultClipId: null, clips: [] }
    };
    expect(decodeFilmSetNodeData(nodeData).ok).toBe(false);
    const offline = decodeFilmSetNodeData(nodeData, { acceptedContentVersions: [3, 4] });
    expect(offline.ok).toBe(true);
  });

  it("空集合使用当前版本", () => {
    expect(emptyFilmSetContent().schemaVersion).toBe(FILM_SET_CONTENT_VERSION);
  });

  it("新版本片场写出后原样重读（镜头与内容不变）", () => {
    const snapshot = createFilmSetSnapshot({ title: "片场", timeline: { duration: 0, loop: false } });
    const fields = filmSetNodeDataFields(snapshot);
    const decoded = decodeFilmSetNodeData(fields);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.filmSetContent.schemaVersion).toBe(FILM_SET_CONTENT_VERSION);
    expect(decoded.value.sceneCamera).toEqual(snapshot.sceneCamera);
    expect(decoded.value.filmSetContent.items).toEqual(snapshot.filmSetContent.items);
  });
});
