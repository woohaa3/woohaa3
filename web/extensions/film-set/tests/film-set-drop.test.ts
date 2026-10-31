import { migrateFilmSetFixture } from "../../../test-support/film-set-groups.js";
/**
 * 片场复制拖入规划测试
 * （change: 2026-10-08-make-film-set-model-only，任务 2.3/3.3/6.2；
 *  change: 2026-10-18-restrict-film-set-drop-to-models：只接收普通模型）。
 */
import { describe, expect, it } from "vitest";
import {
  applyCanvasCommands,
  createEmptyWoohaa3ServerCanvas,
  createFilmSetGroupMarker,
  filmSetNodeDataFields,
  createFilmSetSnapshot,
  createModel3DNodeData,
  getGroupLayoutSizes,
  groupPadding,
  model3DNodeDataFields,
  readFilmSetGroupMarker,
  type ServerCanvas
} from "@woohaa3/contracts";
import {
  FILM_SET_DROP_ALREADY_MEMBER,
  FILM_SET_DROP_UNSUPPORTED_SOURCE,
  filmSetAcceptsSources,
  planFilmSetImportCommand,
  resolveFilmSetDrop,
  filmSetImportPatchValue
} from "../src/authoring/shared/drop-planner.js";

const NOW = "2026-10-08T00:00:00.000Z";
const SCRIPT = `scene.box({ id: "a" });`;
const SCRIPT2 = `scene.box({ id: "b" });`;

function base(): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("c1", NOW);
  canvas.document.nodes = [
    { id: "film", type: "composite-asset", position: { x: 0, y: 0 }, width: 196, height: 64 },
    { id: "model", type: "model3d", position: { x: 400, y: 0 }, width: 196, height: 64 },
    { id: "img", type: "image", position: { x: 800, y: 0 } },
    { id: "vid", type: "video", position: { x: 1000, y: 0 } },
    { id: "txt", type: "text", position: { x: 800, y: 200 } }
  ];
  canvas.nodeData = {
    film: filmSetNodeDataFields(createFilmSetSnapshot({
      title: "片场",
      timeline: { duration: 0, loop: false }, filmSetContent: explicitGroundContent()
    })),
    model: model3DNodeDataFields(createModel3DNodeData({
      title: "模型", model: { modelScript: SCRIPT, modelScriptVersion: "woohaa-model-js-v2" }
    })),
    img: { title: "图", outputAssetId: "asset-image" },
    vid: { title: "视", outputAssetId: "asset-video" },
    txt: { title: "文本" }
  } as ServerCanvas["nodeData"];
  canvas.assets = [
    {
      id: "asset-image", title: "图", mediaKind: "image", source: "generated", status: "ready",
      createdAt: NOW,
      metadata: { storageKey: `sha256-${"a".repeat(64)}`, checksum: "a".repeat(64), contentType: "image/png", size: 4, width: 200, height: 100 }
    },
    {
      id: "asset-video", title: "视", mediaKind: "video", source: "generated", status: "ready", createdAt: NOW, durationSeconds: 12,
      metadata: { storageKey: `sha256-${"b".repeat(64)}`, checksum: "b".repeat(64), contentType: "video/mp4", size: 8 }
    }
  ] as ServerCanvas["assets"];
  return migrateFilmSetFixture(canvas, "film");
}

