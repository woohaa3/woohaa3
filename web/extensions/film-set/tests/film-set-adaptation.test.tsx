/**
 * 当前片段对象动作适配确认测试
 * （change: 2026-10-10-improve-film-set-editing-and-inspector，任务 6.7 / design D9）。
 *
 * 覆盖：适配状态从当前有效片段 binding 读取（非对象级）、失配时禁用原因、只读门禁，
 * 以及确认发送 `filmSet.clipPatch` 且携带 `expectedAdapterHash` 与 `expectedHash`。
 *
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalFilmSetFields,
  createFilmSetSnapshot,
  createEmptyWoohaa3ServerCanvas,
  createModelSnapshot,
  DEFAULT_FILM_SET_PLAYBACK,
  decodeFilmSetNodeData,
  filmSetAnimationsOf,
  filmSetClipPrecondition,
  filmSetItemAdapterHash,
  type FilmSetNodeData,
  type FilmSetAnimationClip,
  type FilmSetModelItem,
  type ServerCanvas
} from "@woohaa3/contracts";
import type { FilmSetContext as Context } from "../src/integration/browser/context.js";
import { CompositeAssetRegistry } from "@woohaa3/frontend/extension-api";
import { createTestCanvasState } from "./canvas-state.js";
const woohaa3CanvasStore = createTestCanvasState();
import { FilmSetAdaptationConfirm, resolveAdaptation } from "../src/authoring/browser/film-set-adaptation.js";
import type { CanvasCommand } from "@woohaa3/contracts";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function modelItem(id: string, script = `scene.box({id:"body"});`): FilmSetModelItem {
  return {
    id,
    kind: "model",
    name: id,
    localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
    model: createModelSnapshot({ modelScript: script, modelScriptVersion: "woohaa-model-js-v2" })
  };
}

/** 带一个失配 binding 的片场（binding.motion.basedOn 与对象内容不一致）。 */
function animationWithStaleBinding(item: FilmSetModelItem): FilmSetNodeData {
  const base = createFilmSetSnapshot({
    title: "片场",
    model: { modelScript: item.model.modelScript, modelScriptVersion: "woohaa-model-js-v2" },
    modelItemId: item.id,
    // 对象动作只经片段 binding（items-only，D10）。
    motionScript: "motion.model.rotate('body', { speed: 1 });",
    timeline: { duration: 5, loop: false }
  });
  const clips = filmSetAnimationsOf(base);
  const clip = clips.clips[0]!;
  const stale: FilmSetAnimationClip = {
    ...clip,
    bindings: clip.bindings.map(binding => binding.motion
      ? { ...binding, motion: { ...binding.motion, basedOnModelVersion: { revision: 99, contentHash: "stale-hash" } } }
      : binding)
  };
  return {
    ...base,
    filmSetContent: { ...base.filmSetContent, items: base.filmSetContent.items.map(entry => entry.id === item.id ? item : entry) },
    filmSetAnimations: { ...clips, defaultClipId: stale.id, clips: [stale] }
  };
}

