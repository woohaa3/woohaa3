import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPublicBoundary } from './check-public-boundary.mjs';

test('public checkout rejects parent imports, Cargo paths and private directories',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'public-boundary-'));
 try{
  fs.mkdirSync(path.join(root,'src'));fs.mkdirSync(path.join(root,'tools'));
  fs.writeFileSync(path.join(root,'src/main.mjs'),"import '../../private.mjs';\n");
  fs.writeFileSync(path.join(root,'Cargo.toml'),'[dependencies]\nsecret = { path = "../private" }\n');
  fs.writeFileSync(path.join(root,'tools/atc.mjs'),'export {};');
  const errors=checkPublicBoundary(root);
  assert.ok(errors.some(error=>error.includes('src/main.mjs')));
  assert.ok(errors.some(error=>error.includes('Cargo.toml')));
  assert.ok(errors.some(error=>error.includes('tools/atc.mjs')));
  fs.rmSync(path.join(root,'tools'),{recursive:true});fs.writeFileSync(path.join(root,'src/main.mjs'),"import '../helpers.mjs';\n");fs.writeFileSync(path.join(root,'helpers.mjs'),'export {};');fs.writeFileSync(path.join(root,'Cargo.toml'),'[package]\nname = "public"');
  assert.deepEqual(checkPublicBoundary(root),[]);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('public checkout rejects committed local credentials and corporate endpoints',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'public-boundary-'));
 try{fs.writeFileSync(path.join(root,'woohaa.secrets.yml'),'placeholder: value');fs.writeFileSync(path.join(root,'release.mjs'),"const endpoint = 'https://service.corp."+"internal/updates';");const errors=checkPublicBoundary(root);assert.equal(errors.length,2);}finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('public checkout rejects corporate extensions even when uninstalled or renamed',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'public-boundary-'));
 try{
  for(const name of ['.woa-identity','woa-access','renamed']){
   const dir=path.join(root,'extensions',name);fs.mkdirSync(dir,{recursive:true});
   fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'@woohaa3/extension-woa-identity'}));
  }
  const errors=checkPublicBoundary(root);
  for(const name of ['.woa-identity','woa-access','renamed']) assert.ok(errors.some(error=>error.includes(`extensions/${name}/package.json`)),name);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('public checkout inspects documentation, Rust, proto, fixtures and lockfiles',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'public-boundary-'));
 try{
  const files=['README.md','model.rs','identity.proto','fixture.test.ts','pnpm-lock.yaml'];
  for(const file of files)fs.writeFileSync(path.join(root,file),'endpoint: https://service.corp.'+'internal/api');
  const errors=checkPublicBoundary(root);
  for(const file of files)assert.ok(errors.some(error=>error.includes(`${file}: private deployment endpoint`)),file);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('public checkout rejects corporate gateway headers and private source references',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'public-boundary-'));
 try{
  fs.writeFileSync(path.join(root,'login.ts'),'const header = "x-'+'tai-identity";');
  fs.writeFileSync(path.join(root,'README.md'),'Copied from asset_'+'canvas_dzs');
  const errors=checkPublicBoundary(root);
  assert.ok(errors.some(error=>error.includes('login.ts: corporate integration details')));
  assert.ok(errors.some(error=>error.includes('README.md: private source reference')));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('public checkout rejects local secrets even inside example directories and escaped symlinks',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'public-boundary-'));
 const external=fs.mkdtempSync(path.join(os.tmpdir(),'public-boundary-external-'));
 try{
  fs.mkdirSync(path.join(root,'examples'));
  for(const file of ['examples/.env','examples/config.local.json','transfer.woohaa','data.sqlite3'])fs.writeFileSync(path.join(root,file),'private runtime data');
  fs.writeFileSync(path.join(external,'private.txt'),'private runtime data');
  fs.symlinkSync(path.join(external,'private.txt'),path.join(root,'linked.txt'));
  const errors=checkPublicBoundary(root);
  for(const file of ['examples/.env','examples/config.local.json','transfer.woohaa','data.sqlite3'])assert.ok(errors.some(error=>error.includes(`${file}: local credentials or data`)),file);
  assert.ok(errors.some(error=>error.includes('linked.txt: symlink outside public checkout')));
 }finally{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(external,{recursive:true,force:true});}
});

test('private provider source is rejected even after directory renaming', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'public-boundary-provider-'));
 try {
  const dir=path.join(root,'extensions','renamed-provider');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'@woohaa3/extension-'+'litellm-provider'}));
  assert.ok(checkPublicBoundary(root).some(error=>error.includes('extension package')));
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('public checkout rejects a protobuf definition anywhere',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'public-boundary-proto-'));
 try{
  fs.mkdirSync(path.join(root,'bevy/src'),{recursive:true});
  fs.writeFileSync(path.join(root,'bevy/src/wire.proto'),'syntax = "proto3";');
  const errors=checkPublicBoundary(root);
  assert.ok(errors.some(error=>error.includes('bevy/src/wire.proto: protobuf definition in public checkout')));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('public checkout rejects protocol sources and generation tooling under api/',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'public-boundary-api-'));
 try{
  const rejected=['api/proto/woohaa/canvas/v1/canvas.proto','api/errs/errs.go','api/buf.yaml','api/buf.gen.yaml','api/go.mod','api/go.sum','api/gen/go/woohaa/canvas/v1/canvas.pb.go','api/scripts/openapi.mjs','api/openapi/openapi.json','api/tools/generrors/main.go'];
  for(const file of rejected){const absolute=path.join(root,file);fs.mkdirSync(path.dirname(absolute),{recursive:true});fs.writeFileSync(absolute,'x');}
  const errors=checkPublicBoundary(root);
  assert.ok(errors.some(error=>error.includes('api/proto/woohaa/canvas/v1/canvas.proto: protobuf definition in public checkout')));
  for(const file of rejected.filter(name=>!name.endsWith('.proto')))assert.ok(errors.some(error=>error.includes(`${file}: protocol source or tooling in public checkout`)),file);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('public checkout accepts only generated bindings and manifests under api/',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'public-boundary-api-'));
 try{
  const allowed=['api/gen/es/woohaa/canvas/v1/canvas_pb.ts','api/package.json','api/tsconfig.json','api/pnpm-lock.yaml','api/pnpm-workspace.yaml','api/.npmrc','api/README.md'];
  for(const file of allowed){const absolute=path.join(root,file);fs.mkdirSync(path.dirname(absolute),{recursive:true});fs.writeFileSync(absolute,file.endsWith('package.json')?'{"name":"@woohaa3/api"}':'');}
  assert.deepEqual(checkPublicBoundary(root),[]);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
