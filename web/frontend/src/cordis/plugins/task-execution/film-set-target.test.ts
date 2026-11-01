/**
 * 片场场景 AI 目标版本解析
 * （change: 2026-10-31-redesign-film-set-workspace / `openspec/specs/model-authoring`）。
 *
 * 片场场景 AI 固定整个片场目标：不带 clipId 时使用完整快照哈希；只有历史局部回合显式带
 * `clipId` 时才沿用该镜头的哈希，避免把旧局部授权扩大成整场。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalFilmSetFields,
  createEmptyWoohaa3ServerCanvas,
  createFilmSetSnapshot,
  createModelSnapshot,
  filmSetAnimationsOf,
  filmSetClipHash,
  readFilmSetAnimationProjection,
  type FilmSetContent,
  type ServerCanvas
} from "@woohaa3/contracts";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { resolveFilmSetTargetHash } from "./film-set-target.js";

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

describe("片场场景 AI 目标版本", () => {
  it("不带 clipId 时使用完整快照哈希，且随整个片场内容变化", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(filmSetCanvas(true) as never);
    const whole = resolveFilmSetTargetHash("film");
    expect(whole).toMatch(/^[0-9a-z]+$/);

    const animation = readFilmSetAnimationProjection(woohaa3CanvasStore.getState().canvas, "film")!;
    const clipHash = filmSetClipHash(filmSetAnimationsOf(animation).clips[0]!);
    // 整场身份不能退化成单个镜头身份。
    expect(whole).not.toBe(clipHash);

    woohaa3CanvasStore.getState().applyRemoteCanvas(filmSetCanvas(false) as never);
    expect(resolveFilmSetTargetHash("film")).not.toBe(whole);
  });

  it("没有动画镜头的片场仍可解析整场目标（用于新增对象和创建镜头）", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(filmSetCanvas(false) as never);
    expect(resolveFilmSetTargetHash("film")).toMatch(/^[0-9a-z]+$/);
  });

  it("历史局部回合显式带 clipId 时仍使用该镜头哈希", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(filmSetCanvas(true) as never);
    const animation = readFilmSetAnimationProjection(woohaa3CanvasStore.getState().canvas, "film")!;
    const clipHash = filmSetClipHash(filmSetAnimationsOf(animation).clips[0]!);
    expect(resolveFilmSetTargetHash("film", "clip-1")).toBe(clipHash);
    expect(resolveFilmSetTargetHash("film", "missing-clip")).toBeUndefined();
  });

  it("非片场节点不解析目标哈希", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(modelCanvas() as never);
    expect(resolveFilmSetTargetHash("m")).toBeUndefined();
  });
});
