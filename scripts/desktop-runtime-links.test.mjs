import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {materializeRuntimeLinks,writeRuntimeLinks} from './lib/desktop-runtime-links.mjs';
test('portable edges materialize idempotently and reject hostile paths before mutation',()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-links-'));try{fs.mkdirSync(path.join(root,'packages/a'),{recursive:true});writeRuntimeLinks(root,[{link:'backend-runtime',target:'packages/a'}]);materializeRuntimeLinks(root,{platform:'win32'});materializeRuntimeLinks(root,{platform:'win32'});assert.equal(fs.realpathSync(path.join(root,'backend-runtime')),fs.realpathSync(path.join(root,'packages/a')));for(const bad of ['../escape','/absolute','C:/drive','foo\\bar','packages/../escape','packages/.. /escape','packages/a.','NUL/file']){writeRuntimeLinks(root,[{link:'new-link',target:bad}]);assert.throws(()=>materializeRuntimeLinks(root,{platform:'win32'}));assert.equal(fs.existsSync(path.join(root,'new-link')),false);}fs.symlinkSync(os.tmpdir(),path.join(root,'outside'),process.platform==='win32'?'junction':'dir');writeRuntimeLinks(root,[{link:'outside/escape',target:'packages/a'}]);assert.throws(()=>materializeRuntimeLinks(root,{platform:'win32'}));}finally{fs.rmSync(root,{recursive:true,force:true});}});
test('rejects absent targets, replaced destinations and edges beneath junctions before creating links',()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-links-invalid-'));try{fs.mkdirSync(path.join(root,'packages/a'),{recursive:true});fs.mkdirSync(path.join(root,'occupied'));for(const edges of [[{link:'new',target:'missing'}],[{link:'occupied',target:'packages/a'}],[{link:'new',target:'packages/a'},{link:'new/child',target:'packages/a'}]]){writeRuntimeLinks(root,edges);assert.throws(()=>materializeRuntimeLinks(root,{platform:'win32'}));assert.equal(fs.existsSync(path.join(root,'new')),false);}}finally{fs.rmSync(root,{recursive:true,force:true});}});

test('Windows graph survives archive extraction and resolves actual Node dependencies',async()=>{
 const {createHostArchive}=await import('./lib/desktop-host-package.mjs');
 const {systemTar}=await import('./lib/desktop-platform-commands.mjs');
 const {execFileSync}=await import('node:child_process');
 const {pathToFileURL}=await import('node:url');
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-archive-'));
 try{
  const root=path.join(work,'host');const extracted=path.join(work,'restored');
  fs.mkdirSync(path.join(root,'packages/backend'),{recursive:true});fs.mkdirSync(path.join(root,'packages/helper'),{recursive:true});fs.mkdirSync(extracted);
  fs.writeFileSync(path.join(root,'packages/backend/package.json'),JSON.stringify({name:'backend',type:'module'}));
  fs.writeFileSync(path.join(root,'packages/backend/index.js'),"import value from 'helper'; export default value;");
  fs.writeFileSync(path.join(root,'packages/helper/package.json'),JSON.stringify({name:'helper',type:'module',exports:'./index.js'}));
  fs.writeFileSync(path.join(root,'packages/helper/index.js'),"export default 'restored-from-archive';");
  writeRuntimeLinks(root,[{link:'backend-runtime',target:'packages/backend'},{link:'packages/backend/node_modules/helper',target:'packages/helper'}]);
  const archive=createHostArchive(root,path.join(work,'host.tar.gz'));
  execFileSync(systemTar(),['-xzf',archive.path,'-C',extracted],{windowsHide:true});
  materializeRuntimeLinks(extracted,{platform:'win32'});materializeRuntimeLinks(extracted,{platform:'win32'});
  const actual=await import(pathToFileURL(path.join(extracted,'backend-runtime/index.js')).href);assert.equal(actual.default,'restored-from-archive');
 }finally{fs.rmSync(work,{recursive:true,force:true});}
});
