import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createComponentArchive } from './package-runtime-components.mjs';
test('component archive reports exact transfer/install bytes and extracts to same content',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-archive-'));
 try{const source=path.join(root,'source');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'entry'),'component bytes');const output=path.join(root,'out.tar.gz');
  const result=createComponentArchive(source,output);assert.equal(result.unpackedBytes,15);assert.equal(result.bytes,fs.statSync(output).size);assert.equal(result.sha256,createHash('sha256').update(fs.readFileSync(output)).digest('hex'));
  const extracted=path.join(root,'extracted');fs.mkdirSync(extracted);execFileSync('tar',['-xzf',output,'-C',extracted]);assert.equal(fs.readFileSync(path.join(extracted,'entry'),'utf8'),'component bytes');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('component archive rejects links before creating archive',{skip:process.platform==='win32'},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-link-'));
 try{fs.writeFileSync(path.join(root,'file'),'x');fs.symlinkSync('file',path.join(root,'alias'));assert.throws(()=>createComponentArchive(root,path.join(root,'out.tar.gz')),/链接/);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
