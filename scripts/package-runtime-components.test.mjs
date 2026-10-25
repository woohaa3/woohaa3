import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createComponentArchive } from './package-runtime-components.mjs';
test('component archive reports exact transfer/install bytes and extracts to same content',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-archive-'));
 try{const source=path.join(root,'source');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'entry'),'component bytes');const output=path.join(root,'out.tar.gz');
  const result=await createComponentArchive(source,output);assert.equal(result.unpackedBytes,15);assert.equal(result.bytes,fs.statSync(output).size);assert.equal(result.sha256,createHash('sha256').update(fs.readFileSync(output)).digest('hex'));
  const extracted=path.join(root,'extracted');fs.mkdirSync(extracted);execFileSync('tar',['-xzf',output,'-C',extracted]);assert.equal(fs.readFileSync(path.join(extracted,'entry'),'utf8'),'component bytes');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('component archive rejects links before creating archive',{skip:process.platform==='win32'},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-link-'));
 try{fs.writeFileSync(path.join(root,'file'),'x');fs.symlinkSync('file',path.join(root,'alias'));await assert.rejects(createComponentArchive(root,path.join(root,'out.tar.gz')),/链接/);}finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('runtime packaging validates release layout before reading keys or build outputs',async()=>{
 const {packageRuntimeComponents}=await import('./package-runtime-components.mjs');
 await assert.rejects(packageRuntimeComponents({releaseVersion:'../invalid',platform:'darwin',arch:'arm64',key:'not-a-key'}),/version/i);
 await assert.rejects(packageRuntimeComponents({releaseVersion:'1.2.3',platform:'win32',arch:'arm64',key:'not-a-key'}),/platform/i);
});

test('archives ignore timestamps, insertion order and non-executable permission differences',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-stable-'));
 try{
  for(const [dir,names] of [['a',['z','a']],['b',['a','z']]]){
   fs.mkdirSync(path.join(root,dir));
   for(const name of names){const file=path.join(root,dir,name);fs.writeFileSync(file,name);fs.utimesSync(file,123,dir==='a'?123:456);fs.chmodSync(file,dir==='a'?0o600:0o644);}
  }
  const a=await createComponentArchive(path.join(root,'a'),path.join(root,'a.tar.gz'));
  const b=await createComponentArchive(path.join(root,'b'),path.join(root,'b.tar.gz'));
  assert.equal(a.sha256,b.sha256);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
