import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createStaticHandler, serveFile } from './static-server.mjs';
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

// 回归：缺文件必须 404，**绝不能把宿主进程打死**。
//
// 现场：`browser-dist/` 是整目录替换的，宿主按启动时的目录建了映射，之后重建扩展，
// 旧入口文件就没了；请求仍然带着旧路径。`statSync` 抛出的 ENOENT 一度没被接住，
// 一路冒到 `uncaughtException`，整个宿主进程退出 —— 桌面端表现是一直卡在启动页，
// 5174/5181 一起消失，日志里只有一条 ENOENT。发生过两次。
//
// 这条用例直接调 `serveFile`（绕开静态处理器里先做存在性判断的那条路径），
// 才能命中"路由判定时还在、读盘时已消失"的真实条件。
test('serveFile 对缺失文件返回 404 而不是抛异常', async () => {
  const server = http.createServer((req, res) => {
    serveFile(req, res, path.join(dir, 'gone', 'entry-vanished-ABCDEFGH.js'), { immutable: true });
  });
  const crashes = [];
  // 漏出去的异常会在这里被捕获；不装的话 node 会按 uncaughtException 记一条
  const onUncaught = (error) => crashes.push(error);
  process.on('uncaughtException', onUncaught);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/extensions/x/gone.js`;
  // `agent: false` 让每个请求用完即关：Node 19+ 的 globalAgent 默认 keepAlive，
  // 留着空闲连接时 `server.close()` 会一直等下去（这条用例最早就是卡在这里）。
  const call = (method) => new Promise((resolve, reject) => {
    const req = http.request(url, { method, agent: false }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    const res = await call('GET');
    assert.equal(res.status, 404);
    assert.equal(res.body, 'not found');
    // 服务仍然活着：同一个端口再请求一次照样有响应
    assert.equal(server.listening, true);
    assert.equal((await call('HEAD')).status, 404);
    assert.deepEqual(crashes, [], '缺失文件不应产生未捕获异常');
  } finally {
    process.off('uncaughtException', onUncaught);
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
