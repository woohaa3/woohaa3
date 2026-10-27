import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync,unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { collectBuildIdentity } from './metadata.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'canvas-build-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const dist=join(root,'web/frontend/dist-benchmark');mkdirSync(join(dist,'assets'),{recursive:true});mkdirSync(join(root,'bevy/target'),{recursive:true});
 const wasm=Buffer.from('tiny-test-wasm');
 for(const [name,data] of Object.entries({'index.html':'<html>benchmark</html>','assets/index.js':'new URL("./woohaa_bevy_canvas_bg-a.wasm", import.meta.url)','assets/style.css':'body{}','assets/font.woff2':'font','assets/custom.wgsl':'shader','assets/woohaa_bevy_canvas_bg-a.wasm':wasm,'assets/index.js.map':'{}'}))writeFileSync(join(dist,name),data);
 const stamp={mode:'performance',profile:'release',optEnabled:true,keepNames:true,rawWasmSha256:sha('raw'),opt:{args:['-O3'],version:'test'},outputs:{'woohaa_bevy_canvas_bg.wasm':sha(wasm)}};
 const stampPath=join(root,'bevy/target/bevy-wasm-build.stamp.json');writeFileSync(stampPath,JSON.stringify(stamp));
 return {root,dist,stamp,stampPath};
}
test('build identity hashes runtime files deterministically and excludes maps',t=>{
 const f=fixture(t);const a=collectBuildIdentity({clientRoot:f.root});
 assert.equal(a.buildMode,'performance');assert.match(a.buildId,/^[a-f0-9]{64}$/);assert.equal(a.files.length,6);
 assert.deepEqual(a,collectBuildIdentity({clientRoot:f.root}));assert.equal(a.stamp.rawWasmSha256,f.stamp.rawWasmSha256);assert.deepEqual(a.stamp.opt,f.stamp.opt);
 writeFileSync(join(f.dist,'assets/index.js.map'),'changed map');assert.equal(collectBuildIdentity({clientRoot:f.root}).buildId,a.buildId);
 writeFileSync(join(f.dist,'assets/custom.wgsl'),'changed shader');assert.notEqual(collectBuildIdentity({clientRoot:f.root}).buildId,a.buildId);
});
test('incomplete runtime or mismatched WASM stamp cannot claim a performance build',t=>{
 const f=fixture(t);
 writeFileSync(join(f.dist,'assets/woohaa_bevy_canvas_bg-a.wasm'),'different');assert.throws(()=>collectBuildIdentity({clientRoot:f.root}),/WASM.*stamp/i);
 unlinkSync(join(f.dist,'assets/woohaa_bevy_canvas_bg-a.wasm'));assert.throws(()=>collectBuildIdentity({clientRoot:f.root}),/WASM/i);
 unlinkSync(join(f.dist,'index.html'));assert.throws(()=>collectBuildIdentity({clientRoot:f.root}),/index.html/i);
});
test('development or unoptimized stamps are rejected',t=>{
 const f=fixture(t);
 for(const patch of [{mode:'development'},{profile:'dev'},{optEnabled:false}]) {
  writeFileSync(f.stampPath,JSON.stringify({...f.stamp,...patch}));assert.throws(()=>collectBuildIdentity({clientRoot:f.root}),/performance.*release.*opt/i);
 }
});

test('unused matching WASM cannot mask wrong Bevy, and ambiguous candidates are rejected',t=>{
 const f=fixture(t);
 writeFileSync(join(f.dist,'assets/other.wasm'),'tiny-test-wasm');
 writeFileSync(join(f.dist,'assets/woohaa_bevy_canvas_bg-a.wasm'),'wrong');
 assert.throws(()=>collectBuildIdentity({clientRoot:f.root}),/WASM.*stamp/i);
 writeFileSync(join(f.dist,'assets/woohaa_bevy_canvas_bg-a.wasm'),'tiny-test-wasm');
 assert.equal(collectBuildIdentity({clientRoot:f.root}).buildMode,'performance');
 writeFileSync(join(f.dist,'assets/woohaa_bevy_canvas_bg-b.wasm'),'tiny-test-wasm');
 assert.throws(()=>collectBuildIdentity({clientRoot:f.root}),/exactly one.*Bevy/i);
});
test('served JavaScript must reference the canonical Bevy WASM filename',t=>{
 const f=fixture(t);writeFileSync(join(f.dist,'assets/index.js'),'new URL("./other.wasm", import.meta.url)');
 assert.throws(()=>collectBuildIdentity({clientRoot:f.root}),/JavaScript.*reference/i);
});
