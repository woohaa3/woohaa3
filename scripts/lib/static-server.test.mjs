import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createStaticHandler } from './static-server.mjs';
let dir, server, base;
const payload = Buffer.from('wasm fixture '.repeat(1000));
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'woohaa-static-'));
  await fs.mkdir(path.join(dir,'assets'));
  await fs.writeFile(path.join(dir,'index.html'),'<title>Woohaa</title>');
  await fs.writeFile(path.join(dir,'assets/canvas-ABCDEFGH.wasm'),payload);
  await fs.writeFile(path.join(dir,'canvas.wasm'),payload);
  server=http.createServer(createStaticHandler(dir));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
function request(url, headers={}, method='GET') {
  return new Promise((resolve,reject)=>{
    const req=http.request(base+url,{headers,method},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
    });req.on('error',reject);req.end();
  });
}
test('gzip transfers fewer bytes while preserving WASM MIME and payload',async()=>{
  const res=await request('/assets/canvas-ABCDEFGH.wasm',{'accept-encoding':'br, gzip'});
  assert.equal(res.status,200);assert.equal(res.headers['content-type'],'application/wasm');
  assert.equal(res.headers['content-encoding'],'gzip');assert.equal(res.headers.vary,'Accept-Encoding');
  assert.deepEqual(gunzipSync(res.body),payload);assert.ok(res.body.length < payload.length/10);
  assert.match(res.headers['cache-control'],/immutable/);
});
test('explicit gzip rejection overrides wildcard; identity has exact content length',async()=>{
  for(const encoding of ['gzip;q=0, *;q=1','br','gzip;q=invalid']) {
    const res=await request('/canvas.wasm',{'accept-encoding':encoding});
    assert.equal(res.headers['content-encoding'],undefined);assert.equal(Number(res.headers['content-length']),payload.length);assert.deepEqual(res.body,payload);
  }
});
test('HEAD returns representation headers and no bytes',async()=>{
  const res=await request('/canvas.wasm',{'accept-encoding':'gzip'},'HEAD');
  assert.equal(res.status,200);assert.equal(res.headers['content-encoding'],'gzip');assert.equal(res.body.length,0);
  assert.equal(res.headers['cache-control'],'no-cache');
});
test('SPA routes revalidate and missing assets never return HTML',async()=>{
  assert.equal((await request('/task-history')).headers['cache-control'],'no-cache');
  assert.equal((await request('/missing.wasm')).status,404);
  assert.equal((await request('/%ZZ')).status,400);
  assert.equal((await request('/..%2foutside.wasm')).status,403);
});
test('production shared static handler exposes no development collector write API',async()=>{
  const res=await request('/__dev/performance/interactions',{'content-type':'application/json'},'POST');
  // An unknown SPA path can return HTML; it must not behave like the JSON sink.
  assert.equal(res.headers['content-type'],'text/html; charset=utf-8');
  // 应用 HTML 在响应时注入公开挂载元数据（change: 2026-10-15-support-configurable-app-base-path）。
  assert.match(res.body.toString(), /<title>Woohaa<\/title>/);
  assert.match(res.body.toString(), /name="woohaa-app-base-path" content="\/"/);
  assert.deepEqual((await fs.readdir(dir)).sort(),['assets','canvas.wasm','index.html']);
});
test('HTML 响应按启动标题注入，保留 gzip、HEAD 与原文件字节',async()=>{
  const html = `<html><head><title>构建默认标题</title></head><body>${'fixture '.repeat(300)}</body></html>`;
  const titleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'woohaa-static-title-'));
  const original = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
  await fs.writeFile(path.join(titleDir, 'index.html'), html);
  const titled = http.createServer((req, res) => { req.url = '/'; createStaticHandler(titleDir, { basePath: '/tools/preview/', pageTitle: 'WooHaa3 · 预览' })(req, res); });
  await new Promise(resolve => titled.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${titled.address().port}/`;
  const get = (method) => new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { 'accept-encoding': 'gzip' } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
  try {
    const res = await get('GET');
    assert.equal(res.status, 200);
    const body = gunzipSync(res.body).toString();
    assert.match(body, /<title>WooHaa3 · 预览<\/title>/);
    assert.match(body, /<base href="\/tools\/preview\/"/);
    assert.equal(res.headers['cache-control'], 'no-cache');
    const head = await get('HEAD');
    assert.equal(head.headers['content-encoding'], 'gzip');
    assert.equal(head.body.length, 0);
    // 标题只在响应时替换，构建文件字节不变。
    assert.equal(await fs.readFile(path.join(titleDir, 'index.html'), 'utf8'), html);
    assert.equal(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), original);
  } finally {
    await new Promise(resolve => titled.close(resolve));
    await fs.rm(titleDir, { recursive: true, force: true });
  }
});
