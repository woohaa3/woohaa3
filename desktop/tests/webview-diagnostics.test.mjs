import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=()=>fs.readFileSync(new URL('../src/webview-diagnostics.js',import.meta.url),'utf8');
function boot(fetch=async()=>({ok:true})){
 const listeners={},timers=[],calls=[],original=[];
 const window={__WOOHAA_NATIVE__:{token:'private-token',platform:'macos'},addEventListener:(type,fn)=>listeners[type]=fn};window.top=window;window.self=window;
 const context={window,document:{visibilityState:'visible'},console:{warn:(...a)=>original.push(a),error:(...a)=>original.push(a)},fetch:(...args)=>{calls.push(args);return fetch(...args);},setInterval:fn=>timers.push(fn),setTimeout:()=>0,clearTimeout(){},URL,AbortController,TextEncoder,Date,JSON,String,Error,performance:{now:()=>10}};
 vm.runInNewContext(source(),context);return {listeners,timers,calls,original,context};
}
test('captures early exceptions and rejection; preserves console; strips credentials',async()=>{
 const b=boot();b.context.console.error('token=abc https://example.com/a?key=secret',new Error('failure'));
 b.listeners.error({message:'broken',filename:'https://app/a.js?token=secret',lineno:2,colno:3,error:new Error('broken')});
 b.listeners.unhandledrejection({reason:new Error('async failure')});
 await b.timers[0]();const payload=JSON.parse(b.calls[0][1].body);
 assert.equal(b.original.length,1);assert(payload.events.some(e=>e.event==='unhandledrejection'));assert(payload.events.some(e=>e.event==='error'));
 assert(!b.calls[0][1].body.includes('secret'));assert(!b.calls[0][1].body.includes('token=abc'));assert.equal(b.calls[0][1].headers['X-Woohaa-Token'],'private-token');
});
test('cyclic and throwing console objects cannot break page; queue bounded during outage',async()=>{
 const b=boot(async()=>{throw Error('offline');});const cyclic={};cyclic.self=cyclic;
 b.context.console.warn(cyclic);for(let i=0;i<500;i++)b.context.console.warn('x'.repeat(10000));
 await b.timers[0]();assert(b.calls[0][1].body.length<70000);assert.equal(b.original.length,501);
 await b.timers[0]();assert.equal(b.calls.length,2);
});
test('installs only once in top frame',()=>{const b=boot();vm.runInNewContext(source(),b.context);assert.equal(b.timers.length,1);});
test('fetch errors preserve response/rejection and omit query data; collector does not recurse',async()=>{
 let count=0;const response={ok:false,status:503};
 const b=boot(async()=>{if(++count===1)return response;throw new Error('network down');});
 assert.equal(await b.context.fetch('https://example.test/api?token=secret'),response);
 await assert.rejects(b.context.fetch('https://example.test/api?key=secret'),/network down/);
 await b.timers[0]();const payload=JSON.parse(b.calls[2][1].body);
 assert.equal(payload.events.filter(e=>e.event==='request-failed').length,2);
 assert(!b.calls[2][1].body.includes('secret'));assert.equal(b.calls.length,3);
});
test('only one diagnostics upload is in flight',async()=>{
 let finish;const b=boot(()=>new Promise(resolve=>{finish=resolve;}));
 const first=b.timers[0]();await b.timers[0]();assert.equal(b.calls.length,1);
 finish({ok:true});await first;await Promise.resolve();
});

test('UTF-8 batches stay within native payload budget for long Chinese messages',async()=>{
 const b=boot();for(let i=0;i<40;i++)b.context.console.warn('中'.repeat(3000));
 await b.timers[0]();assert(Buffer.byteLength(b.calls[0][1].body)<65536);
 assert(JSON.parse(b.calls[0][1].body).events.length<20);
 await b.timers[0]();assert(Buffer.byteLength(b.calls[1][1].body)<65536);
});
