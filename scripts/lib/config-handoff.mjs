/** Portable settings only. Never copy a database, secret store, extension code or session. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {portableRuntimeModels} from './runtime-models-export.mjs';
import {systemTarExec} from './desktop-platform-commands.mjs';
import {acquireDataLock,backupData} from './desktop-host-data.mjs';
const ENTRY='config-package.json';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const forbiddenKey=key=>{
 const name=key.replace(/[-_]/g,'').toLowerCase();
 return ['__proto__','constructor','prototype'].includes(key)
  || ['token','accesstoken','refreshtoken','idtoken','session','sessions','sessionid','sessiontoken','authorization','cookie','cookies','masterkey','secretrefs'].includes(name)
  || /^(?:path|dir|directory|root|port)$/i.test(key)||/(?:Path|Dir|Directory|Root|Port)$/.test(key);
};
export function portableValue(value){
 if(Array.isArray(value))return value.map(portableValue).filter(value=>value!==undefined);
 if(object(value))return Object.fromEntries(Object.entries(value).filter(([key])=>!forbiddenKey(key)).map(([key,item])=>[key,portableValue(item)]).filter(([,item])=>item!==undefined));
 if(typeof value==='string'&&(path.posix.isAbsolute(value)||path.win32.isAbsolute(value)||value.startsWith('file:')))return undefined;
 return value;
}
function validate(payload){
 if(!object(payload)||!object(payload.settings)||!object(payload.secrets)||!Array.isArray(payload.extensionConfigs))throw new Error('配置包内容无效');
 for(const key of Object.keys(payload))if(!['settings','secrets','extensionConfigs','deployment','models','modelPolicies','runtimeModels'].includes(key))throw new Error('配置包包含未知字段');
 for(const record of payload.extensionConfigs){
  if(!object(record)||!/^[-a-z0-9]+$/.test(record.extensionId)||typeof record.enabled!=='boolean'||!object(record.values))throw new Error('扩展配置无效');
  if(Object.keys(record).some(key=>!['extensionId','enabled','values'].includes(key)))throw new Error('扩展配置包含非配置数据');
 }
 if(payload.deployment!==undefined&&(!object(payload.deployment)||Object.keys(payload.deployment).some(key=>!['serverUrl','deviceToken','keyPrefix'].includes(key))||Object.values(payload.deployment).some(value=>typeof value!=='string')))throw new Error('服务端部署配置无效');
 if(payload.deployment?.serverUrl&&!['http:','https:'].includes(new URL(payload.deployment.serverUrl).protocol))throw new Error('服务端地址无效');
 if(payload.runtimeModels!==undefined&&JSON.stringify(portableRuntimeModels(payload.runtimeModels))!==JSON.stringify(payload.runtimeModels))throw new Error('运行时模型目录无效');
 if(payload.modelPolicies!==undefined&&(!Array.isArray(payload.modelPolicies)||payload.modelPolicies.some(policy=>!object(policy)||typeof policy.modelKey!=='string'||!policy.modelKey||typeof policy.enabled!=='boolean'||Object.keys(policy).some(key=>!['modelKey','enabled','isDefault','title','order','taskTimeoutMs','interaction','tombstone'].includes(key)))))throw new Error('模型策略配置无效');
 if(payload.models!==undefined&&!object(payload.models)&&!Array.isArray(payload.models))throw new Error('模型配置无效');
 if(JSON.stringify(portableValue(payload.settings))!==JSON.stringify(payload.settings)||JSON.stringify(portableValue(payload.secrets))!==JSON.stringify(payload.secrets)||payload.extensionConfigs.some(record=>JSON.stringify(portableValue(record.values))!==JSON.stringify(record.values)))throw new Error('配置包包含本机路径或个人会话字段');
 if(payload.modelPolicies!==undefined&&JSON.stringify(portableValue(payload.modelPolicies))!==JSON.stringify(payload.modelPolicies))throw new Error('模型策略包含本机路径或会话');
 if(payload.models!==undefined&&JSON.stringify(portableValue(payload.models))!==JSON.stringify(payload.models))throw new Error('模型配置包含本机路径或会话');
}
const tar=args=>systemTarExec(args,{encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024,env:{...process.env,COPYFILE_DISABLE:'1'}});
export function exportConfigPackage({output,payload}){
 validate(payload);const stage=fs.mkdtempSync(path.join(os.tmpdir(),'woohaa-config-export-'));
 try{
  fs.writeFileSync(path.join(stage,ENTRY),JSON.stringify({format:'woohaa-config',version:payload.runtimeModels===undefined?1:2,payload}),{mode:0o600});
  const packed=path.join(stage,'team.woohaa');tar(['-czf',packed,'-C',stage,ENTRY]);
  fs.copyFileSync(packed,output,fs.constants.COPYFILE_EXCL);fs.chmodSync(output,0o600);
  return {bytes:fs.statSync(output).size,extensionCount:payload.extensionConfigs.length};
 }finally{fs.rmSync(stage,{recursive:true,force:true});}
}
function readPackage(archive){
 try{
  const names=tar(['-tzf',archive]).trim().split(/\r?\n/);
  const listing=tar(['-tvzf',archive]).trim().split(/\r?\n/);
  if(names.length!==1||names[0]!==ENTRY||listing.length!==1||listing[0][0]!=='-')throw new Error('entry');
  const parsed=JSON.parse(tar(['-xOzf',archive,ENTRY]));
  if(parsed.format!=='woohaa-config'||![1,2].includes(parsed.version)||(parsed.version===2&&parsed.payload?.runtimeModels===undefined))throw new Error('format');
  validate(parsed.payload);return parsed.payload;
 }catch{throw new Error('配置包格式无效或含不支持的配置，请重新导出配置包');}
}
function merge(target,incoming){
 const result=object(target)?{...target}:{};
 for(const [key,value] of Object.entries(incoming)){
  if(['__proto__','constructor','prototype'].includes(key))throw new Error('配置键无效');
  result[key]=object(value)?merge(result[key],value):value;
 }return result;
}
export function importConfigPackage({dataDir,archive,yaml,createStore,createModelStore}){
 const payload=readPackage(archive);const unlock=acquireDataLock(dataDir);let backup;
 let store,modelStore;
 try{
  backup=backupData(dataDir);
  // Prepare and validate all configuration files before modifying the destination.
  const config=path.join(dataDir,'config');const files=[];
  for(const [name,incoming] of [['woohaa.config.yml',payload.settings],['woohaa.secrets.yml',payload.secrets]]){
   const file=path.join(config,name);const old=fs.existsSync(file)?yaml.parse(fs.readFileSync(file,'utf8')):{};
   if(old!==null&&!object(old))throw new Error('目标配置格式无效');
   files.push([file,yaml.stringify(merge(old,incoming))]);
  }
  if(payload.runtimeModels!==undefined)files.push([path.join(config,'runtime-models.json'),JSON.stringify(payload.runtimeModels,null,2)]);
  if(payload.models!==undefined)files.push([path.join(config,'models.json'),JSON.stringify(payload.models,null,2)]);
  if(payload.deployment!==undefined){
   const file=path.join(config,'remote-server.json');const old=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
   files.push([file,JSON.stringify(merge(old,payload.deployment),null,2)]);
  }
  if(payload.extensionConfigs.length){
   if(!createStore)throw new Error('缺少扩展配置存储支持');
   fs.mkdirSync(path.join(dataDir,'stores'),{recursive:true});
   store=createStore({path:path.join(dataDir,'stores/application.sqlite')});
   for(const record of payload.extensionConfigs){
    const existing=store.get(record.extensionId);
    const result=store.commit({extensionId:record.extensionId,enabled:record.enabled,values:merge(existing?.values,record.values),secretRefs:existing?.secretRefs??[],expectedRevision:store.revision(),actor:'config-import',now:new Date().toISOString()});
    if(!result.ok)throw new Error('扩展配置导入冲突');
   }
  }
  if(payload.modelPolicies!==undefined){
   if(!createModelStore)throw new Error('缺少模型配置存储支持');
   fs.mkdirSync(path.join(dataDir,'stores'),{recursive:true});
   modelStore=createModelStore({path:path.join(dataDir,'stores/generation-models.sqlite')});
   const result=modelStore.commit({expectedRevision:modelStore.revision(),models:payload.modelPolicies,knownModelKeys:new Set(payload.modelPolicies.map(model=>model.modelKey))});
   if(!result.ok)throw new Error('模型配置无效或导入冲突');
  }
  fs.mkdirSync(config,{recursive:true,mode:0o700});
  for(const [file,content] of files){const temporary=file+'.import-tmp';fs.writeFileSync(temporary,content,{mode:0o600});fs.renameSync(temporary,file);fs.chmodSync(file,0o600);}
  return {backup,extensionCount:payload.extensionConfigs.length};
 }catch(error){
  store?.close();store=null;modelStore?.close();modelStore=null;
  if(backup){
   // Only these two areas were touched. Canvas, task/media, secret stores remain untouched.
   for(const name of ['config','stores']){
    const target=path.join(dataDir,name);fs.rmSync(target,{recursive:true,force:true});
    const original=path.join(backup,name);if(fs.existsSync(original))fs.cpSync(original,target,{recursive:true});
   }
  }
  throw error;
 }finally{store?.close();modelStore?.close();unlock();}
}
