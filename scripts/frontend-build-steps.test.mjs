import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FRONTEND_BUILD_STEPS } from './lib/desktop-release.mjs';

test('desktop source builds generate the canvas WASM and the PhotoCraft app before Vite', () => {
  const vite = FRONTEND_BUILD_STEPS.findIndex(step => step.includes('@woohaa3/frontend'));
  for (const script of ['scripts/build-bevy-wasm.mjs', 'scripts/sync-photocraft-app.mjs']) {
    const index = FRONTEND_BUILD_STEPS.findIndex(step => step.includes(script));
    assert.ok(index >= 0 && index < vite, `${script} must run before frontend build`);
    assert.ok(fs.existsSync(new URL(`../${script}`, import.meta.url)));
  }
});
