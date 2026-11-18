import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseSettings, buildReleaseIndex, prereleaseTag } from './lib/desktop-release-index.mjs';
import { macBundleVersionFor } from './lib/desktop-release.mjs';
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

test('残留上一版安装包时按本次版本收敛，而不是直接失败',()=>{
 // 复现真实事故：暖机工作区里 bundle/nsis 同时留着 0.1.8 与 0.1.9 的安装包。
 const manifest={product:{version:'0.1.9'},artifacts:[
  {name:'WooHaa3_0.1.8_x64-setup.exe',path:'bundle/old.exe'},
  {name:'WooHaa3_0.1.8_x64-setup.exe.sig',path:'bundle/old.exe.sig'},
  {name:'WooHaa3_0.1.9_x64-setup.exe',path:'bundle/new.exe'},
  {name:'WooHaa3_0.1.9_x64-setup.exe.sig',path:'bundle/new.exe.sig'}
 ]};
 const result=buildReleaseIndex({manifest,platform:'win32',arch:'x64',endpoint:'https://updates.example.com/windows/latest.json',signature:'s'});
 assert.equal(result.archive.name,'WooHaa3_0.1.9_x64-setup.exe');
 assert.equal(result.signature.name,'WooHaa3_0.1.9_x64-setup.exe.sig');
 assert.match(result.latest.platforms['windows-x86_64'].url,/WooHaa3_0\.1\.9_x64-setup\.exe$/);
});

test('收敛不出唯一候选时把候选清单带进错误信息',()=>{
 // 两个候选都不属于本次版本（例如产品名变了），不能瞎选，也不能只吐一句无从下手的报错。
 const manifest={product:{version:'0.2.0'},artifacts:[
  {name:'WooHaa3_0.1.8_x64-setup.exe',path:'a'},
  {name:'WooHaa3_0.1.9_x64-setup.exe',path:'b'}
 ]};
 assert.throws(
  ()=>buildReleaseIndex({manifest,platform:'win32',arch:'x64',endpoint:'https://updates.example.com/windows/latest.json',signature:'s'}),
  error=>{
   assert.match(error.message,/Expected exactly one updater archive/);
   assert.match(error.message,/0\.2\.0/);
   assert.match(error.message,/WooHaa3_0\.1\.8_x64-setup\.exe/);
   assert.match(error.message,/WooHaa3_0\.1\.9_x64-setup\.exe/);
   return true;
  }
 );
});

test('signed releases require an explicit HTTPS endpoint',()=>{
 assert.throws(()=>releaseSettings({platform:'darwin',arch:'arm64'}),/endpoint/i);
 assert.throws(()=>releaseSettings({platform:'darwin',arch:'arm64',endpoint:'http://example.com/latest.json'}),/HTTPS/);
});

test('stable 通道拒绝预发布版本，alpha 通道接受',()=>{
 const manifest={product:{version:'0.2.0-alpha.3'},artifacts:[
  {name:'Actual.app.tar.gz',path:'mac/archive'},
  {name:'Actual.app.tar.gz.sig',path:'mac/signature'}
 ]};
 // 预发布版落进 stable feed 等于对所有用户强制推送开发者版本。
 assert.throws(
  ()=>buildReleaseIndex({manifest,platform:'darwin',arch:'arm64',endpoint:'https://updates.example.com/stable/darwin-aarch64/latest.json',signature:'s'}),
  /stable 通道不能发布预发布版本/
 );
 const alpha=buildReleaseIndex({manifest,platform:'darwin',arch:'arm64',channel:'alpha',endpoint:'https://updates.example.com/alpha/darwin-aarch64/latest.json',signature:'s'});
 assert.equal(alpha.channel,'alpha');
 assert.equal(alpha.prerelease,true);
 assert.equal(alpha.latest.version,'0.2.0-alpha.3');
 assert.match(alpha.latest.platforms['darwin-aarch64'].url,/^https:\/\/updates\.example\.com\/alpha\/darwin-aarch64\/0\.2\.0-alpha\.3\//);
});

test('alpha 通道仍可发布正式版（转正后复用同一 feed）',()=>{
 const manifest={product:{version:'0.2.0'},artifacts:[{name:'Actual.app.tar.gz',path:'a'},{name:'Actual.app.tar.gz.sig',path:'s'}]};
 const result=buildReleaseIndex({manifest,platform:'darwin',arch:'arm64',channel:'alpha',endpoint:'https://updates.example.com/alpha/darwin-aarch64/latest.json',signature:'s'});
 assert.equal(result.prerelease,false);
 assert.equal(result.latest.version,'0.2.0');
});

test('通道名非法时拒绝',()=>{
 const manifest={product:{version:'0.2.0'},artifacts:[{name:'Actual.app.tar.gz',path:'a'},{name:'Actual.app.tar.gz.sig',path:'s'}]};
 for(const channel of ['Alpha','../alpha','alpha/beta','']){
  assert.throws(()=>releaseSettings({platform:'darwin',arch:'arm64',channel,endpoint:'https://updates.example.com/latest.json'}),/channel/i);
 }
});

test('prereleaseTag 只取预发布后缀',()=>{
 assert.equal(prereleaseTag('0.2.0-alpha.3'),'alpha.3');
 assert.equal(prereleaseTag('0.2.0-rc.1'),'rc.1');
 assert.equal(prereleaseTag('0.2.0'),'');
 assert.equal(prereleaseTag('0.2.0+build.7'),'');
});

test('macBundleVersionFor 只对预发布版给出纯数字构建号',()=>{
 assert.equal(macBundleVersionFor('0.2.0-alpha.3'),'0.2.0.3');
 assert.equal(macBundleVersionFor('0.2.0-rc.12'),'0.2.0.12');
 assert.equal(macBundleVersionFor('0.2.0-beta'),'0.2.0.0');
 // 正式版不写该字段，产物与改造前一致。
 assert.equal(macBundleVersionFor('0.2.0'),null);
 assert.equal(macBundleVersionFor(null),null);
});
