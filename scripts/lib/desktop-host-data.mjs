/** Desktop-owned paths and offline workspace handoff. Call only with the host stopped. */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {systemTarExec} from './desktop-platform-commands.mjs';

const DATA_ENTRIES = ['stores','media','config','secrets','extension-data','extensions','data-version.json'];

const inside = (root, file) => file === root || file.startsWith(root + path.sep);
function atomicJson(file, value) { const tmp = `${file}.${randomUUID()}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value), {mode:0o600}); fs.renameSync(tmp,file); }

export function desktopEnvironment({ dataDir, resourceRoot, baseEnv = {}, platform = process.platform, development = false }) {
 dataDir=path.resolve(dataDir);resourceRoot=path.resolve(resourceRoot);
 // Desktop mode deliberately does not inherit repository database/secret/provider settings.
 const env=Object.fromEntries(Object.entries(baseEnv).filter(([key])=>!key.startsWith('WOOHAA3_') && !key.startsWith('VITE_') && !['MONGODB_URI','MONGODB_DB','PORT','BACKEND_PORT','HOST','NODE_OPTIONS','NODE_PATH'].includes(key)));
 Object.assign(env,{
 PATH:path.join(resourceRoot,'tools')+path.delimiter+(env.PATH??'/usr/bin:/bin'),
 NODE_ENV:'production', WOOHAA3_BASE_PATH:'/',
 WOOHAA3_RUNTIME_DATA_DIR:dataDir, WOOHAA3_RUNTIME_DEFAULTS_FILE:path.join(resourceRoot,'runtime-downloads.json'), WOOHAA3_RUNTIME_LOCK_FILE:path.join(resourceRoot,'runtime-components.lock.json'), WOOHAA3_REPO_ROOT:resourceRoot,
 WOOHAA3_TASK_STORE_PATH:path.join(dataDir,'stores/task.sqlite'), WOOHAA3_APPLICATION_STORE_PATH:path.join(dataDir,'stores/application.sqlite'),
 WOOHAA3_CANVAS_STORAGE_BACKEND:'sqlite', WOOHAA3_CANVAS_STORAGE_SQLITE_PATH:path.join(dataDir,'stores/canvas.sqlite'),
 WOOHAA3_APPLICATION_DOCUMENT_STORE_BACKEND:'sqlite', WOOHAA3_CONFIG_FILE:path.join(dataDir,'config/woohaa.config.yml'), WOOHAA3_SECRETS_FILE:path.join(dataDir,'config/woohaa.secrets.yml'),
 WOOHAA3_PLUGIN_SECRET_DIR:path.join(dataDir,'secrets/plugins'), WOOHAA3_EXTENSION_DATA_DIR:path.join(dataDir,'extension-data'),
 WOOHAA3_LOG_DIR:path.join(dataDir,'logs'), WOOHAA3_MODELS_CONFIG_PATH:fs.existsSync(path.join(dataDir,'config/models.json'))?path.join(dataDir,'config/models.json'):path.join(resourceRoot,'models.json'),
 WOOHAA3_RUNTIME_MODELS_PATH:path.join(dataDir,'config/runtime-models.json'),
 WOOHAA3_REMOTE_SERVER_CONFIG_FILE:path.join(dataDir,'config/remote-server.json'),
 WOOHAA3_EXTENSION_DIRS:[path.join(resourceRoot,'extensions'),path.join(dataDir,'extensions')].join(','), WOOHAA3_EXTENSION_WRITABLE_DIRS:path.join(dataDir,'extensions'),
 WOOHAA3_TRUSTED_INGRESS_SECRET:randomBytes(32).toString('hex'),
 });
 // Development resolves installed SDKs and local tools; never let download configuration
 // intercept dev:desktop, including inherited desktop runtime environment variables.
 if(development)for(const key of ['WOOHAA3_RUNTIME_DATA_DIR','WOOHAA3_RUNTIME_DEFAULTS_FILE','WOOHAA3_RUNTIME_LOCK_FILE'])delete env[key];
 const trustConfig=path.join(resourceRoot,"extension-trust.json");
 if(fs.existsSync(trustConfig))env.WOOHAA3_EXTENSION_TRUST_CONFIG=trustConfig;
 else if(development&&baseEnv.WOOHAA3_EXTENSION_TRUST_CONFIG)env.WOOHAA3_EXTENSION_TRUST_CONFIG=path.resolve(baseEnv.WOOHAA3_EXTENSION_TRUST_CONFIG);
 const master=path.join(dataDir,'secrets/master.key');
 if(fs.existsSync(master))env.WOOHAA3_PLUGIN_SECRET_MASTER_KEY=fs.readFileSync(master,'utf8').trim();
 for(const [file,key] of [['model-renderer','WOOHAA3_MODEL_RENDERER_CMD']]) {
  const candidate=path.join(resourceRoot,'tools',file+(platform==='win32'?'.exe':''));if(fs.existsSync(candidate))env[key]=candidate;
 }
 return env;
}

export function acquireDataLock(dataDir) {
 fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
 const file=path.join(dataDir,'host.lock');
 const owner={pid:process.pid,nonce:randomUUID()};
 for(let attempt=0;attempt<2;attempt++) {
  try{fs.writeFileSync(file,JSON.stringify(owner),{flag:'wx',mode:0o600});return ()=>{try{if(JSON.parse(fs.readFileSync(file,'utf8')).nonce===owner.nonce)fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}};}
  catch(error){if(error.code!=='EEXIST')throw error;let prior;try{prior=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new Error('数据目录锁无效，请确认没有正在运行的应用');}
   try{process.kill(prior.pid,0);}catch(error){if(error.code==='ESRCH'){fs.unlinkSync(file);continue;}throw error;}
   throw new Error('数据目录已被运行中的宿主占用');
  }
 }
 throw new Error('无法取得数据目录锁');
}

function copyData(source,target) {
 fs.mkdirSync(target,{recursive:true,mode:0o700});
 for(const entry of DATA_ENTRIES){const from=path.join(source,entry);if(fs.existsSync(from))fs.cpSync(from,path.join(target,entry),{recursive:true,dereference:false});}
}
export function backupData(dataDir) {
 const backup=path.join(dataDir,'backups',`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);
 copyData(dataDir,backup);
 atomicJson(path.join(backup,'backup-info.json'),{format:'woohaa-backup',version:1,entries:DATA_ENTRIES.filter(entry=>fs.existsSync(path.join(backup,entry)))});return backup;
}
export function prepareData(dataDir,version) {
 fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
 const file=path.join(dataDir,'data-version.json');const previous=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
 if(previous&&(!Number.isInteger(previous.schema)||previous.schema>version.schema))throw new Error('数据来自新版 schema，当前客户端不能打开');
 const hasData=DATA_ENTRIES.some(entry=>fs.existsSync(path.join(dataDir,entry)));
 const backup=hasData&&(!previous||previous.build!==version.build||previous.schema!==version.schema)?backupData(dataDir):null;
 for(const dir of ['stores','media','config','secrets','extension-data','extensions','logs','cache'])fs.mkdirSync(path.join(dataDir,dir),{recursive:true,mode:0o700});
 const master=path.join(dataDir,'secrets/master.key');if(!fs.existsSync(master))fs.writeFileSync(master,randomBytes(32).toString('base64'),{flag:'wx',mode:0o600});
 return {previous,backup};
}
export function commitDataVersion(dataDir,version) { atomicJson(path.join(dataDir,'data-version.json'),version); }

