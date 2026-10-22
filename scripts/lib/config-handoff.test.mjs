import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {systemTarExec} from './desktop-platform-commands.mjs';
import {exportConfigPackage, importConfigPackage, portableValue} from './config-handoff.mjs';
const require=createRequire(new URL('../../web/backend/package.json',import.meta.url));
const yaml=require('yaml');
const fixture=()=>fs.mkdtempSync(path.join(os.tmpdir(),'woohaa-config-test-'));
test('config handoff merges settings and secrets, preserving canvas, media, login and local paths',()=>{
 const root=fixture();try{
 const data=path.join(root,'data');fs.mkdirSync(path.join(data,'config'),{recursive:true});
 fs.mkdirSync(path.join(data,'stores'));fs.writeFileSync(path.join(data,'stores/canvas.sqlite'),'canvas');
 fs.mkdirSync(path.join(data,'secrets'));fs.writeFileSync(path.join(data,'secrets/personal'),'session');
 fs.writeFileSync(path.join(data,'config/woohaa.config.yml'),yaml.stringify({providers:{ark:{baseUrl:'https://old.example'}},storage:{local:{root:'/target/media'}}}));
 const archive=path.join(root,'team.woohaa');
 exportConfigPackage({output:archive,payload:{settings:{providers:{tokenhub:{baseUrl:'https://gateway.example'}}},secrets:{providers:{tokenhub:{apiKey:'shared-key'}}},extensionConfigs:[],deployment:{serverUrl:'https://server.example',deviceToken:'device'},models:{models:[]}}});
 const result=importConfigPackage({dataDir:data,archive,yaml});
 const config=yaml.parse(fs.readFileSync(path.join(data,'config/woohaa.config.yml'),'utf8'));
 assert.equal(config.providers.ark.baseUrl,'https://old.example');assert.equal(config.providers.tokenhub.baseUrl,'https://gateway.example');
 assert.equal(config.storage.local.root,'/target/media');assert.equal(fs.readFileSync(path.join(data,'stores/canvas.sqlite'),'utf8'),'canvas');
 assert.equal(fs.readFileSync(path.join(data,'secrets/personal'),'utf8'),'session');
 assert.equal(yaml.parse(fs.readFileSync(path.join(data,'config/woohaa.secrets.yml'),'utf8')).providers.tokenhub.apiKey,'shared-key');
 assert.ok(fs.existsSync(path.join(result.backup,'config/woohaa.config.yml')));
 assert.equal(JSON.parse(fs.readFileSync(path.join(data,'config/remote-server.json'),'utf8')).deviceToken,'device');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('portable values omit machine paths and personal credentials, preserve shared API keys and URLs',()=>{
 assert.deepEqual(portableValue({providers:{tokenhub:{apiKey:'shared'}},telemetry:{export:{enabled:true}}}),{providers:{tokenhub:{apiKey:'shared'}},telemetry:{export:{enabled:true}}});
 assert.deepEqual(portableValue({apiKey:'shared',baseUrl:'http://localhost:4000',accessToken:'personal',session:'login',root:'/Users/me/media',nested:{cacheDir:'C:\\cache',ep:'ep-123'}}),{apiKey:'shared',baseUrl:'http://localhost:4000',nested:{ep:'ep-123'}});
});
test('config importer rejects workspace archives without changing target',()=>{
 const root=fixture();try{fs.writeFileSync(path.join(root,'workspace-format.json'),'{}');
 systemTarExec(['-czf',path.join(root,'bad.woohaa'),'-C',root,'workspace-format.json']);
 assert.throws(()=>importConfigPackage({dataDir:path.join(root,'data'),archive:path.join(root,'bad.woohaa'),yaml}),/配置包/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('extension site configs merge via store API without carrying source sessions or secret refs',async()=>{
 const {createSqliteSiteExtensionConfigStore}=await import('../../web/services/application-service/dist/index.js');
 const root=fixture();try{
 const data=path.join(root,'data');fs.mkdirSync(path.join(data,'stores'),{recursive:true});
 let store=createSqliteSiteExtensionConfigStore({path:path.join(data,'stores/application.sqlite')});
 store.commit({extensionId:'remote-server',enabled:false,values:{retained:true},secretRefs:['target-ref'],expectedRevision:0,actor:'test',now:new Date().toISOString()});store.close();
 const archive=path.join(root,'team.woohaa');
 exportConfigPackage({output:archive,payload:{settings:{},secrets:{},extensionConfigs:[{extensionId:'remote-server',enabled:true,values:{serverUrl:'https://server.example'}}]}});
 importConfigPackage({dataDir:data,archive,yaml,createStore:createSqliteSiteExtensionConfigStore});
 store=createSqliteSiteExtensionConfigStore({path:path.join(data,'stores/application.sqlite')});
 try{assert.deepEqual(store.get('remote-server').values,{retained:true,serverUrl:'https://server.example'});assert.deepEqual(store.get('remote-server').secretRefs,['target-ref']);assert.equal(store.revision(),2);}finally{store.close();}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('failed config merge rolls back partial extension commits',async()=>{
 const {createSqliteSiteExtensionConfigStore}=await import('../../web/services/application-service/dist/index.js');
 const root=fixture();try{
 const data=path.join(root,'data');fs.mkdirSync(path.join(data,'stores'),{recursive:true});
 let store=createSqliteSiteExtensionConfigStore({path:path.join(data,'stores/application.sqlite')});store.close();
 const archive=path.join(root,'team.woohaa');exportConfigPackage({output:archive,payload:{settings:{},secrets:{},extensionConfigs:[{extensionId:'one',enabled:true,values:{}},{extensionId:'two',enabled:true,values:{}}]}});
 assert.throws(()=>importConfigPackage({dataDir:data,archive,yaml,createStore:options=>{const actual=createSqliteSiteExtensionConfigStore(options);let calls=0;return {get:id=>actual.get(id),revision:()=>actual.revision(),close:()=>actual.close(),commit:input=>{if(++calls===2)throw new Error('injected failure');return actual.commit(input);}};}}),/injected/);
 store=createSqliteSiteExtensionConfigStore({path:path.join(data,'stores/application.sqlite')});try{assert.equal(store.get('one'),undefined);assert.equal(store.revision(),0);}finally{store.close();}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('development export resolves environment overrides using provider schemas and reads only site configuration',async()=>{
 const {collectDevelopmentConfig}=await import('./development-config.mjs');
 const {DatabaseSync}=await import('node:sqlite');
 const {fileURLToPath}=await import('node:url');
 const root=fixture();try{
 const config=path.join(root,'settings.yml'),secrets=path.join(root,'secrets.yml'),deployment=path.join(root,'deployment.json'),models=path.join(root,'models.json'),dbFile=path.join(root,'application.sqlite');
 fs.writeFileSync(config,yaml.stringify({providers:{tokenhub:{baseUrl:'https://file.example'}},storage:{local:{root:'/personal/media'}}}));
 fs.writeFileSync(secrets,yaml.stringify({providers:{tokenhub:{apiKey:'file-key'}}}));fs.writeFileSync(deployment,JSON.stringify({serverUrl:'https://server.example',deviceToken:'device',accessToken:'personal-token'}));fs.writeFileSync(models,JSON.stringify({models:[]}));
 const db=new DatabaseSync(dbFile);db.exec("CREATE TABLE extension_site_config(extension_id TEXT,desired_enabled INTEGER,values_json TEXT); INSERT INTO extension_site_config VALUES('remote-server',1,'{\"serverUrl\":\"https://site.example\",\"accessToken\":\"personal\"}'); CREATE TABLE personal_sessions(token TEXT); INSERT INTO personal_sessions VALUES('do-not-export');");db.close();
 const {createSqliteGenerationModelStore}=await import('../../web/services/application-service/dist/index.js');
 const policies=createSqliteGenerationModelStore({path:path.join(root,'generation-models.sqlite')});
 policies.commit({expectedRevision:0,models:[{modelKey:'tokenhub/team',enabled:false}],knownModelKeys:new Set(['tokenhub/team'])});policies.close();
 const {payload,omitted}=await collectDevelopmentConfig({root:fileURLToPath(new URL('../../',import.meta.url)),env:{WOOHAA3_CONFIG_FILE:config,WOOHAA3_SECRETS_FILE:secrets,WOOHAA3_REMOTE_SERVER_CONFIG_FILE:deployment,WOOHAA3_MODELS_CONFIG_PATH:models,WOOHAA3_APPLICATION_STORE_PATH:dbFile,TOKENHUB_API_KEY:'environment-key'}});
 assert.equal(payload.secrets.providers.tokenhub.apiKey,'environment-key');assert.equal(payload.settings.providers.tokenhub.baseUrl,'https://file.example');
 assert.deepEqual(payload.modelPolicies,[{modelKey:'tokenhub/team',enabled:false}]);
 assert.equal(payload.deployment.serverUrl,'https://site.example');assert.equal(payload.deployment.deviceToken,'device');assert.ok(omitted.includes('storage.local.root'));
 assert.ok(!JSON.stringify(payload).includes('personal'));assert.ok(!JSON.stringify(payload).includes('do-not-export'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('actual desktop command imports configuration and desktop paths select the imported files',async()=>{
 const {desktopEnvironment}=await import('./desktop-host-data.mjs');
 const {fileURLToPath}=await import('node:url');
 const root=fixture();try{
 const data=path.join(root,'data'),resource=path.join(root,'runtime');fs.mkdirSync(resource);
 fs.symlinkSync(fileURLToPath(new URL('../../web/backend/',import.meta.url)),path.join(resource,'backend-runtime'),process.platform==='win32'?'junction':'dir');
 const archive=path.join(root,'team.woohaa');exportConfigPackage({output:archive,payload:{settings:{},secrets:{},extensionConfigs:[{extensionId:'remote-server',enabled:true,values:{serverUrl:'https://server.example'}}],deployment:{serverUrl:'https://server.example',deviceToken:'shared'},models:{models:[]}}});
 const output=execFileSync(process.execPath,[fileURLToPath(new URL('../desktop-host.mjs',import.meta.url)),'--resource-root',resource,'--data-dir',data,'--import-config',archive],{encoding:'utf8'});
 assert.equal(JSON.parse(output).type,'config-imported');
 const env=desktopEnvironment({dataDir:data,resourceRoot:resource});
 assert.equal(env.WOOHAA3_MODELS_CONFIG_PATH,path.join(data,'config/models.json'));
 assert.equal(env.WOOHAA3_REMOTE_SERVER_CONFIG_FILE,path.join(data,'config/remote-server.json'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('export rejects personal tokens and never replaces an existing handoff file',()=>{
 const root=fixture();try{
 const output=path.join(root,'team.woohaa');const payload={settings:{},secrets:{},extensionConfigs:[]};
 fs.writeFileSync(output,'existing');assert.throws(()=>exportConfigPackage({output,payload}),/EEXIST/);assert.equal(fs.readFileSync(output,'utf8'),'existing');
 assert.throws(()=>exportConfigPackage({output:path.join(root,'invalid.woohaa'),payload:{...payload,secrets:{accessToken:'personal'}}}),/个人会话/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('persisted model enablement and defaults are exported and imported independently of task history',async()=>{
 const {createSqliteGenerationModelStore}=await import('../../web/services/application-service/dist/index.js');
 const root=fixture();try{
 const archive=path.join(root,'models.woohaa');const payload={settings:{},secrets:{},extensionConfigs:[],modelPolicies:[{modelKey:'provider/model',enabled:true,isDefault:true,order:2}]};
 exportConfigPackage({output:archive,payload});
 importConfigPackage({dataDir:path.join(root,'data'),archive,yaml,createModelStore:createSqliteGenerationModelStore});
 const store=createSqliteGenerationModelStore({path:path.join(root,'data/stores/generation-models.sqlite')});
 try{assert.equal(store.initialized(),true);assert.deepEqual(store.snapshot().models,payload.modelPolicies);}finally{store.close();}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('runtime model catalog is handed off with correct types and ownership, without restoring execution or touching data',()=>{
 const root=fixture();try{
 const output=path.join(root,'runtime.woohaa'),dataDir=path.join(root,'data');
 const models=[{modelKey:'tokenhub:gateway-image',providerId:'tokenhub',extensionId:'tokenhub-provider',modelType:'image',title:'网关模型',enabled:true,isDefault:false,executable:false}];
 exportConfigPackage({output,payload:{settings:{},secrets:{},extensionConfigs:[],runtimeModels:models}});
 const descriptor=JSON.parse(systemTarExec(['-xOzf',output,'config-package.json'],{encoding:'utf8'}));assert.equal(descriptor.version,2);
 importConfigPackage({dataDir,archive:output,yaml});
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir,'config/runtime-models.json'),'utf8')),models);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
