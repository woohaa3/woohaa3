import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTimings } from './export-webview-performance.mjs';
test('excludes warmup, counts discarded readbacks and keeps async wait separate', () => {
  const s = (stage, startMs, extra = {}) => ({ scope: 'image-edit', frame: startMs, timeOrigin: 10000, startMs, stage, durationMs: 2, ...extra });
  const result = summarizeTimings([{ dropped: 3, samples: [s('tick', 0), s('readback', 100), s('readback', 1100), s('bitmap', 1100, { durationMs: 30 }), s('capture', 1100, { width: 2, height: 2, sourceWidth: 4000, sourceHeight: 3000, bytes: 16, discarded: 1 }), s('tick', 2000, { intervalMs: 20 })] }]);
  assert.equal(result.summary.stages.readback.count, 1);
  assert.equal(result.summary.readbackBytesPerSecond, 16);
  assert.equal(result.summary.discardedCaptures, 1);
  assert.equal(result.summary.droppedSamples, 3);
  assert.equal(result.summary.stages.handoff.p95Ms, null);
  assert.equal(result.trace.traceEvents.find(s => s.name === 'bitmap').tid, 2);
  assert.equal(result.trace.traceEvents.find(s => s.name === 'readback').args.sourceWidth, 4000);
});
test('empty capture reports uncollected metrics instead of zero latency', () => {
  const result = summarizeTimings([]);
  assert.equal(result.summary.stages.readback.p95Ms, null);
  assert.equal(result.summary.readbackBytesPerSecond, null);
  assert.equal(result.summary.frameInterval.p95Ms, null);
});
test('capabilities distinguish unsupported, empty and transport loss without zero timings', () => {
  for (const [capabilities, expected] of [[{ performance: 'unsupported' }, 'unsupported'], [{ performance: 'collected' }, 'not-collected'], [{ performance: 'dropped' }, 'dropped']]) {
    const report = summarizeTimings([{ samples: [], dropped: 0, capabilities }]);
    assert.equal(report.summary.stages.draw.status, expected);
    assert.equal(report.summary.stages.draw.p95Ms, null);
  }
});
test('raw native intervals remain separate when clock pairing uncertainty exceeds 1ms', () => {
  const batch = { samples: [{ scope: 'native-display-link', stage: 'interval', startMs: 20, timeOrigin: 0, durationMs: 16, intervalMs: 16 }], dropped: 0,
    nativeClockPair: { epochMs: 10020, monotonicMs: 20, uncertaintyMs: .01 } };
  const report = summarizeTimings([batch, { samples: [], dropped: 0, clockPair: { epochMs: 10000, monotonicMs: 0, webviewEpochMs: 10000, uncertaintyMs: 1.01 } }], { warmupMs: 0 });
  assert.equal(report.summary.nativeInterval.p95Ms, 16);
  assert.equal(report.summary.crossClockAlignment.status, 'not-collected');
  assert.equal(report.trace.traceEvents.find(e => e.cat === 'native-display-link').pid, 2);
  assert.equal(report.summary.frameInterval.p95Ms, null);
});
test('accurate clock pairing applies the measured offset on the native lane', () => {
  const report = summarizeTimings([{ samples: [{ scope: 'image-edit', stage: 'tick', startMs: 0, timeOrigin: 20000, frame: 1, durationMs: 0 }], dropped: 0,
    clockPair: { epochMs: 10000, webviewEpochMs: 20000, monotonicMs: 0, uncertaintyMs: .2 } },
  { samples: [{ scope: 'native-display-link', stage: 'interval', startMs: 20, timeOrigin: 0, durationMs: 16, intervalMs: 16 }], dropped: 0,
    nativeClockPair: { epochMs: 10020, monotonicMs: 20, uncertaintyMs: .1 } }], { warmupMs: 0 });
  const event = report.trace.traceEvents.find(e => e.cat === 'native-display-link');
  assert.equal(event.pid, 1); assert.equal(event.ts, 4000);
  assert.equal(event.args.clockAligned, true);
});

test('native editor spans retain operation correlation without contaminating frame intervals', () => {
  const sample=(stage,at,durationMs)=>({samples:[{scope:'native-editor',stage,frame:1,startMs:at,timeOrigin:0,durationMs,requestId:9,generation:2}],dropped:0,nativeClockPair:{epochMs:10000+at,monotonicMs:at,uncertaintyMs:.01}});
  const report=summarizeTimings([sample('ui-frame',0,20),sample('ui-frame',1100,3),sample('control-owner',1200,2)]);
  assert.equal(report.summary.nativeStages['ui-frame'].count,1);
  assert.equal(report.summary.nativeStages['ui-frame'].p95Ms,3);
  assert.equal(report.summary.nativeInterval.p95Ms,null);
  const event=report.trace.traceEvents.find(e=>e.name==='control-owner');
  assert.equal(event.args.requestId,9); assert.equal(event.args.generation,2);
});
test('presentation is observed, never hard-coded to readback', () => {
  assert.equal(summarizeTimings([]).summary.presentation, 'not-collected');
  const batch={nativeClockPair:{epochMs:10000,monotonicMs:0,uncertaintyMs:0.1},nativePresentation:'shared-gpu',samples:[]};
  const shared=summarizeTimings([batch]).summary;
  assert.equal(shared.presentation,'shared-gpu');assert.equal(shared.readbackBytes,0);
  const mixed=summarizeTimings([batch,{samples:[{scope:'image-edit',stage:'readback',frame:1,timeOrigin:10000,startMs:2000,durationMs:3}]}]).summary;
  assert.equal(mixed.presentation,'mixed');
  assert.equal(summarizeTimings([{...batch,nativePresentation:'native-cpu-viewport'}]).summary.presentation,'native-cpu-viewport');
});
test('separates bytes read from GPU from bytes handed to host and discarded bytes',()=>{
 const capture=(frame,bytes,discarded)=>({scope:'image-edit',stage:'capture',frame,timeOrigin:10000,startMs:2000+frame,durationMs:0,bytes,discarded});
 const report=summarizeTimings([{samples:[capture(0,10,0),capture(1,20,0),capture(2,30,1)]}],{warmupMs:0}).summary;
 assert.equal(report.readbackBytes,60);assert.equal(report.handoffBytes,30);assert.equal(report.discardedReadbackBytes,30);
 assert.equal(report.uploadBytes,null,'handoff does not prove a completed GPU upload');
});
test('summarizes long native recordings without spreading batches into call arguments', () => {
  const batches = Array.from({ length: 200000 }, () => ({ samples: [], capabilities: { nativeInterval: 'collected' } }));
  batches[0].capabilities.performance = 'collected';
  batches.at(-1).capabilities.nativeInterval = 'dropped';
  const { summary } = summarizeTimings(batches);
  assert.equal(summary.capabilities.performance, 'collected');
  assert.equal(summary.capabilities.nativeInterval, 'dropped');
});
