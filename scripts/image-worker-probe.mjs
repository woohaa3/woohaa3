#!/usr/bin/env node
// CPU and protocol only. Never opens the application renderer or samples GPU output.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(new URL('../web/package.json',import.meta.url));
const { chromium } = require('@playwright/test');
const urls=process.argv.slice(2);
if(!urls.length)throw new Error('Usage: node scripts/image-worker-probe.mjs <baseline URL> [isolated experimental URL]');
const browser=await chromium.launch({headless:true,args:['--disable-gpu']});
const outputs=[];
try {
 for(const [index,input] of urls.entries()) {
  const base=new URL(input);if(!base.pathname.endsWith('/'))base.pathname+='/';
  for(const broken of index===0?[false]:[false,true]) {
   const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
   // A blank CPU probe under the real server headers avoids initialising Bevy on a GPU-less host.
   await page.route('**/image-cpu-probe',async route=>{const response=await route.fetch();await route.fulfill({response,body:'<!doctype html><title>Image CPU protocol probe</title>',contentType:'text/html'});});
   if(broken)await page.route('**/assets/media-image-threaded/media_image.js',route=>route.abort());
   await page.goto(new URL('image-cpu-probe',base).href);
   const fixtures={};for(const name of ['alpha.avif','alpha.webp','tagged.png','rotate.jpg','animated.gif'])fixtures[name]=readFileSync(new URL(`../media-image/tests/fixtures/${name}`,import.meta.url)).toString('base64');
   const result=await page.evaluate(async({fixtures,moduleUrl})=>{
    const {ImageWorkerPool}=await import(moduleUrl);const pool=new ImageWorkerPool();const samples=[];
    try {for(const [name,base64] of Object.entries(fixtures)) {
      const url=URL.createObjectURL(new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))]));
      try {const image=await pool.decode(url,128),png=await pool.decode(url,128,undefined,true),region=await pool.decode(url,128,undefined,false,{x:0,y:0,width:1,height:1});
        if(region.pixels.length!==4 || png.pixels.length!==0 || !png.png.length)throw new Error('image-export-protocol');
        samples.push({name,width:image.width,height:image.height,rgba:[...image.pixels.slice(0,4)],mode:image.mode,threads:image.computeThreads,memoryBytes:image.memoryBytes});
      } finally {URL.revokeObjectURL(url);}
    }} finally {pool.dispose();}
    return {isolated:crossOriginIsolated,samples};
   },{fixtures,moduleUrl:new URL('src/cordis/plugins/canvas-runtime/image-worker/client.ts',base).href});
   const expected=index>0&&!broken?'threaded':'single';
   if(result.samples.some(s=>s.mode!==expected)||errors.length)throw new Error(JSON.stringify({expected,result,errors}));
   outputs.push({url:base.href,brokenThreadArtifact:broken,result});await page.close();
  }
 }
 console.log(JSON.stringify({browser:await browser.version(),kind:'CPU protocol only',outputs},null,2));
} finally {await browser.close();}
