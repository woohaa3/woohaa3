import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {stageDevelopmentExecutable} from './lib/desktop-dev-app.mjs';

test('migrates development app executable symlink to a real executable without modifying Cargo output',{skip:process.platform==='win32'?'macOS development app migration':false},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'woohaa-dev-app-'));
 try{
  const source=path.join(root,'cargo-binary');const destination=path.join(root,'App.app/Contents/MacOS/woohaa-desktop');
  fs.writeFileSync(source,'first build',{mode:0o755});fs.mkdirSync(path.dirname(destination),{recursive:true});fs.symlinkSync(source,destination);
  stageDevelopmentExecutable(source,destination);
  assert(!fs.lstatSync(destination).isSymbolicLink());assert.equal(fs.readFileSync(source,'utf8'),'first build');assert.equal(fs.readFileSync(destination,'utf8'),'first build');
  assert(fs.statSync(destination).mode & 0o111);
  fs.writeFileSync(source,'second build');stageDevelopmentExecutable(source,destination);
  assert.equal(fs.readFileSync(destination,'utf8'),'second build');assert.equal(fs.readFileSync(source,'utf8'),'second build');
  assert.deepEqual(fs.readdirSync(path.dirname(destination)),['woohaa-desktop']);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('failed staging leaves the previous executable intact',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'woohaa-dev-app-'));
 try{
  const destination=path.join(root,'MacOS/woohaa-desktop');fs.mkdirSync(path.dirname(destination));fs.writeFileSync(destination,'working build');
  assert.throws(()=>stageDevelopmentExecutable(path.join(root,'missing'),destination));
  assert.equal(fs.readFileSync(destination,'utf8'),'working build');assert.deepEqual(fs.readdirSync(path.dirname(destination)),['woohaa-desktop']);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
