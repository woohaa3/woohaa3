import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("./capture-session.js", import.meta.url), "utf8");

function harness({ fps = 111, missing = false, restart = false, hidden = false } = {}) {
  let now = 0;
  let reads = 0;
  let listener;
  const work = () => missing ? {} : {
    renderStages: { work: {
      queueFrames: now, queueMs: now / 2,
      prepareFrames: now, prepareMs: now * 2,
      renderFrames: now, renderMs: now * 3
    } },
    models: { roots: 0, modelEntities: 0 },
    previews: { active: 0 }, shotPreviews: { active: 0 }, pacing: "active:scene"
  };
  const runtime = {
    isReady: () => true,
    generation: () => restart ? reads : 1,
    rendererBackend: () => "native",
    readSceneDiagnostics: async () => { reads++; return { value: work(), reason: null }; },
    getWorkDiagnostics: () => { throw new Error("Must use async native diagnostics"); },
    rawHealth: () => JSON.stringify({
      renders: 5000 + now * fps / 1000,
      updates: 9000 + now * 120 / 1000,
      ...(missing ? {} : { drawCalls3d: 30000 + now * fps * 2 / 1000 })
    }),
    lastScene: () => ({ canvasId: "same-canvas", revision: 5, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } })
  };
  const context = vm.createContext({
    __bevyRuntime: runtime,
    performance: { now: () => now },
    console: { info() {}, table() {} },
    document: {
      visibilityState: "visible",
      addEventListener: (_, fn) => { listener = fn; },
      removeEventListener: () => { listener = null; }
    },
    setTimeout: (fn, ms) => {
      now += ms;
      if (hidden) {
        context.document.visibilityState = "hidden";
        listener();
        context.document.visibilityState = "visible";
      }
      fn();
    }
  });
  vm.runInContext(source, context);
  return { probe: context.__canvasPerfProbe, listener: () => listener, runtime };
}

test("captures paired 111/40 FPS phases using deltas, with async diagnostics and CPU stages", async () => {
  for (const fps of [111, 40]) {
    const { probe, listener } = harness({ fps });
    const result = await probe.sample("empty");
    assert.equal(result.valid, true);
    assert.equal(result.renderFps, fps);
    assert.equal(result.updateFps, 120);
    assert.equal(result.drawCalls, 2);
    assert.equal(result.queueMs, 0.5);
    assert.equal(result.prepareMs, 2);
    assert.equal(result.renderMs, 3);
    assert.equal(listener(), null);
    assert.equal(JSON.parse(probe.json()).phases[0].before.backend, "native");
    // Exports must not be live views of the retained evidence.
    probe.report().phases.pop();
    assert.equal(probe.report().phases.length, 1);
  }
});

test("missing diagnostic counters remain null rather than fabricated zero costs", async () => {
  const { probe } = harness({ missing: true });
  const result = await probe.sample("missing");
  assert.equal(result.drawCalls, null);
  assert.equal(result.queueMs, null);
  assert.equal(result.modelRoots, null);
});

test("hidden pages and renderer replacement invalidate the phase", async () => {
  for (const [options, reason] of [[{ hidden: true }, "page-hidden"], [{ restart: true }, "runtime-changed"]]) {
    const { probe } = harness(options);
    const result = await probe.sample("invalid");
    assert.equal(result.valid, false);
    assert.match(result.reasons, new RegExp(reason));
  }
});

test("a failed boundary read releases the sample lock and visibility listener", async () => {
  const { probe, runtime, listener } = harness();
  const read = runtime.rawHealth;
  runtime.rawHealth = () => { throw new Error("renderer unavailable"); };
  await assert.rejects(probe.sample("broken"), /renderer unavailable/);
  assert.equal(listener(), null);
  runtime.rawHealth = read;
  assert.equal((await probe.sample("recovered")).valid, true);
});
