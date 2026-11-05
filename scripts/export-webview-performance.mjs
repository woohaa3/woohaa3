#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const quantiles = values => {
  if (!values.length) return { count: 0, p50Ms: null, p95Ms: null, maxMs: null };
  const sorted = [...values].sort((a, b) => a - b);
  const q = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { count: sorted.length, p50Ms: q(.5), p95Ms: q(.95), maxMs: sorted.at(-1) };
};

/** Snapshot a running capture. Async bitmap spans are wall time, never CPU samples. */
export function summarizeTimings(batches, { warmupMs = 1000 } = {}) {
  const native = batches.filter(batch => batch.nativeClockPair);
  const presentationModes=new Set(batches.map(batch=>batch.nativePresentation).filter(mode=>['shared-gpu','native-cpu-viewport'].includes(mode)));
  if(batches.some(batch=>(batch.samples??[]).some(sample=>sample.scope==='image-edit'&&['readback','capture'].includes(sample.stage))))presentationModes.add('readback');
  const presentation=presentationModes.size===0?'not-collected':presentationModes.size===1?[...presentationModes][0]:'mixed';
  const all = batches.filter(batch => !batch.nativeClockPair).flatMap(batch => batch.samples ?? []);
  const capabilities = {};
  for (const batch of batches) Object.assign(capabilities, batch.capabilities ?? {});
  const clockPairs = batches.flatMap(batch => batch.clockPair ? [batch.clockPair] : []);
  const usablePair = clockPairs.find(pair => pair.uncertaintyMs <= 1);
  const nativeSamples = native.flatMap(batch => (batch.samples ?? []).map(sample => ({ ...sample, nativeClockPair: batch.nativeClockPair })));
  const nativeFirst = nativeSamples.reduce((min, sample) => Math.min(min, sample.nativeClockPair.monotonicMs), Infinity);
  const nativeMeasured = nativeSamples.filter(sample => sample.nativeClockPair.monotonicMs >= nativeFirst + warmupMs);
  const status = (count, capability) => capabilities[capability] === 'dropped' ? 'dropped' : count ? 'collected' : capabilities[capability] === 'unsupported' ? 'unsupported' : 'not-collected';
  const at = sample => sample.timeOrigin + sample.startMs;
  const first = all.length ? all.reduce((min, sample) => Math.min(min, at(sample)), Infinity) : nativeSamples.length ? nativeSamples[0].nativeClockPair.epochMs + (usablePair ? usablePair.webviewEpochMs - usablePair.epochMs : 0) : 0;
  const ticks = new Map(all.filter(s => s.stage === 'tick').map(s => [`${s.timeOrigin}:${s.frame}`, at(s)]));
  const samples = all.filter(sample => (ticks.get(`${sample.timeOrigin}:${sample.frame}`) ?? at(sample)) >= first + warmupMs);
  const captures = samples.filter(s => s.stage === 'capture');
  const stageNames = ['state', 'serialize', 'bitmap', 'prepare', 'draw', 'readback', 'compare', 'copy', 'handoff'];
  const stages = Object.fromEntries(stageNames.map(stage => [stage, {
    ...quantiles(samples.filter(s => s.stage === stage).map(s => s.durationMs)),
    status: status(samples.filter(s => s.stage === stage).length, 'performance'),
    scope: stage === 'bitmap' ? 'async wall time including wait' : 'synchronous wall time',
  }]));
  const last = all.length ? all.reduce((max, sample) => Math.max(max, at(sample)), -Infinity) : first;
  const seconds = Math.max(0, (last - first - warmupMs) / 1000);
  const pixelBytes = captures.reduce((sum, s) => sum + (s.bytes ?? 0), 0);
  const dimensions = [...new Map(captures.map(s => {
    const d = { width: s.width, height: s.height, sourceWidth: s.sourceWidth, sourceHeight: s.sourceHeight };
    return [JSON.stringify(d), d];
  })).values()];
  const metadata = new Map(captures.map(s => [`${s.timeOrigin}:${s.frame}`, s]));
  const traceEvents = samples.filter(s => stageNames.includes(s.stage)).map(s => ({
    name: s.stage, cat: s.scope, ph: 'X', pid: 1, tid: s.stage === 'bitmap' ? 2 : 1,
    ts: (at(s) - first) * 1000, dur: s.durationMs * 1000,
    args: { ...metadata.get(`${s.timeOrigin}:${s.frame}`), frame: s.frame },
  }));
  for (const sample of nativeSamples) {
    // A native lane is always available; cross-clock placement requires measured <=1ms uncertainty.
    const pair = sample.nativeClockPair;
    const uncertaintyMs = (usablePair?.uncertaintyMs ?? Infinity) + pair.uncertaintyMs;
    const aligned = usablePair && uncertaintyMs <= 1;
    traceEvents.push({ name: sample.scope === 'native-display-link' ? 'display-link interval (not present)' : sample.stage, cat: sample.scope, ph: 'X', pid: aligned ? 1 : 2, tid: sample.thread ?? (sample.scope === 'native-display-link' ? 3 : 4),
      ts: ((aligned ? pair.epochMs + usablePair.webviewEpochMs - usablePair.epochMs - first : sample.startMs) - sample.durationMs) * 1000, dur: sample.durationMs * 1000,
      args: { requestId: sample.requestId, generation: sample.generation, clockAligned: Boolean(aligned), uncertaintyMs: aligned ? uncertaintyMs : pair.uncertaintyMs } });
  }
  traceEvents.unshift(
    { ph: 'M', name: 'thread_name', pid: 1, tid: 1, args: { name: 'WebView synchronous work' } },
    { ph: 'M', name: 'thread_name', pid: 1, tid: 2, args: { name: 'Bitmap async wall time (includes wait)' } },
  );
  return {
    trace: { traceEvents, displayTimeUnit: 'ms' },
    series: [...samples, ...nativeSamples],
    summary: { schema: 2, capabilities, clockPairs,
      nativeStages: Object.fromEntries([...new Set(nativeSamples.filter(s => s.scope === 'native-editor').map(s => s.stage))].map(stage => [stage, quantiles(nativeMeasured.filter(s => s.scope === 'native-editor' && s.stage === stage).map(s => s.durationMs))])),
      crossClockAlignment: { status: usablePair ? 'collected' : 'not-collected', reason: usablePair ? null : 'No clock pair with uncertainty <= 1ms' },
      nativeInterval: { ...quantiles(nativeMeasured.filter(s => s.scope === 'native-display-link').map(s => s.intervalMs)), status: status(nativeMeasured.filter(s => s.scope === 'native-display-link').length, 'nativeInterval'), scope: 'display-link callbacks; not presented frames' }, warmupMs, durationSeconds: seconds, presentation, presentationModes: [...presentationModes], stages,
      frameInterval: { ...quantiles(samples.filter(s => s.stage === 'tick' && s.intervalMs !== undefined).map(s => s.intervalMs)), status: status(samples.filter(s => s.stage === 'tick' && s.intervalMs !== undefined).length, 'raf') },
      readbackBytes: pixelBytes, readbackBytesPerSecond: seconds > 0 ? pixelBytes / seconds : null,
      handoffBytes: captures.filter(s=>s.discarded===0).reduce((sum,s)=>sum+(s.bytes??0),0),
      discardedReadbackBytes: captures.filter(s=>s.discarded===1).reduce((sum,s)=>sum+(s.bytes??0),0),
      uploadBytes: null, uploadScope: 'Not instrumented; handoff bytes are not completed GPU uploads',
      discardedCaptures: captures.filter(s => s.discarded).length, dimensions,
      droppedSamples: batches.reduce((sum, batch) => sum + (batch.dropped ?? 0), 0),
      limitations: ['Instrumented intervals, not sampled JS stacks or GPU time', 'Native editor spans are CPU wall time; UI rendering and worker elapsed are not GPU or present timing', 'Handoff is synchronous dispatch/upload only; not presented-frame latency', 'Frame intervals are WebView callbacks, not presented FPS', 'No per-action isolation unless the run contains one action', 'Only completed readbacks contribute byte totals'],
    },
  };
}

export function exportTimings(input, output = path.dirname(input)) {
  const text = fs.readFileSync(input, 'utf8');
  const lines = text.split('\n');
  if (lines.at(-1)) lines.pop(); // A writer may currently be appending the last JSON line.
  const batches = lines.filter(Boolean).map(line => JSON.parse(line));
  const report = summarizeTimings(batches);
  fs.mkdirSync(output, { recursive: true });
  for (const [name, value] of Object.entries({ 'trace.json': report.trace, 'series.json': report.series, 'summary.json': report.summary })) {
    const file = path.join(output, name);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value)); fs.renameSync(`${file}.tmp`, file);
  }
  return report.summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw Error('Usage: node export-webview-performance.mjs capture.jsonl [output-directory]');
  exportTimings(path.resolve(process.argv[2]), process.argv[3] && path.resolve(process.argv[3]));
}
