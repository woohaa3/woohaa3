import { ManagedNodeLifecycleRegistry } from "@woohaa3/contracts";
import { testManagedLifecycle, testManagedOwner } from "../../../../../../test-support/managed-test-extension.js";
import { applyCanvasCommands } from "../../../../../../test-support/managed-shot-commands.js";
/**
 * 剪贴板载荷与粘贴规划（change: align-godot-canvas-interactions，任务 4.1 / 4.3 / 4.4）。
 */
import { describe, expect, it } from "vitest";
import {
  canvasPointToGround,
  executeWorldAnimationScript,
  createEmptyWoohaa3ServerCanvas,
  createWoohaa3CanvasNode,
  toWoohaa3CanvasDocument,
  managedNodeRelationOf,
  type SceneAreaData,
  type WorldInstanceData,
  type ServerCanvas,
  type StoredAsset
} from "@woohaa3/contracts";
import { buildCanvasCopyPayload, parseCanvasCopyPayload, serializeCanvasCopyPayload } from "./payload.js";
import { checkPasteReferences, planCanvasPaste as planPaste } from "./planner.js";
const planCanvasPaste = (options: Parameters<typeof planPaste>[0]) => planPaste(options);

const NOW = "2026-09-24T00:00:00.000Z";

function animatedWorldFixture(): ServerCanvas {
  const result = applyCanvasCommands(createEmptyWoohaa3ServerCanvas("source-world", NOW), [
    { type: "node.add", node: { id: "actor", type: "model3d" }, nodeData: { sharedWorldInstance: {
      kind: "world-instance", version: "shared-world-v1", instanceId: "actor-instance",
      transform: { version: "shared-world-v1", position: { u: 1, v: 2, h: 3 }, rotation: [0, 0, 0, 1], scale: 1 }
    } } },
    { type: "node.add", node: { id: "area", type: "scene-area" }, nodeData: { sceneArea: {
      kind: "scene-area", version: "shared-world-v1", areaId: "area-id", scopeVersion: "scope-1",
      bounds: { min: { u: -4, v: -4 }, max: { u: 4, v: 4 } },
      animationScript: {
        script: [
          'motion.instance.tween("actor-instance", { property: "position", startTime: 0, endTime: 5, from: [1, 2, 3], to: [4, 3, 3], easing: "easeOut" });',
          'motion.instance.tween("actor-instance", { property: "rotation", startTime: 0, endTime: 5, from: [0, 90, 0], to: [0, 180, 0], easing: "linear" });',
          'motion.instance.tween("actor-instance", { property: "scale", startTime: 0, endTime: 5, from: [1], to: [2], easing: "linear" });'
        ].join("\n"),
        scriptLanguage: "javascript",
        scriptVersion: "woohaa-world-animation-js-v2",
        revision: 1,
        sourceHash: "hash-animated",
        duration: 5,
        loop: true
      }
    } } }
  ] as never, { now: NOW });
  if (!result.ok) throw Error(JSON.stringify(result.rejection));
  return result.canvas;
}

it("round-trips world nodes without card positions while rejecting ordinary or invalid unplaced nodes", () => {
  const payload = buildCanvasCopyPayload(animatedWorldFixture(), ["area", "actor"])!;
  expect(payload.nodes.every(node => node.position === undefined)).toBe(true);
  expect(parseCanvasCopyPayload(serializeCanvasCopyPayload(payload))).toEqual(payload);
  const ordinary = { ...payload, nodes: [{ id: "text", type: "text" }], nodeData: {} };
  expect(parseCanvasCopyPayload(JSON.stringify(ordinary))).toBeNull();
  expect(parseCanvasCopyPayload(JSON.stringify({ ...payload, nodeData: {} }))).toBeNull();
  expect(parseCanvasCopyPayload(JSON.stringify({ ...payload, nodes: payload.nodes.map(node => ({ ...node, position: null })) }))).toBeNull();
});

it.each(["same-canvas", "cross-canvas"])("copies a complete animated collection safely in %s", destination => {
  const source = animatedWorldFixture();
  const before = JSON.parse(JSON.stringify(source));
  const payload = parseCanvasCopyPayload(serializeCanvasCopyPayload(buildCanvasCopyPayload(source, ["area", "actor"])!))!;
  const canvas = destination === "same-canvas" ? source : createEmptyWoohaa3ServerCanvas("other", NOW);
  const plan = planCanvasPaste({ canvas, payload, viewport: { x: 0, y: 0, zoom: 1 },
    anchor: { kind: "point", position: { x: 600, y: 400 } }, createId: (prefix, index) => `${prefix}-copy-${index}` })!;
  expect(plan).not.toBeNull();
  const result = applyCanvasCommands(canvas, plan.commands, { now: NOW });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  const actor = result.canvas.nodeData["model3d-copy-0"]!.sharedWorldInstance as unknown as WorldInstanceData;
  const area = result.canvas.nodeData["scene-area-copy-1"]!.sceneArea as unknown as SceneAreaData;
  const u = actor.transform.position.u - 1, v = actor.transform.position.v - 2;
  expect(area.animationScript!.duration).toBe(5);
  expect(area.animationScript!.loop).toBe(true);
  const compiled = executeWorldAnimationScript(area.animationScript!.script, { duration: 5, loop: true });
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;
  expect(compiled.ir.instanceTracks.map(track => track.targetId)).toEqual([actor.instanceId, actor.instanceId, actor.instanceId]);
  const position = compiled.ir.instanceTracks.find(track => track.property === "position")!;
  // Position tracks are area-relative; the copy moves the origin, not the track.
  expect(position.from).toEqual([1, 2, 3]);
  expect(position.to).toEqual([4, 3, 3]);
  expect(area.animationOrigin).toEqual({ u, v });
  expect(compiled.ir.instanceTracks.find(track => track.property === "rotation")!.from).toEqual([0, 90, 0]);
  expect(compiled.ir.instanceTracks.find(track => track.property === "scale")!.to).toEqual([2]);
  expect(area.bounds.min).toEqual({ u: -4 + u, v: -4 + v });
  expect(area.bounds.max).toEqual({ u: 4 + u, v: 4 + v });
  expect(result.canvas.document.nodes.filter(node => plan.newNodeIds.includes(node.id)).every(node => node.position === undefined)).toBe(true);
  expect(source).toEqual(before);
  const refusals: string[] = [];
  expect(planCanvasPaste({ canvas, payload: buildCanvasCopyPayload(source, ["area"])!, viewport: { x: 0, y: 0, zoom: 1 }, anchor: null,
    onRefusal: message => refusals.push(message) })).toBeNull();
  expect(refusals[0]).toContain("动画对象");
});

