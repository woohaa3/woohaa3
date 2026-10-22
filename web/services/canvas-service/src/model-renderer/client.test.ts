import { describe, expect, it } from 'vitest';
import { createRendererClient, type RendererSceneRequest } from './client.js';

const request: RendererSceneRequest = {
  requestId: 'fragmented', sceneVersion: 'woohaa-model-scene-ir-v2', signature: 'test', extent: 1, ops: [],
  capture: { width: 64, height: 64, background: '#20242a', cameraPreset: 'initial' }
};

describe('renderer framed response', () => {
  it('retains the parsed response header while PNG arrives in separate chunks, including the next request', async () => {
    const worker = `
      let input = Buffer.alloc(0);
      const frame = data => { const h = Buffer.alloc(4); h.writeUInt32BE(data.length); return Buffer.concat([h,data]); };
      process.stdin.on('data', chunk => {
        input = Buffer.concat([input,chunk]);
        if(input.length < 4 || input.length < 4+input.readUInt32BE()) return;
        input = input.subarray(4+input.readUInt32BE());
        const png = Buffer.from('test-png-bytes');
        const header = frame(Buffer.from(JSON.stringify({ok:true,pngLen:png.length})));
        process.stdout.write(header);
        setTimeout(() => process.stdout.write(frame(png).subarray(0,6)), 25);
        setTimeout(() => process.stdout.write(frame(png).subarray(6)), 50);
      });
    `;
    const client = createRendererClient({ command: process.execPath, args: ['-e',worker], timeoutMs: 3000 });
    try {
      for (let i = 0; i < 2; i++) {
        const result = await client.render({ ...request, requestId: `fragmented-${i}` });
        expect(result.ok).toBe(true);
        if(result.ok) expect(result.png.toString()).toBe('test-png-bytes');
      }
    } finally { await client.close(); }
  });
});

it('distinguishes missing configuration from process start failure without exposing host paths', async () => {
  const absent = createRendererClient();
  expect(await absent.render(request)).toMatchObject({ ok: false, code: 'renderer-unavailable' });
  await absent.close();
  let reportStartError!: () => void;
  const started = new Promise<void>(resolve => { reportStartError = resolve; });
  const client = createRendererClient({ command: '/nonexistent-audit-renderer', restartOnExit: false,
    logger: event => { if (event.event === 'model-renderer-error') reportStartError(); } });
  try {
    await started;
    const result = await client.render(request);
    expect(result).toMatchObject({ ok: false, code: 'renderer-start-failed' });
    expect(!result.ok && result.message).not.toContain('/nonexistent');
  } finally { await client.close(); }
});
