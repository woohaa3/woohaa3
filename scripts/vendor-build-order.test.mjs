import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const {scripts}=JSON.parse(fs.readFileSync(new URL('../web/package.json',import.meta.url),'utf8'));
test('clean host builds vendor runtime exports before SDK and extensions',()=>{
 const steps=scripts['build:sdk'].split('&&').map(step=>step.trim());
 assert.deepEqual(steps,[
  'pnpm --filter @sdppp/pptask run build',
  'pnpm --filter @sdppp/pptask-worker-server run build',
  'pnpm --filter @woohaa3/provider-sdk run build'
 ]);
 const units=scripts['build:units'];
 assert.ok(units.indexOf('build:sdk')<units.indexOf('build:plugins'));
 assert.ok(units.indexOf('build:sdk')<units.indexOf('build:backend'));
});