it("pastes a world-only film set under the pointer instead of offsetting by its original ground position", () => {
  const created = applyCanvasCommands(createEmptyWoohaa3ServerCanvas("world", NOW), [
    { type: "node.add", node: { id: "actor", type: "model3d" }, nodeData: { sharedWorldInstance: {
      kind: "world-instance", version: "shared-world-v1", instanceId: "actor-instance",
      transform: { version: "shared-world-v1", position: { u: 101, v: 52, h: 3 }, rotation: [0, 0, 0, 1], scale: 1 }
    } } },
    { type: "node.add", node: { id: "area", type: "scene-area" }, nodeData: { sceneArea: {
      kind: "scene-area", version: "shared-world-v1", areaId: "area-id", scopeVersion: "1",
      bounds: { min: { u: 100, v: 50 }, max: { u: 104, v: 54 } }
    } } }
  ] as never, { now: NOW });
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  const payload = buildCanvasCopyPayload(created.canvas, ["actor", "area"])!;
  const anchor = { x: 640, y: 360 };
  const target = canvasPointToGround(anchor);
  const plan = planCanvasPaste({ canvas: created.canvas, payload, viewport: { x: 0, y: 0, zoom: 1 },
    anchor: { kind: "point", position: anchor }, createId: (prefix, index) => `${prefix}-copy-${index}` })!;
  const pasted = applyCanvasCommands(created.canvas, plan.commands, { now: NOW });
  expect(pasted.ok).toBe(true);
  if (!pasted.ok) return;
  const areaNode = pasted.canvas.document.nodes.find(node => plan.newNodeIds.includes(node.id) && node.type === "scene-area")!;
  const actorNode = pasted.canvas.document.nodes.find(node => plan.newNodeIds.includes(node.id) && node.type === "model3d")!;
  const area = pasted.canvas.nodeData[areaNode.id]!.sceneArea as unknown as SceneAreaData;
  const actor = pasted.canvas.nodeData[actorNode.id]!.sharedWorldInstance as unknown as WorldInstanceData;
  // 导演区中心正好落在鼠标下的地面点；模型保持相对导演区中心的偏移与高度。
  expect((area.bounds.min.u + area.bounds.max.u) / 2).toBeCloseTo(target.u, 10);
  expect((area.bounds.min.v + area.bounds.max.v) / 2).toBeCloseTo(target.v, 10);
  expect(actor.transform.position.u).toBeCloseTo(target.u - 1, 10);
  expect(actor.transform.position.v).toBeCloseTo(target.v, 10);
  expect(actor.transform.position.h).toBe(3);
  expect(area.bounds.max.u - area.bounds.min.u).toBe(4);
  expect(area.bounds.max.v - area.bounds.min.v).toBe(4);
});

it("pastes a standalone world model at the pointer ground position", () => {
  const created = applyCanvasCommands(createEmptyWoohaa3ServerCanvas("world", NOW), [
    { type: "node.add", node: { id: "actor", type: "model3d" }, nodeData: { sharedWorldInstance: {
      kind: "world-instance", version: "shared-world-v1", instanceId: "actor-instance",
      transform: { version: "shared-world-v1", position: { u: 5, v: 7, h: 1.5 }, rotation: [0, 0, 0, 1], scale: 1 }
    } } }
  ] as never, { now: NOW });
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  const payload = buildCanvasCopyPayload(created.canvas, ["actor"])!;
  const anchor = { x: 320, y: 240 };
  const target = canvasPointToGround(anchor);
  const plan = planCanvasPaste({ canvas: created.canvas, payload, viewport: { x: 0, y: 0, zoom: 1 },
    anchor: { kind: "point", position: anchor }, createId: (prefix, index) => `${prefix}-copy-${index}` })!;
  const pasted = applyCanvasCommands(created.canvas, plan.commands, { now: NOW });
  expect(pasted.ok).toBe(true);
  if (!pasted.ok) return;
  const actor = pasted.canvas.nodeData[plan.newNodeIds[0]!]!.sharedWorldInstance as unknown as WorldInstanceData;
  expect(actor.transform.position.u).toBeCloseTo(target.u, 10);
  expect(actor.transform.position.v).toBeCloseTo(target.v, 10);
  expect(actor.transform.position.h).toBe(1.5);
});