describe("resolveFilmSetDrop", () => {
  it("目标 identity 已确认时校验来源并非空导入", () => {
    const result = resolveFilmSetDrop(base(), ["model"], "film");
    expect(result?.ok).toBe(true);
    if (!result || !result.ok) return;
    expect(result.target.nodeId).toBe("film");
    expect(result.target.sources[0]?.kind).toBe("model");
  });

  it("排除拖动源自身；非片场目标返回 null", () => {
    // 目标即拖动来源：宿主查询已排除，这里也必须拒绝。
    expect(resolveFilmSetDrop(base(), ["film"], "film")).toBeNull();
    // 非片场/不存在 identity：由宿主查询保证不会到达，这里保持稳定 null。
    expect(resolveFilmSetDrop(base(), ["model"], "model")).toBeNull();
    expect(resolveFilmSetDrop(base(), ["model"], "missing")).toBeNull();
  });

  it("图片、视频和文本等不支持来源整批拒绝", () => {
    for (const source of ["img", "vid", "txt"]) {
      const result = resolveFilmSetDrop(base(), [source], "film");
      expect(result).not.toBeNull();
      expect(result?.ok).toBe(false);
      if (!result || result.ok) continue;
      expect(result.reason).toBe(FILM_SET_DROP_UNSUPPORTED_SOURCE);
    }
  });

  it("模型与图片混合批次整批拒绝（不静默只导入模型）", () => {
    const result = resolveFilmSetDrop(base(), ["model", "img"], "film");
    expect(result?.ok).toBe(false);
    if (!result || result.ok) return;
    expect(result.reason).toBe(FILM_SET_DROP_UNSUPPORTED_SOURCE);
  });

  it("软摘除对象拖回原片场时走普通移动，不创建副本", () => {
    const canvas = base();
    const marker = readFilmSetGroupMarker(canvas.nodeData.film)!;
    canvas.nodeData.film = {
      ...canvas.nodeData.film,
      filmSetGroup: createFilmSetGroupMarker({
        ...marker,
        sceneBindings: [...marker.sceneBindings, {
          bindingId: "detached-binding", sourceNodeId: "model", kind: "model3d",
          transform: { x: 0, y: 0, z: 0, yaw: 0, scale: 1 }, visibility: true,
          contentKey: "model3d:v1", detached: true
        }]
      })
    } as never;
    const result = resolveFilmSetDrop(canvas, ["model"], "film");
    expect(result).toMatchObject({ ok: true, reattach: true, target: { nodeId: "film", sources: [] } });
    expect(filmSetAcceptsSources(canvas, "film", ["model"])).toBe(false);

    canvas.document.nodes.push({ id: "model2", type: "model3d", position: { x: 500, y: 0 } });
    canvas.nodeData.model2 = model3DNodeDataFields(createModel3DNodeData({
      title: "新模型", model: { modelScript: SCRIPT, modelScriptVersion: "woohaa-model-js-v2" }
    })) as never;
    const mixed = resolveFilmSetDrop(canvas, ["model", "model2"], "film");
    expect(mixed).toEqual({ ok: false, reason: "请把要放回片场的对象单独拖入" });
  });

  it("已在片场内的成员不再重复导入", () => {
    const canvas = base();
    canvas.document.nodes.push({ id: "member", type: "model3d", position: { x: 40, y: 40 }, parentId: "film" });
    canvas.nodeData.member = model3DNodeDataFields(createModel3DNodeData({
      title: "已在片场", model: { modelScript: SCRIPT, modelScriptVersion: "woohaa-model-js-v2" }
    })) as never;
    const result = resolveFilmSetDrop(canvas, ["member"], "film");
    expect(result).toEqual({ ok: false, reason: FILM_SET_DROP_ALREADY_MEMBER });
    expect(filmSetAcceptsSources(canvas, "film", ["member"])).toBe(false);
  });
});

describe("filmSetAcceptsSources", () => {
  it("只有全部来源都是普通模型时才在拖动中点亮片场", () => {
    const canvas = base();
    expect(filmSetAcceptsSources(canvas, "film", ["model"])).toBe(true);
    expect(filmSetAcceptsSources(canvas, "film", ["img"])).toBe(false);
    expect(filmSetAcceptsSources(canvas, "film", ["vid"])).toBe(false);
    expect(filmSetAcceptsSources(canvas, "film", ["model", "img"])).toBe(false);
    expect(filmSetAcceptsSources(canvas, "film", ["txt"])).toBe(false);
  });

  it("目标不是片场、来源为空或来源即目标时不点亮", () => {
    const canvas = base();
    expect(filmSetAcceptsSources(canvas, "model", ["img"])).toBe(false);
    expect(filmSetAcceptsSources(canvas, "film", [])).toBe(false);
    expect(filmSetAcceptsSources(canvas, "film", ["film"])).toBe(false);
  });
});

