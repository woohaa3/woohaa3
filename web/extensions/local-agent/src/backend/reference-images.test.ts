import { createEmptyWoohaa3ServerCanvas, SHARED_WORLD_VERSION } from "@woohaa3/contracts";
import { describe, expect, it } from "vitest";
import { loadMentionedReferenceImages, mentionedTitles, referenceImageNote, titleMentioned } from "./reference-images.js";

describe("组内图片点名", () => {
  it("用标题主名称对上，不因短词误配", () => {
    expect(titleMentioned("参考 Android Compact 看看里面是什么", "Android Compact - 1@3x.png")).toBe(true);
    expect(titleMentioned("参考图片", "Codex 图片")).toBe(false);
    expect(titleMentioned("看看图", "图")).toBe(false);
  });

  it("按节点顺序保留命中，并写成 Image 编号", () => {
    const matches = mentionedTitles("先看 Android Compact，再看 iPhone Duo", [
      { nodeId: "a", title: "iPhone Duo 三视图" },
      { nodeId: "b", title: "Android Compact - 1@3x.png" },
      { nodeId: "c", title: "Codex 图片" }
    ]);
    expect(matches.map((match) => match.nodeId)).toEqual(["a", "b"]);
    expect(referenceImageNote(matches)).toContain("Image 1：iPhone Duo 三视图（节点 a）");
    expect(referenceImageNote(matches)).toContain("Image 2：Android Compact - 1@3x.png（节点 b）");
  });

  it("只读取组内被点名的图片字节", async () => {
    const canvas = createEmptyWoohaa3ServerCanvas("c", "2026-11-03T00:00:00.000Z");
    canvas.document.nodes = [
      { id: "root", type: "workflow-group-2d", position: { x: 0, y: 0 } },
      { id: "shot", type: "image", parentId: "root", position: { x: 10, y: 10 } },
      { id: "other", type: "image", parentId: "root", position: { x: 20, y: 10 } }
    ];
    canvas.nodeData = {
      root: { workflowGroup2d: { kind: "workflow-group-2d", version: SHARED_WORLD_VERSION, groupId: "root", scopeVersion: "v1", memberNodeIds: ["shot", "other"] } },
      shot: { title: "Android Compact - 1@3x.png", outputAssetId: "asset-shot" },
      other: { title: "Codex 图片", outputAssetId: "asset-other" }
    };
    canvas.assets = [
      { id: "asset-shot", title: "Android Compact - 1@3x.png", mediaKind: "image", source: "uploaded", status: "ready", createdAt: "2026-11-03T00:00:00.000Z", metadata: { storageKey: "sha256-shot" } },
      { id: "asset-other", title: "Codex 图片", mediaKind: "image", source: "uploaded", status: "ready", createdAt: "2026-11-03T00:00:00.000Z", metadata: { storageKey: "sha256-other" } }
    ];
    const keys: string[] = [];
    const loaded = await loadMentionedReferenceImages(canvas, "参考 Android Compact，图里是什么", "root", async (storageKey) => {
      keys.push(storageKey);
      return { bytes: Uint8Array.from([9, 9]), contentType: "image/png" };
    });
    expect(keys).toEqual(["sha256-shot"]);
    expect(loaded?.images).toEqual([{ bytes: Uint8Array.from([9, 9]), contentType: "image/png" }]);
    expect(loaded?.note).toContain("Android Compact - 1@3x.png");
  });
});