it("keeps a standalone camera pose while its card lands at the pointer", () => {
  const camera = {
    kind: "world-camera", version: "shared-world-v1", cameraId: "c", settingsVersion: "1",
    position: { u: 10, v: 20, h: 1 }, rotation: [0, 0, 0, 1],
    projection: { kind: "perspective", verticalFovRadians: 1, nearMeters: 0.1, farMeters: 100 },
    captureMode: { kind: "static" }, aspect: { width: 16, height: 9 }, boundInstanceId: null
  };
  const created = applyCanvasCommands(createEmptyWoohaa3ServerCanvas("world", NOW), [
    { type: "node.add", node: { id: "cam", type: "world-camera", position: { x: 0, y: 0 } }, nodeData: { worldCamera: camera } }
  ] as never, { now: NOW });
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  const payload = buildCanvasCopyPayload(created.canvas, ["cam"])!;
  const anchor = { x: 500, y: 400 };
  const plan = planCanvasPaste({ canvas: created.canvas, payload, viewport: { x: 0, y: 0, zoom: 1 },
    anchor: { kind: "point", position: anchor }, createId: (prefix, index) => `${prefix}-copy-${index}` })!;
  const pasted = applyCanvasCommands(created.canvas, plan.commands, { now: NOW });
  expect(pasted.ok).toBe(true);
  if (!pasted.ok) return;
  const pastedNode = pasted.canvas.document.nodes.find(node => plan.newNodeIds.includes(node.id))!;
  const pastedCamera = pasted.canvas.nodeData[pastedNode.id]!.worldCamera as unknown as typeof camera;
  // 镜头卡片中心对齐鼠标；没有随世界集合复制时姿态保持原值。
  expect(pastedNode.position!.x + pastedNode.width! / 2).toBe(anchor.x);
  expect(pastedNode.position!.y + pastedNode.height! / 2).toBe(anchor.y);
  expect(pastedCamera.position).toEqual(camera.position);
  expect(pastedCamera.cameraId).toBe("cameraId-copy-0");
});

it("remaps a world collection in the actual paste batch", () => {
  const base = createEmptyWoohaa3ServerCanvas("world", NOW);
  const instance = { kind: "world-instance", version: "shared-world-v1", instanceId: "i", transform: { version: "shared-world-v1", position: { u: 1, v: 2, h: 3 }, rotation: [0, 0, 0, 1], scale: 2 } };
  const camera = { kind: "world-camera", version: "shared-world-v1", cameraId: "c", settingsVersion: "1", position: { u: 1, v: 2, h: 4 }, rotation: [0, 0, 0, 1], projection: { kind: "perspective", verticalFovRadians: 1, nearMeters: 0.1, farMeters: 100 }, captureMode: { kind: "static" }, aspect: { width: 16, height: 9 }, boundInstanceId: "i" };
  const original = applyCanvasCommands(base, [
    { type: "node.add", node: { id: "m", type: "model3d", position: { x: 0, y: 0 } }, nodeData: { sharedWorldInstance: instance } },
    { type: "node.add", node: { id: "g", type: "workflow-group-2d", position: { x: 10, y: 0 } }, nodeData: { workflowGroup2d: { kind: "workflow-group-2d", version: "shared-world-v1", groupId: "g", scopeVersion: "1", memberNodeIds: ["m"] } } },
    { type: "node.add", node: { id: "a", type: "scene-area", position: { x: 20, y: 0 } }, nodeData: { sceneArea: { kind: "scene-area", version: "shared-world-v1", areaId: "a", scopeVersion: "1", bounds: { min: { u: 0, v: 0 }, max: { u: 2, v: 2 } } } } },
    { type: "node.add", node: { id: "c", type: "world-camera", position: { x: 30, y: 0 } }, nodeData: { worldCamera: camera } }
  ] as never, { now: NOW });
  expect(original.ok).toBe(true);
  if (!original.ok) return;
  const payload = buildCanvasCopyPayload(original.canvas, ["m", "g", "a", "c"])!;
  const plan = planCanvasPaste({ canvas: original.canvas, payload, viewport: { x: 0, y: 0, zoom: 1 }, anchor: { kind: "point", position: { x: 500, y: 500 } }, createId: (prefix, index) => `new-${prefix}-${index}` })!;
  const result = applyCanvasCommands(original.canvas, plan.commands, { now: NOW });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  const model = result.canvas.nodeData["new-model3d-0"].sharedWorldInstance as typeof instance;
  const copiedCamera = result.canvas.nodeData["new-world-camera-3"].worldCamera as unknown as typeof camera;
  expect(model.instanceId).toBe("new-instanceId-0");
  expect(model.transform.rotation).toEqual(instance.transform.rotation);
  expect(model.transform.scale).toEqual(instance.transform.scale);
  const pastedNode = result.canvas.document.nodes.find(node => node.id === "new-model3d-0")!;
  // 共享世界模型没有卡片坐标；粘贴保留世界高度并只平移水平位置。
  expect(pastedNode.position).toBeUndefined();
  expect(model.transform.position.h).toBe(instance.transform.position.h);
  expect(model.transform.position).not.toEqual(instance.transform.position);
  // 镜头随世界集合一起平移，保持原来的相对取景与高度；只有身份和绑定被重写。
  expect({ u: copiedCamera.position.u - camera.position.u, v: copiedCamera.position.v - camera.position.v })
    .toEqual({ u: model.transform.position.u - instance.transform.position.u, v: model.transform.position.v - instance.transform.position.v });
  expect(copiedCamera.position.h).toBe(camera.position.h);
  expect({ ...copiedCamera, position: camera.position }).toEqual({ ...camera, cameraId: "new-cameraId-3", boundInstanceId: model.instanceId });
  expect(result.canvas.nodeData["new-workflow-group-2d-1"].workflowGroup2d).toMatchObject({ groupId: "new-groupId-1", scopeVersion: "new-scopeVersion-1", memberNodeIds: ["new-model3d-0"] });
  expect(result.canvas.nodeData["new-scene-area-2"].sceneArea).toMatchObject({ areaId: "new-areaId-2", scopeVersion: "new-scopeVersion-2" });
  expect(result.canvas.nodeData.m.sharedWorldInstance).toEqual(instance);
  const missing = buildCanvasCopyPayload(original.canvas, ["c"])!;
  expect(planCanvasPaste({ canvas: original.canvas, payload: missing, viewport: { x: 0, y: 0, zoom: 1 }, anchor: null })).toBeNull();
});

