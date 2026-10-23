import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const entry=fileURLToPath(new URL('./desktop-host.mjs',import.meta.url));
test('host heartbeat is emitted before even a failed initialization; control stdout remains JSONL',()=>{
 const result=spawnSync(process.execPath,[entry,'--instance','diagnostic-test'],{encoding:'utf8',timeout:5000});
 assert.equal(result.status,1);
 const frames=result.stdout.trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(frames[0].type,'heartbeat');assert.equal(frames.at(-1).type,'error');
});
test('archive helper invocation does not emit running-host heartbeats',()=>{
 const result=spawnSync(process.execPath,[entry,'--export','unused'],{encoding:'utf8',timeout:5000});
 const frames=result.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 assert(!frames.some(frame=>frame.type==='heartbeat'));
});
