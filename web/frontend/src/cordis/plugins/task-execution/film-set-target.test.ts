/**
 * 片场默认目标片段解析
 * （change: 2026-10-12-add-agent-conversation-panel，design D3 / `openspec/specs/model-authoring`）。
 *
 * 动作写入必须携带 clipId；没有显式片段选择的片场生成面板用默认片段作为目标，否则工具授权
 * 拒绝片段写工具（`tool-not-allowed`），回合无写入。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalFilmSetFields,
  createEmptyWoohaa3ServerCanvas,
  createFilmSetSnapshot,
  createModelSnapshot,
  type FilmSetContent,
  type ServerCanvas
} from "@woohaa3/contracts";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { resolveFilmSetClipHash, resolveFilmSetTargetClip } from "./film-set-target.js";

const CONTENT: FilmSetContent = {
  schemaVersion: 4,
  items: [
    {
      id: "body",
      kind: "model",
      name: "角色",
      localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
      model: createModelSnapshot({ modelScript: `scene.box({id:"body"});`, modelScriptVersion: "woohaa-model-js-v2" })
    }
  ]
};

/** 片场节点画布；`withClip` 时含默认动画片段 `clip-1`。 */
function filmSetCanvas(withClip: boolean): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  const animation = createFilmSetSnapshot({
    title: "跑酷片场",
    model: { modelScript: `scene.box({id:"body"});`, modelScriptVersion: "woohaa-model-js-v2" },
    motionScript: withClip ? `motion.root({ itemId: "model" });` : "",
    timeline: { duration: 5, loop: false },
    filmSetContent: CONTENT
  });
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [{ id: "film", type: "composite-asset", position: { x: 0, y: 0 }, width: 196, height: 64 }] },
    nodeData: { film: canonicalFilmSetFields(animation) }
  } as unknown as ServerCanvas;
}

function modelCanvas(): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [{ id: "m", type: "model3d", position: { x: 0, y: 0 }, width: 196, height: 64 }] },
    nodeData: { m: { modelContentVersion: { revision: 1, contentHash: "h" } } }
  } as unknown as ServerCanvas;
}

afterEach(() => woohaa3CanvasStore.getState().applyRemoteCanvas(null as never));

describe("片场默认目标片段解析（design D3）", () => {
  it("解析片场节点的默认片段与内容哈希", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(filmSetCanvas(true) as never);
    expect(resolveFilmSetTargetClip("film")).toBe("clip-1");
    expect(resolveFilmSetClipHash("film")).toMatch(/^[0-9a-f]+$/);
  });

  it("没有动画片段时返回 undefined（面板据此禁用生成）", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(filmSetCanvas(false) as never);
    expect(resolveFilmSetTargetClip("film")).toBeUndefined();
    expect(resolveFilmSetClipHash("film")).toBeUndefined();
  });

  it("非片场节点不解析出片段", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(modelCanvas() as never);
    expect(resolveFilmSetTargetClip("m")).toBeUndefined();
    expect(resolveFilmSetClipHash("m")).toBeUndefined();
  });
});