describe("resolveAdaptation（任务 6.7）", () => {
  it("无选中对象时给出对象页提示", () => {
    const animation = animationWithStaleBinding(modelItem("a"));
    const state = resolveAdaptation({ animation, clip: undefined, item: undefined, writable: true });
    expect(state.changed).toBe(false);
    expect(state.disabledReason).toContain("对象");
  });

  it("无可用片段时给出提示", () => {
    const animation = animationWithStaleBinding(modelItem("a"));
    const state = resolveAdaptation({ animation, clip: undefined, item: animation.filmSetContent.items[0], writable: true });
    expect(state.changed).toBe(false);
    expect(state.disabledReason).toContain("片段");
  });

  it("当前片段 binding 失配且可写 → 可确认", () => {
    const item = modelItem("a");
    const animation = animationWithStaleBinding(item);
    const clip = animation.filmSetAnimations!.clips[0]!;
    const state = resolveAdaptation({ animation, clip, item, writable: true });
    expect(state.changed).toBe(true);
    expect(state.disabledReason).toBeNull();
  });

  it("失配但只读 → 明确禁用原因", () => {
    const item = modelItem("a");
    const animation = animationWithStaleBinding(item);
    const clip = animation.filmSetAnimations!.clips[0]!;
    const state = resolveAdaptation({ animation, clip, item, writable: false });
    expect(state.changed).toBe(true);
    expect(state.disabledReason).toContain("不可写");
  });

  it("binding 适配版本与对象内容一致时不提示", () => {
    const item = modelItem("a");
    const animation = animationWithStaleBinding(item);
    const clip = animation.filmSetAnimations!.clips[0]!;
    const aligned: FilmSetAnimationClip = {
      ...clip,
      bindings: [{ ...clip.bindings[0]!, motion: { ...clip.bindings[0]!.motion!, basedOnModelVersion: { revision: 1, contentHash: filmSetItemAdapterHash(item) } } }]
    };
    const state = resolveAdaptation({ animation, clip: aligned, item, writable: true });
    expect(state.changed).toBe(false);
    expect(state.disabledReason).toBeNull();
  });

  it("对象无 binding 动作时不提示", () => {
    const item = modelItem("a");
    const animation = animationWithStaleBinding(item);
    const clip = animation.filmSetAnimations!.clips[0]!;
    const noBinding: FilmSetAnimationClip = { ...clip, bindings: [{ itemId: item.id, playback: DEFAULT_FILM_SET_PLAYBACK }] };
    const state = resolveAdaptation({ animation, clip: noBinding, item, writable: true });
    expect(state.changed).toBe(false);
  });
});

describe("FilmSetAdaptationConfirm 提交 clipPatch（任务 6.7）", () => {
  let root: Root | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    woohaa3CanvasStore.getState().applyRemoteCanvas(null as never);
  });

  function setup() {
    const item = modelItem("a");
    const animation = animationWithStaleBinding(item);
    const clip = animation.filmSetAnimations!.clips[0]!;
    const base = createEmptyWoohaa3ServerCanvas("c1");
    const canvas = {
      ...base,
      revision: 1,
      document: { ...base.document, nodes: [{ id: "film", type: "composite-asset", position: { x: 0, y: 0 }, width: 196, height: 64 }] },
      nodeData: { film: canonicalFilmSetFields(animation) }
    } as unknown as ServerCanvas;
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas as never);
    const submitted: CanvasCommand[] = [];
    const ctx = {
      canvasState: woohaa3CanvasStore.facade, compositeAssets: new CompositeAssetRegistry(),
      canvasSession: {
        isWritable: () => true,
        submitCommands: (commands: CanvasCommand[]) => { submitted.push(...commands); return { ok: true, handle: { settled: Promise.resolve({ state: "committed", error: null }) } }; }
      }
    } as unknown as Context;
    const element = document.createElement("div");
    document.body.appendChild(element);
    root = createRoot(element);
    act(() => root!.render(
      <FilmSetAdaptationConfirm ctx={ctx} nodeId="film" itemId={item.id} clipId={clip.id} writable />
    ));
    return { submitted, clip, item };
  }

  it("确认按钮提交一条携带 expectedAdapterHash 与 expectedHash 的 filmSet.clipPatch", async () => {
    const h = setup();
    const button = [...document.querySelectorAll("button")].find(entry => entry.textContent?.includes("确认动作适配"));
    expect(button).toBeTruthy();
    await act(async () => { (button as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(h.submitted).toHaveLength(1);
    const command = h.submitted[0] as Extract<CanvasCommand, { type: "filmSet.clipPatch" }>;
    expect(command.type).toBe("filmSet.clipPatch");
    expect(command.clipId).toBe(h.clip.id);
    expect(command.op).toMatchObject({ kind: "confirm-adaptation", itemId: h.item.id, expectedAdapterHash: filmSetItemAdapterHash(h.item) });
    // expectedHash 必须来自与组件相同的当前片段权威读取（解码后的规范化集合）。
    const canvas = woohaa3CanvasStore.getState().canvas!;
    const decoded = decodeFilmSetNodeData(canvas.nodeData["film"]);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const clips = filmSetAnimationsOf(decoded.value);
    const expected = filmSetClipPrecondition(clips, h.clip.id, command.op);
    expect(command.expectedHash).toBe(expected);
  });
});
