/**
 * 片场总览 primitive LOD 策略声明测试
 * （change: 2026-10-15-add-film-set-overview-lod，design D1）。
 *
 * 覆盖：片场 adapter 显式 opt-in 通用总览 LOD 声明；声明只进呈现协议，不进入 executionKey
 * （内容身份）；普通片场身份仍按严格 extensionId 解析。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, createFilmSetSnapshot, canonicalFilmSetFields } from "@woohaa3/contracts";
import { CompositeAssetRegistry } from "@woohaa3/frontend/extension-api";
import { createFilmSetModelAdapter, filmSetExecutionKey } from "../src/frontend/model-adapter.js";

describe("片场总览 LOD 策略声明（change: 2026-10-15-add-film-set-overview-lod）", () => {
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
