import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { desktopEnvironment, prepareData, commitDataVersion, acquireDataLock, exportWorkspace, importWorkspace } from './lib/desktop-host-data.mjs';
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'woohaa-host-test-'));
test('desktop paths ignore inherited repository and database settings', () => {
 const dir=temp(); try { const env=desktopEnvironment({ dataDir:dir, resourceRoot:'/bundle', baseEnv:{WOOHAA3_TASK_STORE_PATH:'/repo/task.sqlite', WOOHAA3_EXTENSION_DIRS:'/repo/extensions', MONGODB_URI:'secret', PORT:'5180', BACKEND_PORT:'5180', HOST:'0.0.0.0'} });
 assert.equal(env.WOOHAA3_TASK_STORE_PATH,path.join(dir,'stores/task.sqlite')); assert.equal(env.MONGODB_URI,undefined); assert.equal(env.WOOHAA3_CANVAS_STORAGE_SQLITE_PATH,path.join(dir,'stores/canvas.sqlite')); assert.ok(!env.WOOHAA3_EXTENSION_DIRS.includes('/repo'));
 assert.equal(env.PORT,undefined); assert.equal(env.BACKEND_PORT,undefined); assert.equal(env.HOST,undefined); } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('migration backs up old data, commits only after successful readiness, refuses future schema', () => {
 const dir=temp(); try { fs.mkdirSync(path.join(dir,'stores'));fs.writeFileSync(path.join(dir,'stores/canvas.sqlite'),'old');
 const migration=prepareData(dir,{schema:1,build:'one'}); assert.ok(migration.backup);assert.equal(fs.existsSync(path.join(dir,'data-version.json')),false);
 commitDataVersion(dir,{schema:1,build:'one'});assert.equal(prepareData(dir,{schema:1,build:'one'}).backup,null);
 assert.throws(()=>prepareData(dir,{schema:0,build:'old'}),/新版|schema/); }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('data lock rejects another writer and releases cleanly',()=>{const dir=temp();try{const release=acquireDataLock(dir);assert.throws(()=>acquireDataLock(dir),/占用/);release();acquireDataLock(dir)();}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('workspace handoff preserves media and secrets and backs up replaced data',()=>{const source=temp(),target=temp(),archive=path.join(temp(),'workspace.woohaa');try{
 fs.mkdirSync(path.join(source,'config'));fs.writeFileSync(path.join(source,'config/woohaa.secrets.yml'),'key: private');fs.mkdirSync(path.join(source,'media'));fs.writeFileSync(path.join(source,'media/image.png'),'image');commitDataVersion(source,{schema:1,build:'one'});
 fs.mkdirSync(path.join(target,'stores'));fs.writeFileSync(path.join(target,'stores/old.sqlite'),'old');exportWorkspace(source,archive);const result=importWorkspace(target,archive);assert.ok(result.backup);assert.equal(fs.readFileSync(path.join(target,'config/woohaa.secrets.yml'),'utf8'),'key: private');assert.equal(fs.existsSync(path.join(target,'stores/old.sqlite')),false);
 }finally{for(const dir of [source,target,path.dirname(archive)])fs.rmSync(dir,{recursive:true,force:true});}});
test('unsafe archive is rejected without changing destination',()=>{const dir=temp();try{const archive=path.join(dir,'bad.woohaa');fs.writeFileSync(archive,gzipSync(JSON.stringify({format:'woohaa-workspace',version:1,files:[{path:'../escape',data:'eA=='}]})));assert.throws(()=>importWorkspace(dir,archive),/路径|格式/);assert.equal(fs.existsSync(path.join(dir,'data-version.json')),false);}finally{fs.rmSync(dir,{recursive:true,force:true});}});
import { restoreBackup } from './lib/desktop-host-data.mjs';
test('failed migration can restore a local backup while host is stopped',()=>{const dir=temp();try{fs.mkdirSync(path.join(dir,'stores'));fs.writeFileSync(path.join(dir,'stores/canvas.sqlite'),'before');commitDataVersion(dir,{schema:1,build:'old'});const migration=prepareData(dir,{schema:1,build:'new'});fs.writeFileSync(path.join(dir,'stores/canvas.sqlite'),'broken');const result=restoreBackup(dir,migration.backup);assert.ok(result.backup);assert.equal(fs.readFileSync(path.join(dir,'stores/canvas.sqlite'),'utf8'),'before');assert.throws(()=>restoreBackup(dir,os.tmpdir()),/备份/);}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('selecting a backup subfolder cannot erase the current workspace',()=>{const dir=temp();try{fs.mkdirSync(path.join(dir,'stores'));fs.mkdirSync(path.join(dir,'media'));fs.writeFileSync(path.join(dir,'stores/canvas.sqlite'),'keep');commitDataVersion(dir,{schema:1,build:'old'});const migration=prepareData(dir,{schema:1,build:'new'});assert.throws(()=>restoreBackup(dir,path.join(migration.backup,'media')),/备份|快照/);assert.equal(fs.readFileSync(path.join(dir,'stores/canvas.sqlite'),'utf8'),'keep');}finally{fs.rmSync(dir,{recursive:true,force:true});}});

test('Windows native commands and installed resource layout do not depend on PATH', async()=>{
 const { systemTar, installedHostLayout, isolatedHostEnvironment } = await import('./lib/desktop-platform-commands.mjs');
 assert.equal(systemTar('win32',{SystemRoot:'D:\\Windows'}),'D:\\Windows\\System32\\tar.exe');
 assert.equal(systemTar('darwin',{}),'/usr/bin/tar');
 assert.deepEqual(installedHostLayout('C:\\Apps\\WooHaa3\\woohaa-desktop.exe','win32'),{node:'C:\\Apps\\WooHaa3\\woohaa-node.exe',archive:'C:\\Apps\\WooHaa3\\desktop-host.tar.gz'});
 const env=isolatedHostEnvironment('C:\\smoke','win32',{SystemRoot:'D:\\Windows',TEMP:'C:\\Temp'});
 assert.equal(env.SystemRoot,'D:\\Windows');assert.equal(env.PATH,'D:\\Windows\\System32');assert.equal(env.HOME,'C:\\smoke');assert.ok(env.LOCALAPPDATA);
});
test('desktop environment includes the native model renderer when present',()=>{const dir=temp();try{fs.mkdirSync(path.join(dir,'tools'));fs.writeFileSync(path.join(dir,'tools/model-renderer.exe'),'exe');const env=desktopEnvironment({dataDir:dir,resourceRoot:dir,platform:'win32'});assert.equal(env.WOOHAA3_MODEL_RENDERER_CMD,path.join(dir,'tools/model-renderer.exe'));}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('workspace imports standard tar dot-root archives and preserves Unicode filenames',async()=>{
 const {execFileSync}=await import('node:child_process');const {systemTarExec}=await import('./lib/desktop-platform-commands.mjs');const source=temp(),target=temp(),output=temp();try{
 fs.mkdirSync(path.join(source,'media'));fs.writeFileSync(path.join(source,'media/我的 图片.png'),'pixels');fs.writeFileSync(path.join(source,'workspace-format.json'),JSON.stringify({format:'woohaa-workspace',version:1}));commitDataVersion(source,{schema:1,build:'test'});
 const archive=path.join(output,'workspace.woohaa');systemTarExec(['-czf',archive,'-C',source,'.'],{windowsHide:true});importWorkspace(target,archive);assert.equal(fs.readFileSync(path.join(target,'media/我的 图片.png'),'utf8'),'pixels');
 }finally{for(const dir of [source,target,output])fs.rmSync(dir,{recursive:true,force:true});}
});

test('desktop development uses local dependencies; only packaged hosts enable component downloads',()=>{
 const dir=temp();try{
  fs.mkdirSync(path.join(dir,'tools'));fs.writeFileSync(path.join(dir,'tools/model-renderer'),'local renderer');
  const development=desktopEnvironment({dataDir:dir,resourceRoot:dir,development:true,baseEnv:{WOOHAA3_RUNTIME_DATA_DIR:'/inherited/downloads'}});
  assert.equal(development.WOOHAA3_RUNTIME_DATA_DIR,undefined);
  assert.equal(development.WOOHAA3_RUNTIME_DEFAULTS_FILE,undefined);
  assert.equal(development.WOOHAA3_RUNTIME_LOCK_FILE,undefined);
  assert.equal(development.WOOHAA3_MODEL_RENDERER_CMD,path.join(dir,'tools/model-renderer'));
  const packaged=desktopEnvironment({dataDir:dir,resourceRoot:dir});
  assert.equal(packaged.WOOHAA3_RUNTIME_DATA_DIR,dir);
  assert.equal(packaged.WOOHAA3_RUNTIME_LOCK_FILE,path.join(dir,'runtime-components.lock.json'));
  // npm registry 运行期安装：同一数据目录缓存、app-local tools、随包 lock 与显式策略。
  assert.equal(packaged.WOOHAA3_RUNTIME_NPM_LOCK_FILE,path.join(dir,'runtime-npm-lock.json'));
  assert.equal(packaged.WOOHAA3_RUNTIME_TOOLS_DIR,path.join(dir,'tools'));
  assert.equal(packaged.WOOHAA3_RUNTIME_INSTALL,'enabled');
  const disabled=desktopEnvironment({dataDir:dir,resourceRoot:dir,baseEnv:{WOOHAA3_DESKTOP_RUNTIME_INSTALL:'disabled'}});
  assert.equal(disabled.WOOHAA3_RUNTIME_INSTALL,'disabled');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('workspace handoff explicitly excludes assistant files and preserves the receiving installation root state',async()=>{
 const {systemTarExec}=await import('./lib/desktop-platform-commands.mjs');
 const source=temp(),target=temp(),output=temp();try{
  commitDataVersion(source,{schema:1,build:'test'});
  fs.mkdirSync(path.join(source,'agent-workspaces/canvas/shared'),{recursive:true});fs.writeFileSync(path.join(source,'agent-workspaces/canvas/shared/private'),'local assistant file');
  fs.mkdirSync(path.join(source,'.local/executor'),{recursive:true});fs.writeFileSync(path.join(source,'.local/executor/canvas-workspaces.json'),JSON.stringify({rootPath:'/foreign/root'}));
  fs.mkdirSync(path.join(target,'.local/executor'),{recursive:true});fs.writeFileSync(path.join(target,'.local/executor/canvas-workspaces.json'),JSON.stringify({rootPath:'/this/installation'}));
  fs.mkdirSync(path.join(target,'agent-workspaces'));fs.writeFileSync(path.join(target,'agent-workspaces/keep'),'existing');
  const archive=path.join(output,'handoff.woohaa'),result=exportWorkspace(source,archive);
  assert.match(result.message,/不包含助手/);assert.ok(result.excluded.includes('agent-workspaces'));
  const names=systemTarExec(['-tzf',archive],{encoding:'utf8'});assert.doesNotMatch(names,/agent-workspaces|executor/);
  systemTarExec(['-xzf',archive,'-C',output]);const metadata=JSON.parse(fs.readFileSync(path.join(output,'workspace-format.json'),'utf8'));assert.match(metadata.exclusionNote,/助手/);
  importWorkspace(target,archive);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target,'.local/executor/canvas-workspaces.json'),'utf8')).rootPath,'/this/installation');
  assert.equal(fs.readFileSync(path.join(target,'agent-workspaces/keep'),'utf8'),'existing');
 }finally{for(const dir of [source,target,output])fs.rmSync(dir,{recursive:true,force:true});}
});
