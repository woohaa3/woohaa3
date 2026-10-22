import test from 'node:test';import assert from 'node:assert/strict';
import {readRuntimeModels} from './runtime-models-export.mjs';
const model={modelKey:'tokenhub:team-image',providerId:'tokenhub',extensionId:'tokenhub-provider',modelType:'image',title:'团队图像',enabled:true,isDefault:false,executable:true};
test('exports dynamic gateway and server models without executable authority or unrelated secrets',async()=>{
 const result=await readRuntimeModels({env:{BACKEND_PORT:'5181'},fetchImpl:async url=>{assert.equal(String(url),'http://127.0.0.1:5181/api/generation-models');return {ok:true,json:async()=>({revision:1,initialized:false,models:[{...model,apiKey:'must-not-export'},{...model,modelKey:'remote:abc',providerId:'remote',extensionId:'remote-server'}]})};}});
 assert.equal(result.models.length,2);assert.equal(result.models[0].executable,false);assert.ok(!JSON.stringify(result.models).includes('must-not-export'));
});
test('unavailable host fails export instead of silently omitting live models',async()=>{
 await assert.rejects(()=>readRuntimeModels({env:{},fetchImpl:async()=>{throw new Error('offline')}}),/pnpm dev/);
});
test('explicit source must be local and supports base paths',async()=>{
 await assert.rejects(()=>readRuntimeModels({origin:'https://remote.example',fetchImpl:()=>{throw new Error('should not fetch')}}),/本机/);
 const result=await readRuntimeModels({origin:'http://localhost:9000/app/',fetchImpl:async url=>{assert.equal(String(url),'http://localhost:9000/app/api/generation-models');return {ok:true,json:async()=>({revision:0,initialized:false,models:[]})};}});assert.deepEqual(result.models,[]);
});

test('real export CLI reads a live loopback catalog and embeds it in the handoff archive',async()=>{
 const {createServer}=await import('node:http');const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');
 const {fileURLToPath}=await import('node:url');const {execFile,execFileSync}=await import('node:child_process');const {promisify}=await import('node:util');const {systemTarExec}=await import('./desktop-platform-commands.mjs');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'woohaa-live-model-export-'));
 const server=createServer((req,res)=>{assert.equal(req.url,'/api/generation-models');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({revision:0,initialized:false,models:[{...model,apiKey:'not-exported'}]}));});
 try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 for(const [file,data] of [['env',''],['config.yml','providers:\n  tokenhub:\n    baseUrl: https://gateway.example\n'],['secrets.yml','providers:\n  tokenhub:\n    apiKey: shared-test-key\n'],['models.json','{"models":[]}'],['remote.json','{}']])fs.writeFileSync(path.join(directory,file),data);
 const env=Object.fromEntries(['PATH','HOME','TMPDIR','SystemRoot','TEMP'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
 Object.assign(env,{WOOHAA3_SERVICE_ENV_FILE:path.join(directory,'env'),WOOHAA3_CONFIG_FILE:path.join(directory,'config.yml'),WOOHAA3_SECRETS_FILE:path.join(directory,'secrets.yml'),WOOHAA3_MODELS_CONFIG_PATH:path.join(directory,'models.json'),WOOHAA3_REMOTE_SERVER_CONFIG_FILE:path.join(directory,'remote.json'),WOOHAA3_APPLICATION_STORE_PATH:path.join(directory,'application.sqlite'),WOOHAA3_TASK_STORE_PATH:path.join(directory,'task.sqlite')});
 const output=path.join(directory,'team.woohaa');const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../export-config.mjs',import.meta.url)),'--out',output,'--from',`http://127.0.0.1:${server.address().port}`],{env});
 const descriptor=JSON.parse(systemTarExec(['-xOzf',output,'config-package.json'],{encoding:'utf8'}));
 assert.equal(descriptor.payload.runtimeModels[0].modelKey,model.modelKey);assert.equal(descriptor.payload.runtimeModels[0].executable,false);
 assert.equal(descriptor.payload.secrets.providers.tokenhub.apiKey,'shared-test-key');assert.ok(!JSON.stringify(descriptor).includes('not-exported'));assert.match(stdout,/"tokenhub": 1/);
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(directory,{recursive:true,force:true});}
});