function validateDataTree(directory) {
 const visit=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isSymbolicLink()||(!entry.isDirectory()&&!entry.isFile()))throw new Error('工作区不能包含软链或特殊文件');if(entry.isDirectory())visit(file);}};
 for(const entry of DATA_ENTRIES){const file=path.join(directory,entry);if(!fs.existsSync(file))continue;if(fs.lstatSync(file).isSymbolicLink())throw new Error('工作区不能包含软链');if(fs.statSync(file).isDirectory())visit(file);}
}
const tar=(args)=>systemTarExec(args,{windowsHide:true,encoding:'utf8',maxBuffer:64*1024*1024,env:{...process.env,COPYFILE_DISABLE:'1'},stdio:['ignore','pipe','pipe']});
export function exportWorkspace(dataDir,output) {
 const unlock=acquireDataLock(dataDir);const stage=fs.mkdtempSync(path.join(path.dirname(dataDir),'.woohaa-export-'));
 const temporary=path.join(stage,'workspace.woohaa');
 try{
  if(inside(path.resolve(dataDir),path.resolve(output)))throw new Error('导出文件不能位于正在导出的工作区内部');
  validateDataTree(dataDir);
  fs.writeFileSync(path.join(stage,'workspace-format.json'),JSON.stringify({format:'woohaa-workspace',version:1}),{mode:0o600});
  const entries=DATA_ENTRIES.filter(entry=>fs.existsSync(path.join(dataDir,entry)));
  tar(['-czf',temporary,'-C',stage,'workspace-format.json','-C',path.resolve(dataDir),...entries]);
  fs.copyFileSync(temporary,output);fs.chmodSync(output,0o600);return {bytes:fs.statSync(output).size};
 }finally{fs.rmSync(stage,{recursive:true,force:true});unlock();}
}
export function restoreBackup(dataDir,source) {
 const backups=fs.realpathSync(path.join(dataDir,'backups'));source=fs.realpathSync(source);
 if(path.dirname(source)!==backups)throw new Error('只能选择当前用户目录内的备份快照根目录');
 const infoFile=path.join(source,'backup-info.json');
 if(!fs.existsSync(infoFile))throw new Error('所选目录不是有效的备份快照');
 const info=JSON.parse(fs.readFileSync(infoFile,'utf8'));
 if(info.format!=='woohaa-backup'||info.version!==1||!Array.isArray(info.entries)||info.entries.some(entry=>!DATA_ENTRIES.includes(entry)||!fs.existsSync(path.join(source,entry))))throw new Error('备份快照不完整');
 const marker=path.join(source,'data-version.json');
 if(fs.existsSync(marker)){const version=JSON.parse(fs.readFileSync(marker,'utf8'));if(!Number.isInteger(version.schema)||version.schema>1)throw new Error('备份数据版本不兼容');}
 validateDataTree(source);
 const unlock=acquireDataLock(dataDir);try{const backup=backupData(dataDir);replaceData(source,dataDir,backup);return {backup};}finally{unlock();}
}
function replaceData(source,target,backup) {
 try{for(const entry of DATA_ENTRIES)fs.rmSync(path.join(target,entry),{recursive:true,force:true});copyData(source,target);}
 catch(error){for(const entry of DATA_ENTRIES)fs.rmSync(path.join(target,entry),{recursive:true,force:true});copyData(backup,target);throw error;}
}
export function importWorkspace(dataDir,archive) {
 // Inspect every entry before extraction. Only ordinary files/directories may enter staging.
 let names,listing;
 try{names=tar(['-tzf',archive]).trim().split(/\r?\n/);listing=tar(['-tvzf',archive]).trim().split(/\r?\n/);}catch{throw new Error('工作区包格式无效或路径非法');}
 const seen=new Set();
 for(const raw of names){if(raw==='./')continue;const name=raw.replace(/^(?:\.\/)+/,'').replace(/\/$/,'');
  if(!name||name.includes('\\')||name.includes('\0')||name.split('/').some(p=>!p||p==='.'||p==='..')||!DATA_ENTRIES.concat('workspace-format.json').includes(name.split('/')[0])||seen.has(name))throw new Error('交接包包含非法路径');seen.add(name);
 }
 if(listing.some(line=>!['-','d'].includes(line[0])))throw new Error('交接包不能包含链接或特殊文件');
 if(!seen.has('data-version.json')||!seen.has('workspace-format.json'))throw new Error('交接包缺少格式或数据版本');
 const unlock=acquireDataLock(dataDir);const stage=fs.mkdtempSync(path.join(path.dirname(dataDir),'.woohaa-import-'));
 try{
  tar(['-xzf',archive,'-C',stage,'--no-same-owner','--no-same-permissions']);
  const format=JSON.parse(fs.readFileSync(path.join(stage,'workspace-format.json'),'utf8'));if(format.format!=='woohaa-workspace'||format.version!==1)throw new Error('交接包格式不兼容');
  const version=JSON.parse(fs.readFileSync(path.join(stage,'data-version.json'),'utf8'));if(version.schema!==1)throw new Error('交接包 schema 不兼容');
  validateDataTree(stage);
  const backup=backupData(dataDir);replaceData(stage,dataDir,backup);return {backup,files:names.length};
 }finally{fs.rmSync(stage,{recursive:true,force:true});unlock();}
}
