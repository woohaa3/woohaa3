import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeReleaseLayout } from './lib/runtime-release-layout.mjs';

test('runtime release directories isolate platform and app version',()=>{
 const win=runtimeReleaseLayout({platform:'win32',arch:'x64',version:'0.1.3',cdnBaseUrl:'https://cdn.example.com/woohaa/runtimes/'});
 assert.equal(runtimeReleaseLayout({platform:'win32',arch:'x64',version:'1.2.3+build.1',cdnBaseUrl:'https://cdn.example.com/runtime/'}).baseUrl,'https://cdn.example.com/runtime/windows-x86_64/1.2.3%2Bbuild.1/');
 assert.equal(win.relativeDirectory,'windows-x86_64/0.1.3');
 assert.equal(win.baseUrl,'https://cdn.example.com/woohaa/runtimes/windows-x86_64/0.1.3/');
 const mac=runtimeReleaseLayout({platform:'darwin',arch:'arm64',version:'0.1.4',cdnBaseUrl:'https://cdn.example.com/woohaa/runtimes'});
 assert.equal(mac.relativeDirectory,'darwin-aarch64/0.1.4');
 assert.equal(mac.baseUrl,'https://cdn.example.com/woohaa/runtimes/darwin-aarch64/0.1.4/');
 assert.equal(runtimeReleaseLayout({platform:'darwin',arch:'arm64',version:'0.1.3'}).baseUrl,'');
});
test('already scoped URLs are not duplicated and another release URL is rejected',()=>{
 const args={platform:'win32',arch:'x64',version:'0.1.3'};
 assert.equal(runtimeReleaseLayout({...args,cdnBaseUrl:'https://cdn.example.com/runtimes/windows-x86_64/0.1.3/'}).baseUrl,'https://cdn.example.com/runtimes/windows-x86_64/0.1.3/');
 assert.throws(()=>runtimeReleaseLayout({...args,cdnBaseUrl:'https://cdn.example.com/runtimes/windows-x86_64/0.1.2/'}),/release/i);
 assert.throws(()=>runtimeReleaseLayout({...args,cdnBaseUrl:'https://cdn.example.com/runtimes/darwin-aarch64/0.1.3/'}),/release/i);
});
test('layout rejects unsafe versions, unsupported platforms and unsafe CDN URLs',()=>{
 for(const version of ['../escape','1/2','01.2.3','1.2','1.2.3?x',''])assert.throws(()=>runtimeReleaseLayout({platform:'win32',arch:'x64',version}),/version/i);
 assert.throws(()=>runtimeReleaseLayout({platform:'win32',arch:'arm64',version:'1.2.3'}),/platform/i);
 for(const cdnBaseUrl of ['http://cdn.example.com/','https://u:p@cdn.example.com/','https://cdn.example.com/?secret=x'])assert.throws(()=>runtimeReleaseLayout({platform:'win32',arch:'x64',version:'1.2.3',cdnBaseUrl}),/CDN/i);
});