function canvasFixture(): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("canvas-1", NOW);
  const nodes = [
    { ...createWoohaa3CanvasNode("text", { x: 0, y: 0 }, "text-1"), width: 100, height: 50 },
    { ...createWoohaa3CanvasNode("image", { x: 400, y: 0 }, "image-1"), width: 100, height: 50 },
    { ...createWoohaa3CanvasNode("text", { x: 800, y: 0 }, "gen-1"), width: 100, height: 50 }
  ];
  const edges: ServerCanvas["document"]["edges"] = [
    { id: "edge-text-image", source: "text-1", target: "image-1", sourceHandle: null, targetHandle: null, data: { label: "文本" } },
    { id: "edge-image-gen", source: "image-1", target: "gen-1", sourceHandle: null, targetHandle: null, data: {} }
  ];
  return {
    ...base,
    document: toWoohaa3CanvasDocument({ nodes, edges }, NOW),
    nodeData: {
      "text-1": { prompt: "提示词", activeRunId: "run-1", outputAssetId: "asset-1" },
      "image-1": { prompt: "图片" },
      "gen-1": { jsPath: "res://x.js" }
    }
  };
}

describe("复制载荷", () => {
  it("包含选中节点、内部边与清理后的 nodeData", () => {
    const payload = buildCanvasCopyPayload(canvasFixture(), ["text-1", "image-1"]);
    expect(payload).not.toBeNull();
    expect(payload!.nodes.map((node) => node.id)).toEqual(["text-1", "image-1"]);
    expect(payload!.edges.map((edge) => edge.id)).toEqual(["edge-text-image"]);
    // gen-1 未被选中，其入边成为 incomingEdges（源 image-1 在选区，但 image-1 也在选区内 → 内部边）。
    expect(payload!.incomingEdges).toHaveLength(0);
    // 运行态/结果字段被清理，prompt 保留。
    expect(payload!.nodeData["text-1"]).toEqual({ prompt: "提示词" });
    // 本机路径节点不在选区，不出现。
    expect(payload!.nodeData["gen-1"]).toBeUndefined();
  });

  it("扩展选中父节点的后代", () => {
    const canvas = canvasFixture();
    const child = { ...createWoohaa3CanvasNode("text", { x: 0, y: 200 }, "child-1"), parentId: "text-1" };
    canvas.document.nodes.push(child);
    const payload = buildCanvasCopyPayload(canvas, ["text-1"]);
    expect(payload!.nodes.map((node) => node.id).sort()).toEqual(["child-1", "text-1"]);
  });

  it("空选择或全失效选择返回 null", () => {
    expect(buildCanvasCopyPayload(canvasFixture(), [])).toBeNull();
    expect(buildCanvasCopyPayload(canvasFixture(), ["missing"])).toBeNull();
  });

  it("序列化往返是确定性的", () => {
    const payload = buildCanvasCopyPayload(canvasFixture(), ["text-1", "image-1"])!;
    const json = serializeCanvasCopyPayload(payload);
    expect(parseCanvasCopyPayload(json)).toEqual(payload);
  });

  it("普通文本与未知 JSON 不解析为载荷", () => {
    expect(parseCanvasCopyPayload("hello world")).toBeNull();
    expect(parseCanvasCopyPayload('{"foo":1}')).toBeNull();
    expect(parseCanvasCopyPayload("")).toBeNull();
    expect(parseCanvasCopyPayload(null)).toBeNull();
  });

  it("非法内部边（悬空端点）被拒绝解析", () => {
    const bad = {
      format: "infinspire-canvas-copy-v1",
      nodes: [{ id: "a", type: "text", position: { x: 0, y: 0 } }],
      edges: [{ id: "e", source: "a", target: "missing", data: {} }],
      incomingEdges: [],
      nodeData: {}
    };
    expect(parseCanvasCopyPayload(JSON.stringify(bad))).toBeNull();
  });

  /**
   * 上传的图片/视频/音频节点把内容存在 `outputAssetId`（见 `uploadedNodeData`），它是唯一
   * 内容引用而不是任务结果指针。剪掉会让复制出的节点没有内容——用户看到的正是「复制出来
   * 的图片节点是空白」（change: fix-copy-keeps-node-media）。
   */
  it("上传媒体节点复制时保留内容引用并携带资产", () => {
    const canvas = uploadedMediaCanvas();
    const payload = buildCanvasCopyPayload(canvas, ["img-1"]);
    expect(payload).not.toBeNull();
    expect(payload!.nodeData["img-1"]).toMatchObject({
      title: "照片.png",
      outputAssetId: "asset-upload-photo",
      resourceKind: "image",
      taskStatus: "successed"
    });
    // 资产随载荷一起走，粘贴到别的画布仍能解析该引用。
    expect(payload!.assets?.map((asset) => asset.id)).toEqual(["asset-upload-photo"]);
    expect(parseCanvasCopyPayload(serializeCanvasCopyPayload(payload!))).toEqual(payload);
  });

  it("粘贴上传媒体节点后新节点仍引用同一 ready 资产", () => {
    const payload = buildCanvasCopyPayload(uploadedMediaCanvas(), ["img-1"])!;
    const target = createEmptyWoohaa3ServerCanvas("canvas-2", NOW);
    const plan = planCanvasPaste({
      canvas: target,
      payload,
      anchor: { kind: "point", position: { x: 0, y: 0 } },
      viewport: { x: 0, y: 0, zoom: 1 },
      createId: (prefix, index) => `${prefix}-n${index}`
    });
    expect(plan).not.toBeNull();
    const applied = applyCanvasCommands(target, plan!.commands, { now: NOW });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const pasted = applied.canvas.document.nodes.find((node) => node.id !== "img-1")!;
    const data = applied.canvas.nodeData[pasted.id] as { outputAssetId?: string };
    expect(data.outputAssetId).toBe("asset-upload-photo");
    expect(applied.canvas.assets.some((asset) => asset.id === "asset-upload-photo" && asset.status === "ready")).toBe(true);
  });

  it("生成结果资产是稳定内容引用：复制保留 outputAssetId 并携带资产，粘贴后无 active run", () => {
    const base = createEmptyWoohaa3ServerCanvas("canvas-1", NOW);
    const generated: ServerCanvas = {
      ...base,
      document: toWoohaa3CanvasDocument(
        { nodes: [{ ...createWoohaa3CanvasNode("image", { x: 0, y: 0 }, "gen-img"), width: 100, height: 50 }], edges: [] },
        NOW
      ),
      assets: [storedAsset("asset-generated-out", "generated-output/x.png", "image/png", "generated")],
      nodeData: {
        "gen-img": {
          prompt: "画一只猫",
          outputAssetId: "asset-generated-out",
          resourceKind: "image",
          taskStatus: "successed",
          providerTaskId: "provider-1"
        }
      }
    } as unknown as ServerCanvas;
    const payload = buildCanvasCopyPayload(generated, ["gen-img"])!;
    // 已结算的生成结果资产是节点的稳定内容引用：粘贴必须能显示同一张图（不再是任务结果指针）。
    expect(payload.nodeData["gen-img"]).toMatchObject({
      prompt: "画一只猫",
      outputAssetId: "asset-generated-out",
      taskStatus: "successed",
      resourceKind: "image"
    });
    // 结果资产随载荷一起走，粘贴到别的画布仍能解析该引用。
    expect(payload.assets?.map((asset) => asset.id)).toEqual(["asset-generated-out"]);
    // 粘贴后仍是无 active run 的可编辑节点，可继续生成；运行态与 provider 痕迹被剪除。
    expect(payload.nodeData["gen-img"]).not.toHaveProperty("activeRunId");
    expect(payload.nodeData["gen-img"]).not.toHaveProperty("providerTaskId");
  });

  it("运行中的任务结果指针仍被剪除：无 ready 资产可恢复时不保留过期引用", () => {
    const base = createEmptyWoohaa3ServerCanvas("canvas-1", NOW);
    const running: ServerCanvas = {
      ...base,
      document: toWoohaa3CanvasDocument(
        { nodes: [{ ...createWoohaa3CanvasNode("image", { x: 0, y: 0 }, "gen-img"), width: 100, height: 50 }], edges: [] },
        NOW
      ),
      assets: [],
      nodeData: {
        "gen-img": {
          prompt: "画一只猫",
          outputAssetId: "asset-not-in-canvas",
          taskStatus: "processing"
        }
      }
    } as unknown as ServerCanvas;
    const payload = buildCanvasCopyPayload(running, ["gen-img"])!;
    expect(payload.nodeData["gen-img"]).toMatchObject({ prompt: "画一只猫" });
    expect(payload.nodeData["gen-img"]).not.toHaveProperty("outputAssetId");
    expect(payload.assets ?? []).toHaveLength(0);
  });
});

