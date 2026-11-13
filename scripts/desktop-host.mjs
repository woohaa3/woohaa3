#!/usr/bin/env node
/** Dedicated desktop entry: stdout is JSONL control, stderr is diagnostic only. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { acquireDataLock, desktopEnvironment, prepareData, commitDataVersion, exportWorkspace, importWorkspace, restoreBackup } from './lib/desktop-host-data.mjs';
import { agentRuntimeDirectory, hashKey } from './lib/agent-runtime-endpoints.mjs';
import { createAgentSupervisorHost } from './lib/agent-runtime-supervisor-host.mjs';
import { importConfigPackage } from './lib/config-handoff.mjs';
import { materializeRuntimeLinks } from './lib/desktop-runtime-links.mjs';
const arg=(name,fallback)=>{const i=process.argv.indexOf(`--${name}`);return i<0?fallback:process.argv[i+1];};
const emit=value=>process.stdout.write(`${JSON.stringify(value)}\n`);
// Heartbeat precedes awaited extension/backend startup. Archive helper commands stay single-response.
if(arg('instance')){emit({type:'heartbeat'});setInterval(()=>emit({type:'heartbeat'}),2000).unref();}
// Libraries must never corrupt the control stream.
console.log=(...args)=>console.error(...args);
const inheritedIngress=process.env.WOOHAA3_TRUSTED_INGRESS_SECRET;
const dataDir=path.resolve(arg('data-dir',''));const resourceRoot=path.resolve(arg('resource-root',''));
// Monitor preserves Node's default fatal-exception behavior (including exit status).
process.on('uncaughtExceptionMonitor', (error, origin) => {
 try { process.stderr.write(`[desktop-host] ${JSON.stringify({event:'fatal-exception',time:new Date().toISOString(),pid:process.pid,origin,stack:error?.stack??String(error)})}\n`); } catch {}
});
let releaseLock,runtime,agentSupervisor,closing=false;
async function shutdown(){
 if(closing)return;closing=true;
 // 只停止探活：执行器运行时与在途回合由下一宿主接管（change: 2026-11-10-split-agent-runtime-lifecycle）。
 try{agentSupervisor?.stopWatch();await runtime?.close();releaseLock?.();releaseLock=null;emit({type:'stopped'});process.exit(0);}
 catch(error){emit({type:'error',message:`关闭失败：${error.message}`});process.exit(1);}
}
async function main(){
 if(!arg('data-dir')||!arg('resource-root'))throw new Error('缺少 data-dir 或 resource-root');
 if(arg('export')){emit({type:'exported',...exportWorkspace(dataDir,arg('export'))});return;}
 if(arg('restore-backup')){emit({type:'restored',...restoreBackup(dataDir,arg('restore-backup'))});return;}
 if(arg('import-config')){
  materializeRuntimeLinks(resourceRoot);
  const require=createRequire(path.join(resourceRoot,'backend-runtime/package.json'));
  const {createSqliteSiteExtensionConfigStore,createSqliteGenerationModelStore}=await import(pathToFileURL(path.join(resourceRoot,'backend-runtime/dist/index.js')).href);
  emit({type:'config-imported',...importConfigPackage({dataDir,archive:arg('import-config'),yaml:require('yaml'),createStore:createSqliteSiteExtensionConfigStore,createModelStore:createSqliteGenerationModelStore})});return;
 }
 if(arg('import')){emit({type:'imported',...importWorkspace(dataDir,arg('import'))});return;}
 const instance=arg('instance');if(!instance)throw new Error('缺少 instance');
 releaseLock=acquireDataLock(dataDir);
 const versionFile=path.join(resourceRoot,'host-manifest.json');
 const manifest=fs.existsSync(versionFile)?JSON.parse(fs.readFileSync(versionFile,'utf8')):{schema:1,build:'development'};
 if(manifest.nodeVersion&&process.versions.node!==manifest.nodeVersion)throw new Error(`宿主要求 Node ${manifest.nodeVersion}`);
 const version={schema:manifest.schema??1,build:manifest.build};prepareData(dataDir,version);
 process.chdir(dataDir);
 const env=desktopEnvironment({dataDir,resourceRoot,baseEnv:process.env,development:Boolean(manifest.developmentRoot)});
 if(process.env.WOOHAA_DESKTOP_RUN_DIR)env.WOOHAA3_LOG_DIR=process.env.WOOHAA_DESKTOP_RUN_DIR;
 if(manifest.version)env.WOOHAA3_APP_VERSION=manifest.version;
 if(arg('dev-origin'))env.WOOHAA3_ALLOWED_ORIGINS=new URL(arg('dev-origin')).origin;
 if(manifest.developmentRoot&&inheritedIngress)env.WOOHAA3_TRUSTED_INGRESS_SECRET=inheritedIngress;
 Object.assign(process.env,env);
 // Ensure library code reading process.env cannot recover inherited development settings.
 for(const key of Object.keys(process.env))if((key.startsWith('WOOHAA3_')&&!Object.hasOwn(env,key))||['NODE_OPTIONS','NODE_PATH','MONGODB_URI','MONGODB_DB'].includes(key))delete process.env[key];
 // 独立执行器（Agent 来源 / SDK / OAuth / 本机通道）：桌面形态与 dev 启动器同源，
 // 先按 workspace 复用或拉起随包 daemon，再把连接信息交给 backend。
 const executorScript=path.join(resourceRoot,'executor-runtime','dist','cli.js');
 try{
  if(!fs.existsSync(executorScript))throw new Error(`缺少随包执行器运行时：${executorScript}`);
  agentSupervisor=createAgentSupervisorHost({
   root:resourceRoot,
   runtimeDir:agentRuntimeDirectory({root:dataDir}),
   canvasWorkspaceRoot:path.join(dataDir,'agent-workspaces'),
   canvasWorkspaceProtectedPaths:[resourceRoot,...['config','secrets','stores','media','extension-data','extensions'].map(name=>path.join(dataDir,name))],
   workspaceKey:hashKey(path.resolve(dataDir)),
   scriptPath:executorScript,
   expectedRuntimeBuild:createHash('sha256').update(fs.readFileSync(executorScript)).digest('hex').slice(0,32),
   log:message=>console.error(`[agent-runtime] ${message}`)
  });
  const agentRuntime=await agentSupervisor.ensure();
  agentSupervisor.startWatch();
  env.WOOHAA3_AGENT_RUNTIME_SOCKET=agentRuntime.socketPath;
  env.WOOHAA3_AGENT_RUNTIME_TOKEN=agentRuntime.token;
  env.WOOHAA3_AGENT_WORKSPACE_KEY=agentRuntime.workspaceKey;
  Object.assign(process.env,{
   WOOHAA3_AGENT_RUNTIME_SOCKET:agentRuntime.socketPath,
   WOOHAA3_AGENT_RUNTIME_TOKEN:agentRuntime.token,
   WOOHAA3_AGENT_WORKSPACE_KEY:agentRuntime.workspaceKey
  });
  console.error(`[agent-runtime] 执行器就绪 pid=${agentRuntime.pid} reused=${agentRuntime.reused}`);
 }catch(error){
  // 执行器不可用不阻断画布与本地文件；插件激活会如实报告失败原因，日志保留真实堆栈。
  agentSupervisor=null;
  console.error(`[desktop-host] 执行器运行时不可用：${error?.stack??error}`);
 }
 materializeRuntimeLinks(resourceRoot);
 const backendRoot=path.join(resourceRoot,'backend-runtime');
 const require=createRequire(path.join(backendRoot,'package.json'));
 const yaml=require('yaml');
 const configFile=env.WOOHAA3_CONFIG_FILE;
 const config=fs.existsSync(configFile)?yaml.parse(fs.readFileSync(configFile,'utf8'))??{}:{};
 // Local storage always belongs to this workspace, including after importing on another Mac.
 config.storage={...config.storage,primary:'local',local:{...config.storage?.local,root:path.join(dataDir,'media')}};
 fs.writeFileSync(configFile,yaml.stringify(config),{mode:0o600});
 if(manifest.developmentRoot){
  const {resolveExtensionRoots}=await import('./lib/extension-scan.mjs');
  env.WOOHAA3_EXTENSION_DIRS=resolveExtensionRoots({repoRoot:manifest.developmentRoot,env:{}}).roots.concat(path.join(dataDir,'extensions')).join(',');
  process.env.WOOHAA3_EXTENSION_DIRS=env.WOOHAA3_EXTENSION_DIRS;
 }
 const {loadExtensionHost}=await import('./lib/extension-host.mjs');
 const {createBackendService}=await import(pathToFileURL(path.join(backendRoot,'dist/index.js')).href);
 const {publishDesktopLoopbackPort,startDesktopServer}=await import('./lib/desktop-host-runtime.mjs');
 const requestedPort=Number(arg('port','0'));
 if(Number.isInteger(requestedPort)&&requestedPort>0)publishDesktopLoopbackPort(requestedPort,[env,process.env]);
 const extensionHost=await loadExtensionHost({repoRoot:manifest.developmentRoot??resourceRoot,env,logger:event=>console.error(`[extensions] ${JSON.stringify(event)}`)});
 const backend=await createBackendService({desktopCanvasAgentWorkspace:{version:1},env,basePath:'/',extensionHost});
 runtime=await startDesktopServer({backend,frontendDir:path.join(resourceRoot,'frontend'),extensionHost,instance,port:requestedPort,devOrigin:arg('dev-origin',null),env});
 commitDataVersion(dataDir,version);
 emit(runtime.ready);
 process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
 const input=createInterface({input:process.stdin,crlfDelay:Infinity});
 input.on('line',line=>{try{const command=JSON.parse(line);if(command.type==='shutdown')void shutdown();}catch{emit({type:'error',message:'无效控制消息'});}});
 input.on('close',()=>void shutdown());
}
main().catch(async error=>{
 console.error(`[desktop-host] ${error.stack??error.message}`);
 try{await runtime?.close();}finally{releaseLock?.();}
 emit({type:'error',message:error.message});process.exit(1);
});
