import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseSettings, buildReleaseIndex } from './lib/desktop-release-index.mjs';
test('platform release roots isolate Windows from macOS',()=>{
 const win=releaseSettings({platform:'win32',arch:'x64',endpoint:'https://updates.example.com/windows/latest.json'}); const mac=releaseSettings({platform:'darwin',arch:'arm64',endpoint:'https://updates.example.com/latest.json'});
 assert.equal(win.endpoint,'https://updates.example.com/windows/latest.json');
 assert.equal(win.output,'artifacts/desktop/standalone-windows-x64'); assert.equal(win.bundle,'nsis');
 assert.equal(mac.output,'artifacts/desktop/standalone-apple-silicon'); assert.equal(mac.bundle,'app');
 assert.equal(mac.endpoint,'https://updates.example.com/latest.json');
 assert.throws(()=>releaseSettings({platform:'win32',arch:'arm64'}),/x64/);
});
test('index uses actual NSIS filename, exact signature pair and endpoint override',()=>{
 const manifest={product:{version:'1.2.3'},artifacts:[{name:'Custom Product_1.2.3_x64-setup.exe',path:'bundle/custom.exe'},{name:'Custom Product_1.2.3_x64-setup.exe.sig',path:'bundle/custom.exe.sig'}]};
 const result=buildReleaseIndex({manifest,platform:'win32',arch:'x64',endpoint:'https://updates.example.com/windows/latest.json',signature:' sig\n',pubDate:'now'});
 assert.equal(result.latest.platforms['windows-x86_64'].url,'https://updates.example.com/windows/1.2.3/Custom%20Product_1.2.3_x64-setup.exe');
 assert.equal(result.latest.platforms['windows-x86_64'].signature,'sig'); assert.equal(result.archive.path,'bundle/custom.exe');
 assert.equal(result.versionDir,'1.2.3');
 assert.equal(buildReleaseIndex({manifest,platform:'win32',arch:'x64',endpoint:'https://updates.example.com/windows/latest.json',signature:'s',endpoint:'https://example.com/win/latest.json'}).latest.platforms['windows-x86_64'].url,'https://example.com/win/1.2.3/Custom%20Product_1.2.3_x64-setup.exe');
 assert.throws(()=>buildReleaseIndex({manifest:{...manifest,artifacts:[manifest.artifacts[0],{name:'other.exe.sig'}]},platform:'win32',arch:'x64',endpoint:'https://updates.example.com/windows/latest.json',signature:'s'}),/signature/);
 assert.throws(()=>buildReleaseIndex({manifest:{...manifest,product:{version:'../mac'}},platform:'win32',arch:'x64',endpoint:'https://updates.example.com/windows/latest.json',signature:'s'}),/version/);
});
test('macOS updater filename and URL stay unchanged, insecure endpoints rejected',()=>{
 const manifest={product:{version:'0.1.0'},artifacts:[{name:'Actual.app.tar.gz',path:'mac/archive'},{name:'Actual.app.tar.gz.sig',path:'mac/signature'}]};
 const result=buildReleaseIndex({manifest,platform:'darwin',arch:'arm64',endpoint:'https://updates.example.com/latest.json',signature:'signature'});
 assert.equal(result.latest.platforms['darwin-aarch64'].url,'https://updates.example.com/0.1.0/Actual.app.tar.gz');
 assert.equal(result.latest.platforms['windows-x86_64'],undefined);
 assert.throws(()=>buildReleaseIndex({manifest,platform:'darwin',arch:'arm64',endpoint:'https://updates.example.com/latest.json',signature:'signature',endpoint:'http://example.com/latest.json'}),/HTTPS/);
});

test('signed releases require an explicit HTTPS endpoint',()=>{
 assert.throws(()=>releaseSettings({platform:'darwin',arch:'arm64'}),/endpoint/i);
 assert.throws(()=>releaseSettings({platform:'darwin',arch:'arm64',endpoint:'http://example.com/latest.json'}),/HTTPS/);
});