describe("粘贴规划", () => {
  it("重复粘贴生成互不冲突的新 ID", () => {
    const canvas = canvasFixture();
    const payload = buildCanvasCopyPayload(canvas, ["text-1", "image-1"])!;
    const a = planCanvasPaste({ viewport: { x: 0, y: 0, zoom: 1 }, canvas, payload, anchor: { kind: "point", position: { x: 0, y: 0 } } })!;
    const b = planCanvasPaste({ viewport: { x: 0, y: 0, zoom: 1 }, canvas, payload, anchor: { kind: "point", position: { x: 0, y: 0 } } })!;
    expect(a.newNodeIds).not.toEqual(b.newNodeIds);
    expect(a.newEdgeIds).not.toEqual(b.newEdgeIds);
  });

  it("包围盒中心对齐到锚点，多节点相对位置不变", () => {
    const canvas = canvasFixture();
    const payload = buildCanvasCopyPayload(canvas, ["text-1", "image-1"])!;
    const anchor = { x: 1000, y: 500 };
    const plan = planCanvasPaste({ viewport: { x: 0, y: 0, zoom: 1 }, canvas, payload, anchor: { kind: "point", position: anchor } })!;
    const adds = plan.commands.filter((command) => command.type === "node.add") as Array<{ type: "node.add"; node: { id: string; position: { x: number; y: number } } }>;
    const textAdd = adds.find((entry) => entry.node.id === plan.newNodeIds[0])!;
    const imageAdd = adds.find((entry) => entry.node.id === plan.newNodeIds[1])!;
    // 原包围盒：x [0,500]，y [0,50] ⇒ 中心 (250,25)。平移后中心 = anchor。
    const centers = adds.map((entry) => entry.node.position);
    const minX = Math.min(...centers.map((entry) => entry.x));
    const maxX = Math.max(...centers.map((entry) => entry.x)) + 100;
    const minY = Math.min(...centers.map((entry) => entry.y));
    const maxY = Math.max(...centers.map((entry) => entry.y)) + 50;
    expect((minX + maxX) / 2).toBeCloseTo(anchor.x, 6);
    expect((minY + maxY) / 2).toBeCloseTo(anchor.y, 6);
    // 相对位置不变。
    expect(imageAdd.node.position.x - textAdd.node.position.x).toBeCloseTo(400, 6);
  });

  it("失效入边被过滤，有效入边重写 target 为新 ID", () => {
    const canvas = canvasFixture();
    // 复制 image-1 与它到 gen-1 的入边？入边方向：text->image 是入边（源 text 在外部）。
    const payload = buildCanvasCopyPayload(canvas, ["image-1"])!;
    // text-1 仍存在于目标画布 ⇒ 入边保留。
    const plan = planCanvasPaste({ viewport: { x: 0, y: 0, zoom: 1 }, canvas, payload, anchor: { kind: "point", position: { x: 0, y: 0 } } })!;
    const edgeAdds = plan.commands.filter((command) => command.type === "edge.add") as Array<{ type: "edge.add"; edge: { source: string; target: string } }>;
    expect(edgeAdds).toHaveLength(1);
    expect(edgeAdds[0].edge.source).toBe("text-1");
    expect(edgeAdds[0].edge.target).toBe(plan.newNodeIds[0]);

    // 源节点不在目标画布时，入边被过滤。
    const emptyCanvas = createEmptyWoohaa3ServerCanvas("canvas-2", NOW);
    const filtered = planCanvasPaste({ viewport: { x: 0, y: 0, zoom: 1 }, canvas: emptyCanvas, payload, anchor: { kind: "point", position: { x: 0, y: 0 } } })!;
    expect(filtered.commands.filter((command) => command.type === "edge.add")).toHaveLength(0);
  });

  it("命令按依赖排序：node.add 先于 nodeData.patch 与 edge.add", () => {
    const canvas = canvasFixture();
    const payload = buildCanvasCopyPayload(canvas, ["text-1", "image-1"])!;
    const plan = planCanvasPaste({ viewport: { x: 0, y: 0, zoom: 1 }, canvas, payload, anchor: { kind: "point", position: { x: 0, y: 0 } } })!;
    const types = plan.commands.map((command) => command.type);
    const lastNodeAdd = types.lastIndexOf("node.add");
    const firstPatch = types.indexOf("nodeData.patch");
    const firstEdgeAdd = types.indexOf("edge.add");
    expect(firstPatch).toBeGreaterThan(lastNodeAdd);
    expect(firstEdgeAdd).toBeGreaterThan(lastNodeAdd);
  });

  it("空载荷返回 null（无操作，不提交空批次）", () => {
    const canvas = canvasFixture();
    const empty = { format: "infinspire-canvas-copy-v1" as const, nodes: [], edges: [], incomingEdges: [], nodeData: {} };
    expect(planCanvasPaste({ viewport: { x: 0, y: 0, zoom: 1 }, canvas, payload: empty, anchor: null })).toBeNull();
  });

  it("粘贴父子树时扁平化坐标并保留相对布局", () => {
    const base = createEmptyWoohaa3ServerCanvas("canvas-group", NOW);
    const canvas: ServerCanvas = {
      ...base,
      document: {
        ...base.document,
        nodes: [
          // 组离画布原点很远：包围盒若混用局部坐标，粘贴会偏离鼠标同样的距离。
          { id: "g", type: "group", position: { x: 2000, y: 1500 }, width: 400, height: 300 },
          { id: "child", type: "image", parentId: "g", position: { x: 20, y: 30 }, width: 200, height: 100 },
          { id: "inner", type: "group", parentId: "g", position: { x: 40, y: 60 }, width: 300, height: 200 },
          { id: "grandchild", type: "text", parentId: "inner", position: { x: 10, y: 20 }, width: 120, height: 60 }
        ],
        edges: []
      }
    };
    const payload = buildCanvasCopyPayload(canvas, ["g"])!;
    const anchor = { x: 500, y: 500 };
    const plan = planCanvasPaste({
      viewport: { x: 0, y: 0, zoom: 1 },
      canvas,
      payload,
      anchor: { kind: "point", position: anchor },
      createId: (prefix, index) => `${prefix}-${index}`
    })!;
    const adds = plan.commands.filter((command) => command.type === "node.add") as Array<{
      node: { id: string; type: string; position: { x: number; y: number }; width?: number; height?: number; parentId?: string };
    }>;
    const [groupAdd, innerAdd] = adds.filter((command) => command.node.type === "group");
    const childAdd = adds.find((command) => command.node.type === "image")!;
    const grandchildAdd = adds.find((command) => command.node.type === "text")!;
    // 顶层 group 的中心落在锚点上（原 group 中心 (2200,1650)，尺寸 400×300）。
    expect(groupAdd.node.position).toEqual({ x: anchor.x - 200, y: anchor.y - 150 });
    expect(childAdd.node.position).toEqual({ x: 320, y: 380 });
    expect(innerAdd.node.position).toEqual({ x: 340, y: 410 });
    expect(grandchildAdd.node.position).toEqual({ x: 350, y: 430 });
    expect(adds.every(({ node }) => node.parentId === undefined)).toBe(true);
  });

  it("单独复制组内成员：以鼠标为中心，且丢弃已不存在的父级", () => {
    const base = createEmptyWoohaa3ServerCanvas("canvas-member", NOW);
    const canvas: ServerCanvas = {
      ...base,
      document: {
        ...base.document,
        nodes: [
          { id: "g", type: "group", position: { x: 2000, y: 1500 }, width: 400, height: 300 },
          { id: "child", type: "image", parentId: "g", position: { x: 20, y: 30 }, width: 200, height: 100 }
        ],
        edges: []
      }
    };
    const payload = buildCanvasCopyPayload(canvas, ["child"])!;
    const anchor = { x: 800, y: 600 };
    const plan = planCanvasPaste({
      viewport: { x: 0, y: 0, zoom: 1 },
      canvas,
      payload,
      anchor: { kind: "point", position: anchor },
      createId: (prefix, index) => `${prefix}-${index}`
    })!;
    const add = plan.commands.find((command) => command.type === "node.add") as {
      node: { position: { x: number; y: number }; parentId?: string };
    };
    // 成员矩形中心对齐锚点；父级不在载荷内，parentId 不再写入。
    expect(add.node.position).toEqual({ x: anchor.x - 100, y: anchor.y - 50 });
    expect(add.node.parentId).toBeUndefined();
  });
});