describe("planFilmSetImportCommand", () => {
  it("追加模型并保留已有地面；来源卡片落在片场成员网格内", () => {
    const canvas = base();
    const resolved = resolveFilmSetDrop(canvas, ["model"], "film");
    expect(resolved?.ok).toBe(true);
    if (!resolved || !resolved.ok) return;
    const plan = planFilmSetImportCommand({ canvas, target: resolved.target, now: NOW });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const patch = filmSetImportPatchValue(plan.value);
    expect(plan.value.ground).toMatchObject({ width: 8, depth: 8 });
    expect(plan.value.sceneBindings.map(binding => binding.kind)).toEqual(["model3d"]);
    // 空场景拖入的单个模型默认在片场中心，而不是旧的错开偏移。
    expect(plan.value.sceneBindings[0]?.transform).toEqual({ x: 0, y: 0, z: 0, yaw: 0, scale: 1 });
    const sourceUpdate = plan.commands.find((command) => command.type === "node.update" && command.nodeId === "model");
    expect(sourceUpdate).toMatchObject({ type: "node.update", nodeId: "model", parentId: "film" });
    if (sourceUpdate?.type !== "node.update") throw new Error("missing source update");
    expect(sourceUpdate.position).toBeDefined();
    // 成员坐标是 group 局部坐标；不能继承来源卡片拖动前的绝对位置把气泡撑大。
    // 成员落在组框内边距以内即算组局部坐标，别写死具体像素。
    expect(sourceUpdate.position!.x).toBeGreaterThanOrEqual(groupPadding);
    expect(sourceUpdate.position!.y).toBeGreaterThanOrEqual(groupPadding);
    expect(patch).not.toHaveProperty("position");
    const applied = applyCanvasCommands(canvas, plan.commands);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    // 成员落位后气泡按网格尺寸收敛，而不是继承来源卡片的绝对坐标膨胀到画布另一侧。
    const layout = getGroupLayoutSizes(applied.canvas.document.nodes).get("film")!;
    expect(layout.width).toBeLessThan(800);
    expect(layout.height).toBeLessThan(800);
    expect(applied.canvas.document.nodes.find((node) => node.id === "model")?.position).toEqual(sourceUpdate.position);
  });

  it("连续导入两个模型时保留两个成员和 binding，并继续按网格收敛", () => {
    const canvas = base();
    canvas.document.nodes.push({ id: "model2", type: "model3d", position: { x: 1200, y: 0 }, width: 196, height: 64 });
    canvas.nodeData.model2 = model3DNodeDataFields(createModel3DNodeData({
      title: "模型 2", model: { modelScript: SCRIPT2, modelScriptVersion: "woohaa-model-js-v2" }
    })) as never;

    const firstResolved = resolveFilmSetDrop(canvas, ["model"], "film");
    if (!firstResolved || !firstResolved.ok) throw new Error("expected first target");
    const first = planFilmSetImportCommand({ canvas, target: firstResolved.target, now: NOW });
    if (!first.ok) throw new Error(first.reason);
    const appliedFirst = applyCanvasCommands(canvas, first.commands);
    if (!appliedFirst.ok) throw new Error(appliedFirst.rejection.message);

    const secondResolved = resolveFilmSetDrop(appliedFirst.canvas, ["model2"], "film");
    if (!secondResolved || !secondResolved.ok) throw new Error("expected second target");
    const second = planFilmSetImportCommand({ canvas: appliedFirst.canvas, target: secondResolved.target, now: NOW });
    if (!second.ok) throw new Error(second.reason);
    expect(second.value.sceneBindings).toHaveLength(2);
    expect(second.value.sceneBindings[0]?.transform).toEqual({ x: 0, y: 0, z: 0, yaw: 0, scale: 1 });
    expect(second.value.sceneBindings[1]?.transform).not.toEqual({ x: 0, y: 0, z: 0, yaw: 0, scale: 1 });

    const appliedSecond = applyCanvasCommands(appliedFirst.canvas, second.commands);
    expect(appliedSecond.ok).toBe(true);
    if (!appliedSecond.ok) return;
    const layout = getGroupLayoutSizes(appliedSecond.canvas.document.nodes).get("film")!;
    expect(layout.width).toBeLessThan(800);
    expect(layout.height).toBeLessThan(800);
    const members = appliedSecond.canvas.document.nodes.filter((node) => node.parentId === "film");
    expect(members.map((node) => node.id).sort()).toEqual(["model", "model2"]);
    for (const member of members) {
      expect(member.position.x).toBeGreaterThanOrEqual(groupPadding);
      expect(member.position.y).toBeGreaterThanOrEqual(groupPadding);
    }
  });

  it("来源模型内容变化时拒绝导入", () => {
    const canvas = base();
    const resolved = resolveFilmSetDrop(canvas, ["model"], "film");
    if (!resolved || !resolved.ok) throw new Error("expected target");
    (canvas.nodeData.model as { modelScript?: string }).modelScript = "scene.box({ id: 'changed' });";
    const plan = planFilmSetImportCommand({ canvas, target: resolved.target, now: NOW });
    expect(plan.ok).toBe(false);
  });
});

function explicitGroundContent(): import("@woohaa3/contracts").FilmSetContent {
  return { schemaVersion: 4, items: [{ id: "ground", kind: "ground", name: "地面", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, size: { width: 8, depth: 8 } }] };
}
