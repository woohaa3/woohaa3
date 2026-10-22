import { afterEach, expect, it } from "vitest";
import { mergeRustWorkDiagnostics, noteSceneSubmitRoute, resetSceneDiagnostics, sceneDiagnosticsSnapshot } from "./scene-diagnostics.js";
afterEach(resetSceneDiagnostics);
it("keeps absent Render counters unavailable and merges each runtime once", () => {
  resetSceneDiagnostics();
  const first = {}, second = {};
  mergeRustWorkDiagnostics({}, first);
  mergeRustWorkDiagnostics({ renderStages: { work: { renderMs: NaN, renderFrames: .5 } } }, first);
  expect(sceneDiagnosticsSnapshot().rustRenderMs).toBeUndefined();
  expect(sceneDiagnosticsSnapshot().rustRenderFrames).toBeUndefined();
  mergeRustWorkDiagnostics({ renderStages: { work: { renderMs: 0, renderFrames: 0 } } }, first);
  expect(sceneDiagnosticsSnapshot()).toMatchObject({ rustRenderMs: 0, rustRenderFrames: 0 });
  const work = { renderMs: 12.5, renderFrames: 3 };
  mergeRustWorkDiagnostics({ renderStages: { work } }, first);
  mergeRustWorkDiagnostics({ renderStages: { work } }, first);
  mergeRustWorkDiagnostics({ renderStages: { work: { renderMs: 2, renderFrames: 1 } } }, second);
  mergeRustWorkDiagnostics({ renderStages: { work } }, first);
  expect(sceneDiagnosticsSnapshot()).toMatchObject({ rustRenderMs: 14.5, rustRenderFrames: 4 });
  resetSceneDiagnostics();
  expect(sceneDiagnosticsSnapshot().rustRenderMs).toBeUndefined();
});
it("owns cumulative primitive and batch geometry work once and tolerates missing counters", () => {
  resetSceneDiagnostics();
  const owner = {};
  const input = { models: {
    geometryWork: { builtMeshes: 2, buildMs: 4.5, cacheHits: 10 },
    batchGeometryWork: { builtMeshes: 1, buildMs: 2, cacheHits: 2 }
  } };
  mergeRustWorkDiagnostics(input, owner);
  mergeRustWorkDiagnostics(input, owner);
  mergeRustWorkDiagnostics({}, owner);
  expect(sceneDiagnosticsSnapshot()).toMatchObject({ rustGeometryBuilds: 3, rustGeometryBuildMs: 6.5, rustGeometryCacheHits: 12 });
  mergeRustWorkDiagnostics({ models: { ...input.models, geometryWork: { builtMeshes: 3, buildMs: 6, cacheHits: 11 } } }, owner);
  expect(sceneDiagnosticsSnapshot()).toMatchObject({ rustGeometryBuilds: 4, rustGeometryBuildMs: 8, rustGeometryCacheHits: 13 });
});
it("records last submit route until reset", () => {
  noteSceneSubmitRoute("full", ["model-focus", "model-editor"]);
  expect(sceneDiagnosticsSnapshot()).toMatchObject({ lastSubmitRoute: "full", lastDirtyReasons: ["model-focus", "model-editor"] });
  resetSceneDiagnostics();
  expect(sceneDiagnosticsSnapshot().lastSubmitRoute).toBeUndefined();
  expect(sceneDiagnosticsSnapshot().lastDirtyReasons).toBeUndefined();
});
it("reset zeros JS counters without dumping a live owner's rust lifetime totals", () => {
  const owner = {};
  mergeRustWorkDiagnostics({ meshBuilds: 100, renderStages: { work: { renderMs: 12, renderFrames: 8 } } }, owner);
  expect(sceneDiagnosticsSnapshot()).toMatchObject({ meshBuilds: 100, rustRenderFrames: 8 });
  resetSceneDiagnostics();
  expect(sceneDiagnosticsSnapshot().meshBuilds).toBe(0);
  expect(sceneDiagnosticsSnapshot().rustRenderFrames).toBeUndefined();
  mergeRustWorkDiagnostics({ meshBuilds: 100, renderStages: { work: { renderMs: 12, renderFrames: 8 } } }, owner);
  expect(sceneDiagnosticsSnapshot()).toMatchObject({ meshBuilds: 0, rustRenderFrames: 0 });
  mergeRustWorkDiagnostics({ meshBuilds: 103, renderStages: { work: { renderMs: 13, renderFrames: 10 } } }, owner);
  expect(sceneDiagnosticsSnapshot()).toMatchObject({ meshBuilds: 3, rustRenderFrames: 2 });
});
it("keeps independent WASM baselines and never double-counts a returning live owner", () => {
  resetSceneDiagnostics();
  const first = {}, second = {};
  mergeRustWorkDiagnostics({ meshBuilds: 100 }, first);
  mergeRustWorkDiagnostics({ meshBuilds: 2 }, second);
  mergeRustWorkDiagnostics({ meshBuilds: 100 }, first);
  mergeRustWorkDiagnostics({ meshBuilds: 3 }, second);
  expect(sceneDiagnosticsSnapshot().meshBuilds).toBe(103);
});
it("merges film-set internal object work as a diff and treats non-focus reports as zero", () => {
  resetSceneDiagnostics();
  const owner = {};
  // 总览/非片场聚焦：内部对象准备不推进（四项累计保持 0），不产生增量。
  mergeRustWorkDiagnostics({ filmSetItems: { builds: 0, targets: 0, candidatesProduced: 0, partBounds: 0 } }, owner);
  expect(sceneDiagnosticsSnapshot()).toMatchObject({ filmSetItemBuilds: 0, filmSetItemTargets: 0, filmSetItemCandidates: 0, filmSetItemPartBounds: 0 });
  // 聚焦一个片场：只处理一个目标；重复读取同一快照不重复累加。
  const focused = { builds: 1, targets: 1, candidatesProduced: 2, partBounds: 3 };
  mergeRustWorkDiagnostics({ filmSetItems: focused }, owner);
  mergeRustWorkDiagnostics({ filmSetItems: focused }, owner);
  expect(sceneDiagnosticsSnapshot()).toMatchObject({ filmSetItemBuilds: 1, filmSetItemTargets: 1, filmSetItemCandidates: 2, filmSetItemPartBounds: 3 });
  // 再聚焦另一个片场：按累计值差分成增量。
  mergeRustWorkDiagnostics({ filmSetItems: { builds: 2, targets: 2, candidatesProduced: 5, partBounds: 7 } }, owner);
  expect(sceneDiagnosticsSnapshot()).toMatchObject({ filmSetItemBuilds: 2, filmSetItemTargets: 2, filmSetItemCandidates: 5, filmSetItemPartBounds: 7 });
  // 缺字段/旧 WASM 上报不改变既有值（不补零、不回退）。
  mergeRustWorkDiagnostics({}, owner);
  expect(sceneDiagnosticsSnapshot()).toMatchObject({ filmSetItemBuilds: 2, filmSetItemTargets: 2 });
});