/**
 * 图片工程复制回归
 * （编辑扩展工作区，任务 2.4）。
 *
 * 覆盖：复制工程图片节点时一并携带工程对象引用与基线/来源/输出资产；跨画布缺少必要引用
 * 或工程对象不可解析时拒绝粘贴，不留悬空引用；授权跨画布复制全部引用可解析。
 */
const PROJECT_KEY = "sha256-" + "d".repeat(64);
const BASE_KEY = "sha256-" + "a".repeat(64);
const SOURCE_KEY = "sha256-" + "b".repeat(64);
const OUTPUT_KEY = "generation-outputs/" + "c".repeat(64) + ".png";

function storedAsset(
  id: string,
  storageKey: string,
  contentType = "image/png",
  source: StoredAsset["source"] = "uploaded"
): StoredAsset {
  return {
    id,
    title: id,
    mediaKind: "image",
    source,
    status: "ready",
    createdAt: NOW,
    metadata: { storageKey, checksum: storageKey.slice(7, 71), contentType, size: 1024 }
  } as unknown as StoredAsset;
}

/** 上传图片节点：内容只在 `outputAssetId`（见 `uploadedNodeData`）。 */
function uploadedMediaCanvas(): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("canvas-1", NOW);
  return {
    ...base,
    document: toWoohaa3CanvasDocument(
      { nodes: [{ ...createWoohaa3CanvasNode("image", { x: 0, y: 0 }, "img-1"), width: 260, height: 195 }], edges: [] },
      NOW
    ),
    assets: [storedAsset("asset-upload-photo", "uploads/photo.png")],
    nodeData: {
      "img-1": {
        title: "照片.png",
        outputAssetId: "asset-upload-photo",
        resourceKind: "image",
        taskStatus: "successed"
      }
    }
  } as unknown as ServerCanvas;
}

