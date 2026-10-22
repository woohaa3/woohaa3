/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { canonicalFilmSetFields, createFilmSetSnapshot, createEmptyWoohaa3ServerCanvas, createModel3DNodeData, model3DNodeDataFields } from "@woohaa3/contracts";
import { extendFilmSetDrop } from "../src/frontend/drop.js";
import type { FilmSetContext } from "../src/frontend/context.js";

type DropInput = { canvas: ReturnType<typeof createEmptyWoohaa3ServerCanvas>; targetNodeId: string; sourceNodeIds: readonly string[]; point: { x: number; y: number } };
type Contribution = {
  onDrop(input: DropInput): boolean;
  acceptsSources(input: { canvas: DropInput["canvas"]; targetNodeId: string; sourceNodeIds: readonly string[] }): boolean;
};
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.innerHTML = ""; });
function harness(writable: boolean, accepted: boolean) {
  const canvas = createEmptyWoohaa3ServerCanvas("drop-canvas");
  canvas.document.nodes = [
    { id: "film", type: "composite-asset", position: { x: 0, y: 0 }, width: 260, height: 195 },
    { id: "model", type: "model3d", position: { x: 400, y: 0 } },
    { id: "image", type: "image", position: { x: 700, y: 0 } },
    { id: "text", type: "text", position: { x: 800, y: 0 } }
  ];
  canvas.nodeData.film = canonicalFilmSetFields(createFilmSetSnapshot({ title: "", timeline: { duration: 0, loop: false } })) as never;
  canvas.nodeData.model = model3DNodeDataFields(createModel3DNodeData({ title: "", model: { modelScript: "scene.box({id:'part'});", modelScriptVersion: "woohaa-model-js-v2" } })) as never;
  let target: Contribution | undefined;
  let submits = 0;
  let removed = false;
  const ctx = {
    slots: { register: (_slot: string, contribution: Contribution) => { target = contribution; return () => { removed = true; }; } },
    canvasSession: { isWritable: () => writable, submitCommands: () => { submits++; return accepted ? { ok: true, handle: { settled: Promise.resolve({ state: "committed", error: null }) } } : { ok: false, reason: "来源已变化" }; } }
  } as unknown as FilmSetContext;
  dispose = extendFilmSetDrop(ctx);
  return {
    canvas,
    contribution: () => target!,
    drop: (source: string) => target!.onDrop({ canvas, targetNodeId: "film", sourceNodeIds: [source], point: { x: 10, y: 10 } }),
    accepts: (...sources: string[]) => target!.acceptsSources({ canvas, targetNodeId: "film", sourceNodeIds: sources }),
    submits: () => submits,
    removed: () => removed
  };
}
describe("片场复制拖入公开 contribution", () => {
  it("成功提交一次，完成回执后清空反馈", async () => {
    const h = harness(true, true);
    expect(h.drop("model")).toBe(true);
    await Promise.resolve();
    expect(h.submits()).toBe(1);
    expect(document.getElementById("film-set-drop-feedback")?.textContent ?? "").toBe("");
  });
  it("提交拒绝被消费并显示失败", () => {
    const h = harness(true, false);
    expect(h.drop("model")).toBe(true);
    expect(h.submits()).toBe(1);
    expect(document.getElementById("film-set-drop-feedback")?.textContent).toContain("导入失败");
  });
  it("只读和不支持的素材被消费且不提交", () => {
    const h = harness(false, true);
    expect(h.drop("model")).toBe(true);
    expect(h.drop("text")).toBe(true);
    expect(h.submits()).toBe(0);
  });
  it("图片/视频不被接收：拖动提示不点亮，释放仍消费为失败并回位", () => {
    const h = harness(true, true);
    // 拖动提示判定：只有普通模型被接收。
    expect(h.accepts("model")).toBe(true);
    expect(h.accepts("image")).toBe(false);
    expect(h.accepts("model", "image")).toBe(false);
    // 释放：整批拒绝，不提交、来源回位（onDrop 返回 true 表示已消费）。
    expect(h.drop("image")).toBe(true);
    expect(h.submits()).toBe(0);
    expect(document.getElementById("film-set-drop-feedback")?.textContent).toContain("仅普通模型可以拖入片场");
  });
  it("释放时移除 contribution 与反馈", () => {
    const h = harness(false, true);
    h.drop("model");
    dispose!(); dispose = undefined;
    expect(h.removed()).toBe(true);
    expect(document.getElementById("film-set-drop-feedback")).toBeNull();
  });
});
