/**
 * 片场复制拖入规划测试
 * （change: 2026-10-08-make-film-set-model-only，任务 2.3/3.3/6.2；
 *  change: 2026-10-18-restrict-film-set-drop-to-models：只接收普通模型）。
 */
import { describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  filmSetNodeDataFields,
  createFilmSetSnapshot,
  createModel3DNodeData,
  model3DNodeDataFields,
  defaultFilmSetContent,
  type ServerCanvas
} from "@woohaa3/contracts";
import {
  FILM_SET_DROP_UNSUPPORTED_SOURCE,
  filmSetAcceptsSources,
  planFilmSetImportCommand,
  resolveFilmSetDrop,
  filmSetImportPatchValue
} from "../src/authoring/shared/drop-planner.js";

const NOW = "2026-10-08T00:00:00.000Z";
const SCRIPT = `scene.box({ id: "a" });`;

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
      timeline: { duration: 0, loop: false }, filmSetContent: defaultFilmSetContent()
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
  return canvas;
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
  it("追加模型并保留已有地面；来源位置不进入命令", () => {
    const canvas = base();
    const resolved = resolveFilmSetDrop(canvas, ["model"], "film");
    expect(resolved?.ok).toBe(true);
    if (!resolved || !resolved.ok) return;
    const plan = planFilmSetImportCommand({ canvas, target: resolved.target, now: NOW });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const patch = filmSetImportPatchValue(plan.value) as { filmSetContent: { items: { kind: string }[] } };
    expect(patch.filmSetContent.items.map((item) => item.kind)).toEqual(["ground", "model"]);
    expect(patch).not.toHaveProperty("position");
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
