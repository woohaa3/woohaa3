/**
 * 片场总览 primitive LOD 策略声明测试
 * （change: 2026-10-15-add-film-set-overview-lod，design D1）。
 *
 * 覆盖：片场 adapter 显式 opt-in 通用总览 LOD 声明；声明只进呈现协议，不进入 executionKey
 * （内容身份）；普通片场身份仍按严格 extensionId 解析。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, createFilmSetSnapshot, canonicalFilmSetFields, defaultGroupAppearance, encodeFilmSetPartId, type CanvasNodeData } from "@woohaa3/contracts";
import { CompositeAssetRegistry } from "@woohaa3/frontend/extension-api";
import { createFilmSetModelAdapter, filmSetExecutionKey } from "../src/preview/browser/model-adapter.js";

describe("片场总览 LOD 策略声明（change: 2026-10-15-add-film-set-overview-lod）", () => {
  it("片场的自身模型就是整场 items，不注入默认组徽标", async () => {
    const data = canonicalFilmSetFields(createFilmSetSnapshot({
      title: "片场", timeline: { duration: 0, loop: false },
      model: { modelScript: "scene.box({id:'actor-body',size:[1,2,1]});", modelScriptVersion: "woohaa-model-js-v2" },
      modelItemId: "actor"
    })) as CanvasNodeData;
    const original = structuredClone(data);
    const result = await createFilmSetModelAdapter().prepare("film", data);
    expect(result?.resource?.ops).toEqual(expect.arrayContaining([
      expect.objectContaining({ t: "box", id: encodeFilmSetPartId("actor", "actor-body") })
    ]));
    expect(result?.resource?.ops.some(op => op.id === encodeFilmSetPartId("", "group-base"))).toBe(false);
    expect(result?.composition?.itemRoots.actor).toBe(encodeFilmSetPartId("actor", ""));
    expect(Object.keys(result!.composition!.itemRoots)).not.toContain("");
    expect(data).toEqual(original);
  });

  it("片场忽略 groupAppearance：自定义外观不进入整场组合，执行身份也不变", async () => {
    const data = canonicalFilmSetFields(createFilmSetSnapshot({
      title: "片场", timeline: { duration: 0, loop: false },
      model: { modelScript: "scene.box({id:'actor-body',size:[1,2,1]});", modelScriptVersion: "woohaa-model-js-v2" },
      modelItemId: "actor"
    })) as CanvasNodeData;
    const adapter = createFilmSetModelAdapter();
    const defaultKey = adapter.executionKey(data);
    const appearance = defaultGroupAppearance();
    appearance.model.modelScript = "scene.sphere({id:'custom',radius:1});";
    data.groupAppearance = appearance;
    const result = await adapter.prepare("film", data);
    expect(adapter.executionKey(data)).toBe(defaultKey);
    expect(result?.resource?.ops).toEqual(expect.arrayContaining([
      expect.objectContaining({ t: "box", id: encodeFilmSetPartId("actor", "actor-body") })
    ]));
    expect(result?.resource?.ops.some(op => op.t === "sphere" || op.id === encodeFilmSetPartId("", "group-base"))).toBe(false);
  });

  it("片场 adapter 显式声明 overview-primitives-v1，宿主 registry 投影到该节点", () => {
    const registry = new CompositeAssetRegistry();
    registry.register(createFilmSetModelAdapter());
    const canvas = createEmptyWoohaa3ServerCanvas("c");
    canvas.document.nodes.push({ id: "film", type: "composite-asset", position: { x: 0, y: 0 } });
    canvas.nodeData.film = canonicalFilmSetFields(createFilmSetSnapshot({ title: "片场", timeline: { duration: 0, loop: false } })) as never;
    canvas.nodeData.film.extensionId = "film-set";
    expect(registry.geometryQualities(canvas).get("film")).toBe("overview-primitives-v1");
  });

  it("声明只进呈现协议：不改变片场的执行 key 与内容身份", () => {
    // design D1：策略声明不进入 canonical 内容 hash、脚本执行 key 或持久 DTO。
    const data = canonicalFilmSetFields(createFilmSetSnapshot({
      title: "片场",
      timeline: { duration: 0, loop: false },
      model: { modelScript: "scene.box({id:'part'});", modelScriptVersion: "woohaa-model-js-v2" },
      modelItemId: "actor"
    })) as never;
    const adapter = createFilmSetModelAdapter();
    const withoutDeclaration = filmSetExecutionKey(data);
    // executionKey 只读内容；与 adapter 是否声明策略无关（同一份内容 → 同一 key）。
    expect(adapter.executionKey(data)).toBe(withoutDeclaration);
    expect(adapter.executionKey(data)).toBe(filmSetExecutionKey(data));
  });
});

it("空内容声明地台，地面/坏内容/对象/镜头不声明，释放后消失", () => {
  const registry = new CompositeAssetRegistry();
  const dispose = registry.register(createFilmSetModelAdapter());
  const canvas = createEmptyWoohaa3ServerCanvas("empty-plinth");
  canvas.document.nodes.push({ id: "film", type: "composite-asset", position: { x: 0, y: 0 } });
  const fields = canonicalFilmSetFields(createFilmSetSnapshot({ title: "空", timeline: { duration: 0, loop: false } }));
  canvas.nodeData.film = { ...fields, extensionId: "film-set" } as never;
  const before = JSON.stringify(canvas);
  const projection = createFilmSetModelAdapter().prepare("film", canvas.nodeData.film);
  expect(projection?.resource?.aabb).toBeNull();
  expect(projection?.composition?.itemRoots).toEqual({});
  expect([...registry.emptyPlaceholders(canvas)]).toEqual([["film", "brand-plinth-v1"]]);
  expect(JSON.stringify(canvas)).toBe(before);
  const content = canvas.nodeData.film.filmSetContent as { items: unknown[] };
  content.items.push({ id: "ground", kind: "ground", name: "地面", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, size: { width: 8, depth: 8 } });
  expect(registry.emptyPlaceholders(canvas).size).toBe(0);
  content.items = [];
  expect(registry.emptyPlaceholders(canvas).size).toBe(1);
  canvas.nodeData.film.filmSetObject = { filmSetNodeId: "owner", itemId: "object" } as never;
  expect(registry.emptyPlaceholders(canvas).size).toBe(0);
  delete canvas.nodeData.film.filmSetObject;
  canvas.nodeData.film.shotPreview = { schemaVersion: 1, filmSetNodeId: "owner", clipId: "shot" } as never;
  expect(registry.emptyPlaceholders(canvas).size).toBe(0);
  delete canvas.nodeData.film.shotPreview;
  canvas.nodeData.film.filmSetContent = { schemaVersion: -1, items: [] } as never;
  expect(registry.emptyPlaceholders(canvas).size).toBe(0);
  canvas.nodeData.film = { ...fields, extensionId: "film-set" } as never;
  dispose();
  expect(registry.emptyPlaceholders(canvas).size).toBe(0);
});