function projectImageCanvas(canvasId = "canvas-1"): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas(canvasId, NOW);
  return {
    ...base,
    revision: 1,
    document: toWoohaa3CanvasDocument(
      {
        nodes: [{ ...createWoohaa3CanvasNode("image", { x: 0, y: 0 }, "image-1"), width: 100, height: 50 }],
        edges: []
      },
      NOW
    ),
    assets: [storedAsset("asset-base", BASE_KEY), storedAsset("asset-src", SOURCE_KEY), storedAsset("asset-out", OUTPUT_KEY)],
    nodeData: {
      "image-1": {
        outputAssetId: "asset-out",
        imageEdit: {
          version: "woohaa-image-project-v1",
          engine: "fixture-editor",
          engineVersion: "fixture-editor-v1",
          formatVersion: 1,
          baseAssetId: "asset-base",
          sourceWidth: 2048,
          sourceHeight: 1536,
          canvasWidth: 800,
          canvasHeight: 600,
          documentContentHash: "0123456789abcdef",
          project: { storageKey: PROJECT_KEY, checksum: "d".repeat(64), contentType: "application/vnd.fixture-project", size: 4096 },
          sourceAssetIds: ["asset-base", "asset-src"]
        }
      }
    }
  } as unknown as ServerCanvas;
}

