/** Read development settings without starting the host or mutating its databases. */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {loadServiceEnv} from './service-env.mjs';
import {loadExtensionHost} from './extension-host.mjs';
import {portableValue} from './config-handoff.mjs';
function set(target,key,value){const parts=key.split('.');let current=target;for(const part of parts.slice(0,-1))current=current[part]??={};current[parts.at(-1)]=value;}
function readJson(file,fallback){return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):fallback;}
export async function collectDevelopmentConfig({root,env=loadServiceEnv(root,process.env.WOOHAA3_SERVICE_ENV_FILE)}){
 const {createSettingsService,resolveSettingsFiles}=await import(pathToFileURL(path.join(root,'web/backend/dist/index.js')).href);
 const settings=await createSettingsService({...resolveSettingsFiles(env,root),env,watch:false});
 const host=await loadExtensionHost({repoRoot:root,env,logger:()=>{}});
 // `createHostPlugins` 返回 `{ plugins, storage }`（一条扁平列表 + 存储子集）：
 // 角色由 `plugin.roles` 标注，不再按 provider / storage 分桶（df0d50d7 起）。
 // 这里只关心「哪些插件声明了 Config.fields」，因此遍历扁平列表，storage 已在其中，不重复合并。
 const {plugins}=await host.createHostPlugins();
 try{
  for(const plugin of plugins)if(plugin.Config?.fields)settings.register(plugin.configPrefix,plugin.Config.fields,plugin.label??plugin.name,plugin.name);
  const payload={settings:{},secrets:{},extensionConfigs:[]};
  const omitted=[];
  for(const definition of settings.describe()){
   if(!definition.source||definition.source==='default')continue;
   const value=settings.get(definition.key);const candidate={};set(candidate,definition.key,value);
   const portable=portableValue(candidate);
   if(JSON.stringify(candidate)!==JSON.stringify(portable)){omitted.push(definition.key);continue;}
   set(definition.secret?payload.secrets:payload.settings,definition.key,value);
  }
  // Site settings are a small table in a larger private-data database. Read only this table.
  const storeFile=env.WOOHAA3_APPLICATION_STORE_PATH;
  if(storeFile&&fs.existsSync(path.resolve(root,storeFile))){
   const db=new DatabaseSync(path.resolve(root,storeFile),{readOnly:true});
   try{
    if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='extension_site_config'").get()){
     payload.extensionConfigs=db.prepare('SELECT extension_id, desired_enabled, values_json FROM extension_site_config ORDER BY extension_id').all().map(row=>({extensionId:row.extension_id,enabled:Boolean(row.desired_enabled),values:portableValue(JSON.parse(row.values_json))}));
    }
   }finally{db.close();}
  }
  const policyFile=path.resolve(root,path.dirname(env.WOOHAA3_TASK_STORE_PATH??env.WOOHAA3_APPLICATION_STORE_PATH??'.'),'generation-models.sqlite');
  if(fs.existsSync(policyFile)){
   const db=new DatabaseSync(policyFile,{readOnly:true});
   try{
    if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='generation_model_revision'").get()&&db.prepare('SELECT initialized FROM generation_model_revision WHERE id=1').get()?.initialized===1){
     payload.modelPolicies=portableValue(db.prepare('SELECT * FROM generation_model_policy ORDER BY model_key').all().map(row=>({modelKey:row.model_key,enabled:row.enabled===1,...(row.is_default?{isDefault:true}:{}),...(row.title!==null?{title:row.title}:{}),...(row.order_index!==null?{order:row.order_index}:{}),...(row.task_timeout_ms!==null?{taskTimeoutMs:row.task_timeout_ms}:{}),...(row.interaction_id!==null?{interaction:{id:row.interaction_id,version:row.interaction_version}}:{}),...(row.tombstone?{tombstone:true}:{})})));
    }
   }finally{db.close();}
  }
  const remote=host.registrations.find(entry=>entry.extensionId==='remote-server');
  const local=readJson(env.WOOHAA3_REMOTE_SERVER_CONFIG_FILE?path.resolve(root,env.WOOHAA3_REMOTE_SERVER_CONFIG_FILE):path.join(remote?.directory??root,'config.local.json'),{});
  const remoteSite=payload.extensionConfigs.find(entry=>entry.extensionId==='remote-server')?.values??{};
  const deployment={};
  for(const [key,name] of [['serverUrl','WOOHAA3_REMOTE_SERVER_URL'],['deviceToken','WOOHAA3_REMOTE_SERVER_DEVICE_TOKEN']]){
   const value=remoteSite[key]??env[name]??local[key];if(typeof value==='string'&&value.trim())deployment[key]=value.trim();
  }
  if(typeof local.keyPrefix==='string')deployment.keyPrefix=local.keyPrefix;
  if(Object.keys(deployment).length)payload.deployment=deployment;
  const modelsFile=path.resolve(root,env.WOOHAA3_MODELS_CONFIG_PATH||'web/services/task-service/pptask.models.json');
  if(fs.existsSync(modelsFile))payload.models=portableValue(readJson(modelsFile,{}));
  return {payload,omitted,unknownKeys:settings.unknownKeys()};
 }finally{settings.close();}
}
