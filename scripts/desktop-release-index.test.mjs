import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseSettings, buildReleaseIndex, resolveUpdateChannel, updateChannelFromEnv, mergeReleaseIndex, newerVersion } from './lib/desktop-release-index.mjs';
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

test('GitHub 通道按平台拆分索引资产，归档走具体 tag',()=>{
 const mac=releaseSettings({platform:'darwin',arch:'arm64',github:{repo:'acme/woohaa'}});
 assert.equal(mac.platformKey,'darwin-aarch64');
 assert.equal(mac.assetName,'latest-darwin-aarch64.json');
 assert.equal(mac.endpoint,'https://github.com/acme/woohaa/releases/latest/download/latest-darwin-aarch64.json');
 const win=releaseSettings({platform:'win32',arch:'x64',github:{repo:'acme/woohaa'}});
 assert.equal(win.assetName,'latest-windows-x86_64.json');
 const manifest={product:{version:'1.2.3'},artifacts:[{name:'WooHaa3.app.tar.gz',path:'mac/archive'},{name:'WooHaa3.app.tar.gz.sig',path:'mac/signature'}]};
 const index=buildReleaseIndex({manifest,platform:'darwin',arch:'arm64',channel:mac.channel,signature:'sig',pubDate:'now'});
 assert.equal(index.latest.platforms['darwin-aarch64'].url,'https://github.com/acme/woohaa/releases/download/v1.2.3/WooHaa3.app.tar.gz');
 assert.equal(index.assetName,'latest-darwin-aarch64.json');
});

test('GitHub 预发布 tag 与自定义资产名',()=>{
 const channel=resolveUpdateChannel({platformKey:'windows-x86_64',github:{repo:'acme/woohaa',release:'v1.2.3-rc.1',asset:'beta.json',tagPrefix:'v'}});
 assert.equal(channel.endpoint,'https://github.com/acme/woohaa/releases/download/v1.2.3-rc.1/beta.json');
 assert.equal(channel.tagFor('9.9.9'),'v1.2.3-rc.1');
 assert.equal(channel.archiveUrl('1.2.3-rc.1','setup.exe'),'https://github.com/acme/woohaa/releases/download/v1.2.3-rc.1/setup.exe');
});

test('两种通道互斥，GitHub 字段非法时提前失败',()=>{
 assert.throws(()=>resolveUpdateChannel({platformKey:'darwin-aarch64',endpoint:'https://cdn.example/latest.json',github:{repo:'acme/woohaa'}}),/二选一/);
 assert.throws(()=>resolveUpdateChannel({platformKey:'darwin-aarch64',github:{repo:'acme'}}),/owner\/name/);
 assert.throws(()=>resolveUpdateChannel({platformKey:'darwin-aarch64',github:{repo:'acme/woohaa',asset:'../x.json'}}),/asset/i);
 assert.throws(()=>resolveUpdateChannel({platformKey:'darwin-aarch64',github:{repo:'acme/woohaa',release:'v1/2'}}),/tag/i);
});

test('环境变量解析：endpoint 与 github 二选一、公钥必填',()=>{
 assert.equal(updateChannelFromEnv({}, {platform:'darwin',arch:'arm64'}),null);
 assert.throws(()=>updateChannelFromEnv({WOOHAA_DESKTOP_UPDATE_GITHUB_REPO:'acme/woohaa'},{platform:'darwin',arch:'arm64'}),/PUBLIC_KEY/);
 assert.throws(()=>updateChannelFromEnv({WOOHAA_DESKTOP_UPDATE_ENDPOINT:'https://cdn.example/latest.json',WOOHAA_DESKTOP_UPDATE_GITHUB_REPO:'acme/woohaa',WOOHAA_DESKTOP_UPDATE_PUBLIC_KEY:'k'},{platform:'darwin',arch:'arm64'}),/二选一/);
 const github=updateChannelFromEnv({WOOHAA_DESKTOP_UPDATE_GITHUB_REPO:'acme/woohaa',WOOHAA_DESKTOP_UPDATE_PUBLIC_KEY:'k'},{platform:'darwin',arch:'arm64'});
 assert.deepEqual(github.updater,{publicKey:'k',github:{repo:'acme/woohaa',asset:'latest-darwin-aarch64.json',release:'latest'}});
 const endpoint=updateChannelFromEnv({WOOHAA_DESKTOP_UPDATE_ENDPOINT:'https://cdn.example/latest.json',WOOHAA_DESKTOP_UPDATE_PUBLIC_KEY:'k'},{platform:'win32',arch:'x64'});
 assert.deepEqual(endpoint.updater,{endpoint:'https://cdn.example/latest.json',publicKey:'k'});
});

test('平台索引合并：同版本补齐平台，跨版本不混用旧归档',()=>{
 const darwin={version:'1.2.3',notes:'a',pub_date:'t1',platforms:{'darwin-aarch64':{url:'u-mac',signature:'s1'}}};
 const windows={version:'1.2.3',notes:'b',pub_date:'t2',platforms:{'windows-x86_64':{url:'u-win',signature:'s2'}}};
 const merged=mergeReleaseIndex({existing:darwin,incoming:windows});
 assert.deepEqual(Object.keys(merged.platforms).sort(),['darwin-aarch64','windows-x86_64']);
 assert.equal(merged.version,'1.2.3');
 const next=mergeReleaseIndex({existing:merged,incoming:{version:'1.3.0',notes:'c',pub_date:'t3',platforms:{'windows-x86_64':{url:'u-win2',signature:'s3'}}}});
 assert.deepEqual(Object.keys(next.platforms),['windows-x86_64']);
 assert.equal(next.version,'1.3.0');
 assert.equal(mergeReleaseIndex({existing:null,incoming:darwin}),darwin);
 assert.equal(newerVersion('1.2.3','1.2.3-rc.1'),'1.2.3');
 assert.equal(newerVersion('1.2.10','1.2.9'),'1.2.10');
});
