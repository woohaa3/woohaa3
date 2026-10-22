import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInteractionPerformanceSink } from "./dev-performance.mjs";

const sample = (overrides = {}) => ({ kind: "pan", source: "trackpad", phase: "wheel",
  startedAt: 10, handlerMs: 2, nextRafMs: 16, hidden: false, ...overrides });
const batch = (samples) => ({ recorderId: "browser-1", sequence: 0, dropped: 3,
  metadata: { timeOrigin: 123, userAgent: "test", width: 1000, height: 800, pixelRatio: 2,
    timingSchema: 2, loadId: "123", identity: { js: "dev", wasm: "abc123", mode: "development" },
    longTaskSupport: "observed", surface: { width: 1200, height: 700 } }, samples });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "woohaa-performance-"));
  const sink = await createInteractionPerformanceSink({ root });
  const server = http.createServer((req, res) => { void sink.handle(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await sink.close();
    await rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/__dev/performance/interactions`;
  return { sink, post: (payload, headers = {}) => fetch(url, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload)
  }) };
}

test("persists concurrent batches and excludes hidden/missing frames from rAF statistics", async (t) => {
  const { sink, post } = await fixture(t);
  const payload = batch([sample({ arbitrary: "must not persist" }), sample({ hidden: true, nextRafMs: 10000 }), sample({ nextRafMs: null })]);
  const responses = await Promise.all([post(payload), post({ ...payload, sequence: 1, dropped: 0 })]);
  assert.deepEqual(responses.map((response) => response.status), [204, 204]);
  const lines = (await readFile(path.join(sink.directory, "interactions.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).samples[0].arbitrary, undefined);
  const summary = await readFile(path.join(sink.directory, "summary.md"), "utf8");
  assert.match(summary, /已接收 6 条事件，2 个批次；客户端报告丢失 3 条/);
  assert.match(summary, /pan\/trackpad\/wheel \| 6 \| 2\.00 \| 2\.00 \| 2\.00 \| 2\.00 \| 2 \| 16\.00/);
  assert.equal(JSON.parse(await readFile(path.join(sink.directory, "session.json"), "utf8")).mode, "vite-dev");
});

test("groups by phase and records schema v2 segments/frame/config with whitelisting", async (t) => {
  const { sink, post } = await fixture(t);
  const rich = batch([
    sample({ phase: "down", handlerMs: 12, segments: { coordinatesMs: 1, hitQueryMs: 3, selectionMs: 6, arbitrary: 99, frameWorkMs: 1.5 },
      frame: { sceneBuilds: 1, sceneSubmits: 1, meshBuilds: 0, worldSnapshotBuilds: 0, evil: 5 } }),
    sample({ kind: "zoom", source: "pinch", phase: "wheel", handlerMs: 0.4 })
  ]);
  assert.equal((await post(rich)).status, 204);
  const line = JSON.parse((await readFile(path.join(sink.directory, "interactions.jsonl"), "utf8")).trim().split("\n")[0]);
  assert.deepEqual(line.samples[0].segments, { coordinatesMs: 1, hitQueryMs: 3, selectionMs: 6, frameWorkMs: 1.5 });
  assert.equal(line.samples[0].frame.evil, undefined);
  assert.equal(line.samples[0].frame.meshBuilds, 0);
  assert.equal(line.metadata.timingSchema, 2);
  assert.deepEqual(line.metadata.identity, { js: "dev", wasm: "abc123", mode: "development" });
  assert.equal(line.metadata.longTaskSupport, "observed");
  assert.deepEqual(line.metadata.surface, { width: 1200, height: 700 });
  const summary = await readFile(path.join(sink.directory, "summary.md"), "utf8");
  // 分组包含 phase；分段与帧工作分别出现。
  assert.match(summary, /pan\/trackpad\/down/);
  assert.match(summary, /zoom\/pinch\/wheel/);
  assert.match(summary, /segments\.|pan\/trackpad\/down\/hitQueryMs|hitQueryMs/);
  assert.match(summary, /frame\.sceneBuilds/);
  // 配置分组可分别查看 recorder/DPR/surface/构建身份。
  assert.match(summary, /DPR2/);
  assert.match(summary, /1200x700/);
});

test("rejects malformed, oversized and cross-origin uploads without poisoning later writes", async (t) => {
  const { sink, post } = await fixture(t);
  assert.equal((await post(batch([sample({ handlerMs: -1 })]))).status, 400);
  assert.equal((await post(batch([sample()]), { origin: "https://example.com" })).status, 403);
  assert.equal((await post({ ...batch([]), recorderId: "../../escape" })).status, 400);
  assert.equal((await post({ ...batch([]), padding: "x".repeat(140000) })).status, 413);
  // 非法 kind/phase/timingSchema 被拒绝。
  assert.equal((await post(batch([sample({ kind: "hover" })]))).status, 400);
  assert.equal((await post(batch([sample({ phase: "hover" })]))).status, 400);
  assert.equal((await post({ ...batch([]), metadata: { ...batch([]).metadata, timingSchema: 9 } })).status, 400);
  assert.equal((await post(batch([sample({ kind: "drag", source: "pointer", phase: "up" })]))).status, 204);
  const lines = (await readFile(path.join(sink.directory, "interactions.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).samples[0].kind, "drag");
});

test("schema v1 batches remain accepted with defaults for identity and long task support", async (t) => {
  const { sink, post } = await fixture(t);
  const legacy = { recorderId: "legacy", sequence: 0, dropped: 0,
    metadata: { timeOrigin: 1, userAgent: "test", width: 100, height: 100, pixelRatio: 1 }, samples: [sample()] };
  assert.equal((await post(legacy)).status, 204);
  const line = JSON.parse((await readFile(path.join(sink.directory, "interactions.jsonl"), "utf8")).trim().split("\n")[0]);
  assert.equal(line.metadata.timingSchema, 1);
  assert.deepEqual(line.metadata.identity, { js: "unknown", wasm: "unknown", mode: "unknown" });
  assert.equal(line.metadata.longTaskSupport, "unavailable");
});

test("lifecycle spans are isolated, whitelisted and grouped by result/configuration", async (t) => {
  const { sink, post } = await fixture(t);
  const span = { stage: "image-prepare", startedAt: 20, durationMs: 150,
    outcome: "ok", hidden: false, spanId: 1, url: "private", nodeId: "private" };
  const payload = { ...batch([]), category: "lifecycle", samples: [span,
    { ...span, outcome: "error", durationMs: 500 }, { ...span, outcome: "cancelled", hidden: true }] };
  assert.equal((await post(payload)).status, 204);
  const line = JSON.parse((await readFile(path.join(sink.directory, "lifecycle.jsonl"), "utf8")).trim());
  assert.equal(line.samples[0].url, undefined);
  assert.equal(line.samples[0].nodeId, undefined);
  const report = await readFile(path.join(sink.directory, "summary.md"), "utf8");
  assert.match(report, /image-prepare\/ok\/foreground \| 1 \| 150\.00/);
  assert.match(report, /image-prepare\/error\/foreground \| 1 \| 500\.00/);
  assert.match(report, /image-prepare\/cancelled\/background/);
  for (const bad of [{ stage: "user-content" }, { outcome: "whatever" }, { durationMs: -1 }, { spanId: 0 }]) {
    assert.equal((await post({ ...payload, samples: [{ ...span, ...bad }] })).status, 400);
  }
  assert.equal((await post(batch([sample()]))).status, 204);
  const interaction = JSON.parse((await readFile(path.join(sink.directory, "interactions.jsonl"), "utf8")).trim());
  assert.equal(interaction.samples[0].kind, "pan");
});

test("schema v3 preserves event context, wait/execution separation and bounded whitelists", async (t) => {
  const { sink, post } = await fixture(t);
  const payload = batch([sample({ intervalId: 7,
    context: { identity: { js: "event-js", wasm: "event-wasm", mode: "dev" }, pixelRatio: 1, surface: { width: 700, height: 500 }, evil: "drop" },
    segments: { rafWaitMs: 250, frameWorkMs: -1 },
    frame: { intervalId: 7, intervalMs: 250, frameExecutionMs: 3, sceneStringify: 1, cardBlockBuilds: 2, cardDecorationBuilds: 1, edgeBlockBuilds: 3, containerBlockBuilds: 2, positionSubmits: 1, evil: 1, wasmAcceptMs: Infinity }
  })]);
  payload.metadata.timingSchema = 3;
  assert.equal((await post(payload)).status, 204);
  const line = JSON.parse((await readFile(path.join(sink.directory, "interactions.jsonl"), "utf8")).trim());
  assert.equal(line.samples[0].context.identity.js, "event-js");
  assert.equal(line.samples[0].context.evil, undefined);
  assert.deepEqual(line.samples[0].segments, { rafWaitMs: 250 });
  assert.deepEqual(line.samples[0].frame, { sceneStringify: 1, positionSubmits: 1, cardBlockBuilds: 2, cardDecorationBuilds: 1, edgeBlockBuilds: 3, containerBlockBuilds: 2, intervalId: 7, intervalMs: 250, frameExecutionMs: 3 });
  const report = await readFile(path.join(sink.directory, "summary.md"), "utf8");
  assert.match(report, /执行与长任务重叠分布（ms）/);
  assert.match(report, /等待与旧口径分布（ms）/);
  assert.match(report, /帧工作计数分布（count）/);
  assert.doesNotMatch(report, /handlerMs 的组成/);
  assert.doesNotMatch(report, /\/frame\.intervalId \|/);
  assert.match(await readFile(path.join(sink.directory, "summary.md"), "utf8"), /schema3\/DPR1\/surface:700x500\/mode:dev\/js:event-js\/wasm:event-wasm/);
});

test("whitelists drag release classification and separates moved submissions from clicks", async (t) => {
  const { sink, post } = await fixture(t);
  assert.equal((await post(batch([
    sample({ kind: "drag", source: "pointer", phase: "up", release: "click" }),
    sample({ kind: "drag", source: "pointer", phase: "up", release: "move-submit" }),
    sample({ kind: "drag", source: "pointer", phase: "up", release: "untrusted-content" }),
    sample({ release: "move-submit" })
  ]))).status, 204);
  const saved = JSON.parse((await readFile(path.join(sink.directory, "interactions.jsonl"), "utf8")).trim());
  assert.deepEqual(saved.samples.map(s => s.release), ["click", "move-submit", undefined, undefined]);
  const summary = await readFile(path.join(sink.directory, "summary.md"), "utf8");
  assert.match(summary, /drag\/pointer\/up\/click/);
  assert.match(summary, /drag\/pointer\/up\/move-submit/);
});

test("retains correlated command confirmation and rejects arbitrary outcome payloads", async (t) => {
  const { sink, post } = await fixture(t);
  assert.equal((await post(batch([
    sample({ kind: "drag", source: "pointer", phase: "up", release: "move-submit", commandId: 1 }),
    sample({ kind: "drag", source: "command", phase: "settled", release: "move-submit", commandId: 1,
      handlerMs: 0, nextRafMs: null, command: { outcome: "committed", waitMs: 120, secret: "discard" } }),
    sample({ kind: "drag", source: "command", phase: "settled", commandId: 2,
      command: { outcome: "untrusted", waitMs: 1 } })
  ]))).status, 204);
  const saved = JSON.parse((await readFile(path.join(sink.directory, "interactions.jsonl"), "utf8")).trim());
  assert.equal(saved.samples[0].commandId, 1);
  assert.deepEqual(saved.samples[1].command, { outcome: "committed", waitMs: 120 });
  assert.equal(saved.samples[2].command, undefined);
  const summary = await readFile(path.join(sink.directory, "summary.md"), "utf8");
  assert.match(summary, /drag\/command\/settled\/move-submit\/committed/);
  assert.match(summary, /commandConfirmMs/);
});

test("bounds metrics and integer counters without rejecting real epoch timestamps", async (t) => {
  const { sink, post } = await fixture(t);
  for (const override of [{ handlerMs: 1e13 }, { nextRafMs: 1e13 }, { startedAt: Number.MAX_VALUE }])
    assert.equal((await post(batch([sample(override)]))).status, 400);
  const invalidMeta = batch([]); invalidMeta.metadata.width = Number.MAX_VALUE;
  assert.equal((await post(invalidMeta)).status, 400);
  const valid = batch([sample({ segments: { hitQueryMs: 1e13, domRectMs: 1.25 },
    frame: { meshBuilds: .5, sceneBuilds: 1e13, frameExecutionMs: 2.75, sceneSubmits: 1 },
    context: { pixelRatio: 1, surface: { width: Number.MAX_VALUE, height: 100 },
      resources: { scope: "last-reported", observedAt: 100, models: { roots: .5, parts: 1, retainedMeshBytes: 1e13 } } }
  })]);
  valid.metadata.timeOrigin = 1_791_831_000_000.5;
  valid.metadata.loadId = "x".repeat(129);
  assert.equal((await post(valid)).status, 204);
  const lines = (await readFile(path.join(sink.directory, "interactions.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const saved = JSON.parse(lines[0]);
  assert.equal(saved.metadata.timeOrigin, valid.metadata.timeOrigin);
  assert.equal(saved.metadata.loadId, "unknown");
  assert.deepEqual(saved.samples[0].segments, { domRectMs: 1.25 });
  assert.deepEqual(saved.samples[0].frame, { sceneSubmits: 1, frameExecutionMs: 2.75 });
  assert.equal(saved.samples[0].context.surface, undefined);
  assert.deepEqual(saved.samples[0].context.resources.models, { parts: 1 });
  const summary = await readFile(path.join(sink.directory, "summary.md"), "utf8");
  assert.doesNotMatch(summary, /Infinity|NaN/);
});

test("preserves optional Render wall/count fields and rejects invalid measurements", async (t) => {
  const { sink, post } = await fixture(t);
  assert.equal((await post(batch([
    sample({ frame: { rustRenderMs: 4.5, rustRenderFrames: 2 } }),
    sample({ frame: { rustRenderMs: -1, rustRenderFrames: .5 } }),
    sample({ frame: { rustRenderMs: 1e13, rustRenderFrames: 1e13 } }),
    sample({ frame: { sceneBuilds: 1 } }),
  ]))).status, 204);
  const saved = JSON.parse((await readFile(path.join(sink.directory, "interactions.jsonl"), "utf8")).trim());
  assert.deepEqual(saved.samples[0].frame, { rustRenderMs: 4.5, rustRenderFrames: 2 });
  assert.equal(saved.samples[1].frame, undefined);
  assert.equal(saved.samples[2].frame, undefined);
  assert.deepEqual(saved.samples[3].frame, { sceneBuilds: 1 });
  assert.match(await readFile(path.join(sink.directory, "summary.md"), "utf8"), /frame\.rustRenderMs/);
});

test("diagnostic sampling cost is a separate bounded CPU metric", async (t) => {
  const { sink, post } = await fixture(t);
  assert.equal((await post(batch([
    sample({ handlerMs: 1, frame: { diagnosticsReadMs: 8, diagnosticsReads: 2 } }),
    sample({ frame: { diagnosticsReadMs: -1, diagnosticsReads: .5 } }),
  ]))).status, 204);
  const saved = JSON.parse((await readFile(path.join(sink.directory, "interactions.jsonl"), "utf8")).trim());
  assert.equal(saved.samples[0].handlerMs, 1);
  assert.deepEqual(saved.samples[0].frame, { diagnosticsReadMs: 8, diagnosticsReads: 2 });
  assert.equal(saved.samples[1].frame, undefined);
});

test("persists rejected canvas inputs in a separate JSONL and validates their state", async (t) => {
  const { sink, post } = await fixture(t);
  const state = { canvasBlocked: true, focusBlocked: false, modelFocused: false,
    imageFocused: false, videoFocused: false, writable: true, gesture: "none",
    pointerId: null, generation: 12, viewport: { x: -20, y: 30, zoom: 1 },
    queries: 4, unavailableQueries: 2, renderError: null, arbitrary: "discard" };
  const input = { type: "pointerdown", time: Date.now(), x: 100, y: 200, button: 0,
    before: state, after: { ...state, canvasBlocked: false }, secret: "discard" };
  const payload = { category: "canvas-input", recorderId: "input-1", sequence: 0,
    dropped: 0, pageLoadId: "123", runtime: "native", samples: [input], outputPath: "../../escape" };
  assert.equal((await post(payload)).status, 204);
  assert.equal((await post({ ...payload, sequence: 1, samples: [{ ...input, after: undefined }] })).status, 204);
  const lines = (await readFile(path.join(sink.directory, "canvas-input.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].samples[0].before.canvasBlocked, true);
  assert.equal(lines[0].samples[0].after.canvasBlocked, false);
  assert.equal(lines[0].samples[0].before.viewport.x, -20);
  assert.equal(lines[0].samples[0].secret, undefined);
  assert.equal(lines[0].samples[0].before.arbitrary, undefined);
  assert.equal(lines[0].outputPath, undefined);
  assert.ok(lines[0].receivedAt);
  for (const invalid of [{ type: "pointermove" }, { before: { ...state, generation: -1 } },
    { before: { ...state, viewport: { x: 0, y: 0, zoom: 0 } } }, { after: { ...state, canvasBlocked: "true" } }]) {
    assert.equal((await post({ ...payload, samples: [{ ...input, ...invalid }] })).status, 400);
  }
  assert.equal((await post({ ...payload, samples: Array(17).fill(input) })).status, 400);
  assert.equal((await post(batch([sample()]))).status, 204);
  assert.equal(JSON.parse((await readFile(path.join(sink.directory, "interactions.jsonl"), "utf8")).trim()).samples[0].kind, "pan");
});
