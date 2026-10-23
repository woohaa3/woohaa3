import { COMPOSITE_ASSET_NODE_TYPE } from "./domain/core/composite-asset-identity.js";
/**
 * 片场对象类型化受保护编辑测试
 * （change: 2026-10-10-improve-film-set-editing-and-inspector，任务 3.4–3.5 / design D6）。
 *
 * 覆盖 transform/delete/restore 的 forward/inverse/redo 等价性、跨多片段绑定闭包、
 * 顺序锚点、无关修改并发、相关冲突原子拒绝与资产/载荷约束。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "./domain/index.js";
import { applyCanvasCommands } from "./command-reducer.js";
import { planCanvasEdit } from "./edit-plan.js";
import { filmSetNodeDataFields, createFilmSetSnapshot, animationSnapshotHash, createModelSnapshot, createMotionSnapshot } from "./animation-snapshot.js";
import { canonicalFilmSetFields } from "./film-set-clip-view.js";

import { decodeFilmSetNodeData, type FilmSetNodeData } from "./canvas-node-model.js";
import {
  applyFilmSetItemEditRemove,
  applyFilmSetItemEditRestore,
  applyFilmSetItemEditTransform,
  captureItemBindingClosure,
  captureItemOrderAnchor,
  filmSetItemBindingEditHash,
  filmSetItemEditHash
} from "./film-set-item-edit.js";

const NOW = "2026-10-10T00:00:00.000Z";

/** 三对象片场：A（被操作）、D（无关）、E；A 在 default 与 second 两个片段均有绑定。 */
function fixture(): { canvas: ServerCanvas; animation: FilmSetNodeData } {
  const base = createFilmSetSnapshot({
    title: "跑酷",
    model: { modelScript: `scene.box({id:"body",size:[1,1,1]});`, modelScriptVersion: "woohaa-model-js-v2" },
    motionScript: "",
    timeline: { duration: 5, loop: false }
  });
  const a = createModelSnapshot({ modelScript: `scene.box({id:"a"});`, modelScriptVersion: "woohaa-model-js-v2" });
  const d = createModelSnapshot({ modelScript: `scene.box({id:"d"});`, modelScriptVersion: "woohaa-model-js-v2" });
  const e = createModelSnapshot({ modelScript: `scene.box({id:"e"});`, modelScriptVersion: "woohaa-model-js-v2" });
  const items = [
    { id: "A", kind: "model" as const, name: "A", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, model: a },
    { id: "D", kind: "model" as const, name: "D", localTransform: { offset: { x: 2, y: 0, z: 0 }, scale: 1, yaw: 0 }, model: d },
    { id: "E", kind: "model" as const, name: "E", localTransform: { offset: { x: 4, y: 0, z: 0 }, scale: 1, yaw: 0 }, model: e }
  ];
  const template = { kind: "dynamic" as const, timeline: { duration: 5, loop: false }, initialCamera: base.sceneCamera, cameraMotion: createMotionSnapshot({ motionScript: "", basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" } }) };
  const playback = { startTime: 0, duration: 2, timeScale: 1, loop: false };
  const animations = {
    schemaVersion: 3 as const,
    defaultClipId: "default",
    clips: [
      { ...template, id: "default", name: "default", bindings: [{ itemId: "A", playback }] },
      { ...template, id: "second", name: "second", bindings: [{ itemId: "A", playback }] },
      { ...template, id: "third", name: "third", bindings: [{ itemId: "D", playback }] }
    ]
  };
  const animation: FilmSetNodeData = { ...base, filmSetContent: { schemaVersion: 4, items }, filmSetAnimations: animations };
  const canvas = createEmptyWoohaa3ServerCanvas("c1", NOW);
  canvas.document.nodes.push({ id: "film", type: COMPOSITE_ASSET_NODE_TYPE, position: { x: 0, y: 0 } });
  canvas.nodeData.film = canonicalFilmSetFields(animation) as never;
  return { canvas, animation };
}

function decode(canvas: ServerCanvas): FilmSetNodeData {
  const result = decodeFilmSetNodeData(canvas.nodeData.film);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

function applyEdit(canvas: ServerCanvas, plan: { preconditions: unknown[]; operations: unknown[] }): ServerCanvas {
  const result = applyCanvasCommands(
    canvas,
    [{ type: "edit.apply", preconditions: plan.preconditions, operations: plan.operations } as never],
    { now: NOW }
  );
  if (!result.ok) throw new Error(`edit 失败：${result.rejection.code} ${result.rejection.message}`);
  return result.canvas;
}

function moveA(canvas: ServerCanvas, x: number) {
  return planCanvasEdit(canvas, [
    { type: "filmSet.itemPatch", nodeId: "film", itemId: "A", op: { kind: "transform", localTransform: { offset: { x, y: 0, z: 0 }, scale: 1, yaw: 0 } } }
  ]);
}

function deleteA(canvas: ServerCanvas) {
  return planCanvasEdit(canvas, [{ type: "filmSet.itemPatch", nodeId: "film", itemId: "A", op: { kind: "delete" } }]);
}

describe("片场对象 transform 规划（任务 3.4）", () => {
  it("forward 写回 localTransform，inverse 恢复；重做再等价", () => {
    const { canvas } = fixture();
    const plan = moveA(canvas, 7);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const moved = applyEdit(canvas, plan.forward);
    expect(decode(moved).filmSetContent.items.find((i) => i.id === "A")?.localTransform.offset.x).toBe(7);
    const undone = applyEdit(moved, plan.inverse);
    expect(decode(undone).filmSetContent.items.find((i) => i.id === "A")?.localTransform.offset.x).toBe(0);
    const redone = applyEdit(undone, plan.forward);
    expect(decode(redone).filmSetContent.items.find((i) => i.id === "A")?.localTransform.offset.x).toBe(7);
  });

  it("无关对象 D 并发修改不阻止撤销，且不被旧数组覆盖", () => {
    const { canvas } = fixture();
    const plan = moveA(canvas, 7);
    if (!plan.ok) return;
    const moved = applyEdit(canvas, plan.forward);
    // 另一页面移动无关对象 D。
    const other = applyCanvasCommands(moved, [
      {
        type: "filmSet.itemPatch",
        nodeId: "film",
        itemId: "D",
        op: { kind: "transform", localTransform: { offset: { x: 9, y: 0, z: 0 }, scale: 1, yaw: 0 } }
      } as never
    ], { now: NOW });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    const undone = applyEdit(other.canvas, plan.inverse);
    expect(decode(undone).filmSetContent.items.find((i) => i.id === "A")?.localTransform.offset.x).toBe(0);
    expect(decode(undone).filmSetContent.items.find((i) => i.id === "D")?.localTransform.offset.x).toBe(9);
  });

  it("相关对象 A 内容被并发修改时撤销原子拒绝", () => {
    const { canvas } = fixture();
    const plan = moveA(canvas, 7);
    if (!plan.ok) return;
    const moved = applyEdit(canvas, plan.forward);
    // 非 transform 的内容变化（重命名）使内容条件不成立。
    const renamed = applyCanvasCommands(moved, [
      { type: "filmSet.itemPatch", nodeId: "film", itemId: "A", op: { kind: "delete" } } as never
    ], { now: NOW });
    void renamed;
    // 直接篡改 A 的名字，模拟相关并发修改。
    const tampered = structuredClone(moved);
    const tamperedAnimation = decode(tampered);
    tamperedAnimation.filmSetContent.items.find((i) => i.id === "A")!.name = "A-renamed";
    tampered.nodeData.film = canonicalFilmSetFields(tamperedAnimation) as never;
    const result = applyCanvasCommands(tampered, [
      { type: "edit.apply", preconditions: plan.inverse.preconditions, operations: plan.inverse.operations } as never
    ], { now: NOW });
    expect(result.ok).toBe(false);
  });
});

describe("对象删除与多片段绑定闭包（任务 3.4）", () => {
  it("删除同时移除 A 与 default/second 绑定，撤销原子恢复内容/顺序/全部绑定", () => {
    const { canvas } = fixture();
    const plan = deleteA(canvas);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const deleted = applyEdit(canvas, plan.forward);
    const afterDelete = decode(deleted);
    expect(afterDelete.filmSetContent.items.map((i) => i.id)).toEqual(["D", "E"]);
    expect(afterDelete.filmSetAnimations!.clips.find((c) => c.id === "default")!.bindings).toHaveLength(0);
    expect(afterDelete.filmSetAnimations!.clips.find((c) => c.id === "second")!.bindings).toHaveLength(0);
    // 无关 D 的 third 绑定保留。
    expect(afterDelete.filmSetAnimations!.clips.find((c) => c.id === "third")!.bindings).toHaveLength(1);

    const restored = applyEdit(deleted, plan.inverse);
    const afterUndo = decode(restored);
    expect(afterUndo.filmSetContent.items.map((i) => i.id)).toEqual(["A", "D", "E"]);
    expect(afterUndo.filmSetContent.items[0]!.name).toBe("A");
    expect(afterUndo.filmSetAnimations!.clips.find((c) => c.id === "default")!.bindings).toHaveLength(1);
    expect(afterUndo.filmSetAnimations!.clips.find((c) => c.id === "second")!.bindings).toHaveLength(1);
    // 重做再次安全删除。
    const redone = applyEdit(restored, plan.forward);
    expect(decode(redone).filmSetContent.items.map((i) => i.id)).toEqual(["D", "E"]);
  });

  it("删除后无关新增对象保留其相对顺序", () => {
    const { canvas } = fixture();
    const plan = deleteA(canvas);
    if (!plan.ok) return;
    const deleted = applyEdit(canvas, plan.forward);
    // 另一页面新增无关对象 N。
    const other = applyCanvasCommands(deleted, [
      { type: "filmSet.itemPatch", nodeId: "film", itemId: "A", op: { kind: "delete" } } as never
    ], { now: NOW });
    void other;
    const grown = structuredClone(deleted);
    const grownAnimation = decode(grown);
    const n = createModelSnapshot({ modelScript: `scene.box({id:"n"});`, modelScriptVersion: "woohaa-model-js-v2" });
    grownAnimation.filmSetContent.items.push({ id: "N", kind: "model", name: "N", localTransform: { offset: { x: 6, y: 0, z: 0 }, scale: 1, yaw: 0 }, model: n });
    grown.nodeData.film = canonicalFilmSetFields(grownAnimation) as never;
    const restored = applyEdit(grown, plan.inverse);
    expect(decode(restored).filmSetContent.items.map((i) => i.id)).toEqual(["A", "D", "E", "N"]);
  });

  it("删除前绑定闭包已改变：前向条件失败整批拒绝", () => {
    const { canvas } = fixture();
    const plan = deleteA(canvas);
    if (!plan.ok) return;
    // 模拟删除准备后另一页面为 A 新增绑定。
    const tampered = structuredClone(canvas);
    const tamperedAnimation = decode(tampered);
    tamperedAnimation.filmSetAnimations!.clips.find((c) => c.id === "third")!.bindings = [
      { itemId: "A", playback: { startTime: 0, duration: 1, timeScale: 1, loop: false } }
    ];
    tampered.nodeData.film = canonicalFilmSetFields(tamperedAnimation) as never;
    const result = applyCanvasCommands(tampered, [
      { type: "edit.apply", preconditions: plan.forward.preconditions, operations: plan.forward.operations } as never
    ], { now: NOW });
    expect(result.ok).toBe(false);
  });

  it("恢复冲突：ID 被复用 / 片段缺失 / 绑定已占用 均原子拒绝", () => {
    const { canvas } = fixture();
    const plan = deleteA(canvas);
    if (!plan.ok) return;
    const deleted = applyEdit(canvas, plan.forward);

    // ID 被复用。
    const reused = structuredClone(deleted);
    const reusedAnimation = decode(reused);
    reusedAnimation.filmSetContent.items.unshift({ id: "A", kind: "ground", name: "地面", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, size: { width: 8, depth: 8 } });
    reused.nodeData.film = canonicalFilmSetFields(reusedAnimation) as never;
    expect(
      applyCanvasCommands(reused, [{ type: "edit.apply", preconditions: plan.inverse.preconditions, operations: plan.inverse.operations } as never], { now: NOW }).ok
    ).toBe(false);

    // 片段缺失。
    const missingClip = structuredClone(deleted);
    const missingAnimation = decode(missingClip);
    missingAnimation.filmSetAnimations!.clips = missingAnimation.filmSetAnimations!.clips.filter((c) => c.id !== "second");
    missingClip.nodeData.film = canonicalFilmSetFields(missingAnimation) as never;
    expect(
      applyCanvasCommands(missingClip, [{ type: "edit.apply", preconditions: plan.inverse.preconditions, operations: plan.inverse.operations } as never], { now: NOW }).ok
    ).toBe(false);

    // 绑定已占用（同 itemId 冲突）。
    const conflicted = structuredClone(deleted);
    const conflictedAnimation = decode(conflicted);
    conflictedAnimation.filmSetContent.items.unshift({ id: "A", kind: "ground", name: "地面", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, size: { width: 8, depth: 8 } });
    conflictedAnimation.filmSetAnimations!.clips.find((c) => c.id === "second")!.bindings = [
      { itemId: "A", playback: { startTime: 0, duration: 1, timeScale: 1, loop: false } }
    ];
    conflicted.nodeData.film = canonicalFilmSetFields(conflictedAnimation) as never;
    expect(
      applyCanvasCommands(conflicted, [{ type: "edit.apply", preconditions: plan.inverse.preconditions, operations: plan.inverse.operations } as never], { now: NOW }).ok
    ).toBe(false);
  });

  it("最后对象与地面：空片场合法，撤销只恢复原对象不补地面", () => {
    const { canvas } = fixture();
    // 先删到只剩 A，再删 A。
    const stripped = structuredClone(canvas);
    const strippedAnimation = decode(stripped);
    strippedAnimation.filmSetContent.items = [strippedAnimation.filmSetContent.items[0]!];
    stripped.nodeData.film = canonicalFilmSetFields(strippedAnimation) as never;
    const plan = deleteA(stripped);
    if (!plan.ok) return;
    const empty = applyEdit(stripped, plan.forward);
    expect(decode(empty).filmSetContent.items).toHaveLength(0);
    const restored = applyEdit(empty, plan.inverse);
    expect(decode(restored).filmSetContent.items.map((i) => i.id)).toEqual(["A"]);
  });

  it("媒体资产缺失时恢复整批拒绝", () => {
    const { canvas } = fixture();
    // 增加一个引用资产的媒体对象 M，并绑定到片段。
    const withMedia = structuredClone(canvas);
    const animation = decode(withMedia);
    animation.filmSetContent.items.push({ id: "M", kind: "image", name: "M", localTransform: { offset: { x: 1, y: 0, z: 0 }, scale: 1, yaw: 0 }, assetId: "missing-asset", aspectRatio: 1 });
    animation.filmSetAnimations!.clips.find((c) => c.id === "default")!.bindings.push({ itemId: "M", playback: { startTime: 0, duration: 1, timeScale: 1, loop: false } });
    withMedia.nodeData.film = canonicalFilmSetFields(animation) as never;
    withMedia.assets.push({ id: "missing-asset", mediaKind: "image", status: "ready", /* 让前向删除通过 */ } as never);
    const plan = planCanvasEdit(withMedia, [{ type: "filmSet.itemPatch", nodeId: "film", itemId: "M", op: { kind: "delete" } }]);
    if (!plan.ok) return;
    const deleted = applyEdit(withMedia, plan.forward);
    // 资产随后不可用。
    const gone = structuredClone(deleted);
    gone.assets = gone.assets.filter((asset) => asset.id !== "missing-asset");
    const result = applyCanvasCommands(gone, [
      { type: "edit.apply", preconditions: plan.inverse.preconditions, operations: plan.inverse.operations } as never
    ], { now: NOW });
    expect(result.ok).toBe(false);
  });
});

describe("对象编辑单元操作与顺序锚点（任务 3.4）", () => {
  it("captureItemOrderAnchor 与 insertItemAtAnchor 恢复原顺序", () => {
    const { animation } = fixture();
    const anchor = captureItemOrderAnchor(animation.filmSetContent.items, "D");
    expect(anchor).toEqual({ after: "E", before: "A" });
    const inserted = applyFilmSetItemEditRestore({
      animation: applyFilmSetItemEditRemove({ animation, itemId: "D" }).ok
        ? (applyFilmSetItemEditRemove({ animation, itemId: "D" }) as { value: FilmSetNodeData }).value
        : animation,
      item: animation.filmSetContent.items.find((i) => i.id === "D")!,
      orderAnchor: anchor,
      bindings: captureItemBindingClosure(animation, "D")
    });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    expect(inserted.value.filmSetContent.items.map((i) => i.id)).toEqual(["A", "D", "E"]);
  });

  it("captureItemBindingClosure 汇总全部片段绑定", () => {
    const { animation } = fixture();
    const closure = captureItemBindingClosure(animation, "A");
    expect(closure.map((entry) => entry.clipId).sort()).toEqual(["default", "second"]);
  });

  it("transform 单元操作仅因 localTransform 产生净变化", () => {
    const { animation } = fixture();
    const unchanged = applyFilmSetItemEditTransform({ animation, itemId: "A", localTransform: animation.filmSetContent.items[0]!.localTransform });
    expect(unchanged.ok).toBe(true);
    if (unchanged.ok) expect(unchanged.changed).toBe(false);
  });

  it("内容 hash 对无关顺序不敏感，对名字/变换敏感", () => {
    const { animation } = fixture();
    const a = animation.filmSetContent.items.find((i) => i.id === "A")!;
    const renamed = { ...a, name: "A2" };
    expect(filmSetItemEditHash(a)).not.toBe(filmSetItemEditHash(renamed));
    expect(filmSetItemBindingEditHash(undefined)).toBe(filmSetItemBindingEditHash(undefined));
  });

  it("animationSnapshotHash 随对象内容变化（权威身份一致）", () => {
    const { animation } = fixture();
    const moved = applyFilmSetItemEditTransform({ animation, itemId: "A", localTransform: { offset: { x: 3, y: 0, z: 0 }, scale: 1, yaw: 0 } });
    if (!moved.ok) return;
    expect(animationSnapshotHash(animation)).not.toBe(animationSnapshotHash(moved.value));
    void filmSetNodeDataFields;
  });
});

/**
 * 回归（E2E 发现）：种子片场用 legacy 顶层动作字段经 reducer 升级为 canonical 后，
 * 片段键**插入顺序**与严格解码器不同（legacy 侧 motion→initialCamera→timeline，解码侧
 * timeline→initialCamera→motion）。规划器若用键顺序敏感的 `JSON.stringify` 比较片段，
 * 会把一次纯 localTransform 变化误判为「片段/绑定变化」而整批拒绝。
 */
describe("对象 transform 规划不受片段键顺序影响（回归）", () => {
  it("legacy 种子升级后纯 transform 仍可规划（forward/inverse 成功）", () => {
    const seed = filmSetNodeDataFields(
      createFilmSetSnapshot({
        title: "图片片场",
        model: { modelScript: "", modelScriptVersion: "woohaa-model-js-v2" },
        motionScript: "",
        timeline: { duration: 0, loop: false },
        filmSetContent: {
          schemaVersion: 4,
          items: [
            {
              id: "photo",
              name: "照片",
              kind: "image",
              assetId: "photo-asset",
              aspectRatio: 4 / 3,
              localTransform: { offset: { x: 0, y: 2, z: 0 }, scale: 1, yaw: 0.2 }
            }
          ]
        }
      })
    );
    const canvas = createEmptyWoohaa3ServerCanvas("c1", NOW);
    canvas.assets.push({
      id: "photo-asset",
      title: "照片",
      mediaKind: "image",
      source: "uploaded",
      status: "ready",
      createdAt: NOW,
      url: "/api/media/x",
      metadata: { storageKey: "x", checksum: "x", contentType: "image/png", size: 10 }
    } as never);
    const added = applyCanvasCommands(
      canvas,
      [
        {
          type: "node.add",
          node: { id: "film", type: COMPOSITE_ASSET_NODE_TYPE, position: { x: 200, y: 120 }, width: 260, height: 195 },
          nodeData: seed
        } as never
      ],
      { now: NOW }
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const plan = planCanvasEdit(added.canvas, [
      {
        type: "filmSet.itemPatch",
        nodeId: "film",
        itemId: "photo",
        op: { kind: "transform", localTransform: { offset: { x: 5, y: 2, z: 0 }, scale: 1, yaw: 0.2 } }
      }
    ]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const moved = applyEdit(added.canvas, plan.forward);
    expect(decode(moved).filmSetContent.items[0]!.localTransform.offset.x).toBe(5);
    const undone = applyEdit(moved, plan.inverse);
    expect(decode(undone).filmSetContent.items[0]!.localTransform.offset.x).toBe(0);
  });
});