describe("图片工程复制与跨画布引用（任务 2.4）", () => {
  it("复制载荷携带工程对象引用与基线/来源/输出资产", () => {
    const payload = buildCanvasCopyPayload(projectImageCanvas(), ["image-1"]);
    expect(payload).not.toBeNull();
    expect(payload!.assets?.map((asset) => asset.id).sort()).toEqual(["asset-base", "asset-out", "asset-src"]);
    expect(payload!.projectObjects).toEqual([
      { storageKey: PROJECT_KEY, checksum: "d".repeat(64), contentType: "application/vnd.fixture-project", size: 4096 }
    ]);
    expect(parseCanvasCopyPayload(serializeCanvasCopyPayload(payload!))).toEqual(payload);
  });

  it("授权跨画布复制：资产随载荷登记，所有引用在目标画布可解析", () => {
    const payload = buildCanvasCopyPayload(projectImageCanvas(), ["image-1"])!;
    const target = createEmptyWoohaa3ServerCanvas("canvas-2", NOW);
    const plan = planCanvasPaste({
      canvas: target,
      payload,
      anchor: { kind: "point", position: { x: 0, y: 0 } },
      viewport: { x: 0, y: 0, zoom: 1 },
      createId: (prefix, index) => `${prefix}-n${index}`
    });
    expect(plan).not.toBeNull();
    const upserted = plan!.commands.filter((command) => command.type === "asset.upsert").length;
    expect(upserted).toBe(3);
    const patch = plan!.commands.find((command) => command.type === "nodeData.patch");
    expect((patch as { value: { imageEdit: { project: { storageKey: string } } } }).value.imageEdit.project.storageKey).toBe(PROJECT_KEY);
  });

  it("缺少必要来源资产时拒绝粘贴，不写悬空引用", () => {
    const payload = buildCanvasCopyPayload(projectImageCanvas(), ["image-1"])!;
    // 模拟载荷只带出工程对象、没带来源资产（例如来源对象不可共享）。
    const partial = { ...payload, assets: (payload.assets ?? []).filter((asset) => asset.id === "asset-out") };
    const target = createEmptyWoohaa3ServerCanvas("canvas-2", NOW);
    const refusal = checkPasteReferences({ canvas: target, payload: partial });
    expect(refusal?.code).toBe("project-reference-missing");
    expect(
      planCanvasPaste({
        canvas: target,
        payload: partial,
        anchor: { kind: "point", position: { x: 0, y: 0 } },
        viewport: { x: 0, y: 0, zoom: 1 }
      })
    ).toBeNull();
  });

  it("工程对象在目标画布不可解析时拒绝粘贴", () => {
    const payload = buildCanvasCopyPayload(projectImageCanvas(), ["image-1"])!;
    const target = createEmptyWoohaa3ServerCanvas("canvas-2", NOW);
    const refusal = checkPasteReferences({ canvas: target, payload, unverifiedProjectObjects: [PROJECT_KEY] });
    expect(refusal?.code).toBe("project-object-unverified");
    expect(
      planCanvasPaste({
        canvas: target,
        payload,
        anchor: { kind: "point", position: { x: 0, y: 0 } },
        viewport: { x: 0, y: 0, zoom: 1 },
        unverifiedProjectObjects: [PROJECT_KEY]
      })
    ).toBeNull();
  });

  it("目标画布已有同一资产时不再重复登记（幂等复制）", () => {
    const payload = buildCanvasCopyPayload(projectImageCanvas(), ["image-1"])!;
    const target = {
      ...createEmptyWoohaa3ServerCanvas("canvas-2", NOW),
      assets: [storedAsset("asset-base", BASE_KEY), storedAsset("asset-src", SOURCE_KEY), storedAsset("asset-out", OUTPUT_KEY)]
    } as ServerCanvas;
    const plan = planCanvasPaste({
      canvas: target,
      payload,
      anchor: { kind: "point", position: { x: 0, y: 0 } },
      viewport: { x: 0, y: 0, zoom: 1 }
    });
    expect(plan).not.toBeNull();
    expect(plan!.commands.filter((command) => command.type === "asset.upsert")).toHaveLength(0);
  });

  it("旧载荷（无 projectObjects 字段）仍可解析且不触发检查", () => {
    const payload = buildCanvasCopyPayload(canvasFixture(), ["text-1"])!;
    expect(payload.projectObjects).toBeUndefined();
    const json = JSON.parse(serializeCanvasCopyPayload(payload)) as Record<string, unknown>;
    delete json.projectObjects;
    expect(parseCanvasCopyPayload(JSON.stringify(json))).not.toBeNull();
    expect(checkPasteReferences({ canvas: createEmptyWoohaa3ServerCanvas("canvas-2", NOW), payload })).toBeNull();
  });
});


it("copies a managed closure through an unrelated extension and fails closed after unload", () => {
  const lifecycle = new ManagedNodeLifecycleRegistry();
  lifecycle.register({ ...testManagedLifecycle, remapCopy({ nodes, nodeData, nodeIds, createId }) {
    const entries: import("@woohaa3/contracts").ManagedNodeCopyEntry[] = [];
    for (const owner of nodes.filter(n => nodeData[n.id]?.extensionId === "test.entities")) {
      const oldEntities = nodeData[owner.id].entries as string[];
      const entities = oldEntities.map((_, index) => createId("entity", index));
      const ownerId = nodeIds.get(owner.id)!;
      entries.push({ sourceNodeId: owner.id, nodeId: ownerId, data: { ...nodeData[owner.id], entries: entities } as import("@woohaa3/contracts").CanvasNodeData });
      oldEntities.forEach((entity, index) => {
        entries.push({ sourceNodeId: `${owner.id}:${entity}`, nodeId: `${ownerId}:${entities[index]}`, data: {
          managedBy: { schemaVersion: 1, extensionId: "test.entities", ownerNodeId: ownerId, entityId: entities[index], lifecycle: "owner-managed" }
        } });
      });
    }
    return entries;
  } });
  const source = applyCanvasCommands(createEmptyWoohaa3ServerCanvas("source", NOW), [testManagedOwner], { lifecycle, now: NOW });
  if (!source.ok) throw Error(source.rejection.message);
  // Child appears first after a user z-order edit. The generic planner must still
  // submit its owner first, independently of extension business identity.
  source.canvas.document.nodes.reverse();
  const payload = buildCanvasCopyPayload(source.canvas, ["owner"])!;
  const destination = createEmptyWoohaa3ServerCanvas("destination", NOW);
  expect(planPaste({ canvas: destination, payload, anchor: null, viewport: { x: 0, y: 0, zoom: 1 } })).toBeNull();
  const plan = planPaste({ lifecycle, canvas: destination, payload, anchor: null, viewport: { x: 0, y: 0, zoom: 1 }, createId: (prefix, index) => `${prefix}-${index}` })!;
  expect(plan).not.toBeNull();
  const applied = applyCanvasCommands(destination, plan.commands, { lifecycle, now: NOW });
  if (!applied.ok) throw Error(applied.rejection.message);
  const relation = Object.values(applied.canvas.nodeData).map(managedNodeRelationOf).find(Boolean)!;
  expect(relation).toMatchObject({ extensionId: "test.entities", ownerNodeId: "text-1", entityId: "entity-0" });
  expect(applied.canvas.document.nodes.map(n => n.id)).toEqual(["text-1", "text-1:entity-0"]);
});
