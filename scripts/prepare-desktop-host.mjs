#!/usr/bin/env node
import fs from 'node:fs';
import { runtimeReleaseLayout } from './lib/runtime-release-layout.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { nodeArtifact, DESKTOP_NODE_VERSION, copyRuntimeFiles, copyRuntimePackage, attachRuntimePackage, assertPortableTree, linkRuntimePackage, isExternalDesktopDependency } from './lib/desktop-host-package.mjs';
import { systemTar, systemTarArgs } from './lib/desktop-platform-commands.mjs';
import { writeRuntimeLinks } from './lib/desktop-runtime-links.mjs';
import { resolvedRuntimeLock } from './package-runtime-components.mjs';
import { scanExtensions } from './lib/extension-scan.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const run=(command,args,options={})=>execFileSync(command,args,{cwd:root,stdio:'inherit',windowsHide:true,...options});
export async function prepareDesktopNode(){
 const artifact=nodeArtifact();const cache=path.join(root,'.local/desktop-node');fs.mkdirSync(cache,{recursive:true});
 const archive=path.join(cache,artifact.archive);const sums=path.join(cache,'SHASUMS256.txt');
 if(!fs.existsSync(sums))run(process.platform==='win32'?'curl.exe':'curl',['--fail','--location','--retry','2',`https://nodejs.org/dist/v${DESKTOP_NODE_VERSION}/SHASUMS256.txt`,'-o',sums]);
 if(!fs.existsSync(archive))run(process.platform==='win32'?'curl.exe':'curl',['--fail','--location','--retry','2',`https://nodejs.org/dist/v${DESKTOP_NODE_VERSION}/${artifact.archive}`,'-o',archive]);
 const expected=fs.readFileSync(sums,'utf8').split('\n').find(line=>line.trim().endsWith(` ${artifact.archive}`))?.split(/\s+/)[0];
 const actual=createHash('sha256').update(fs.readFileSync(archive)).digest('hex');if(!expected||expected!==actual)throw new Error('Node SHA256 校验失败');
 const extracted=path.join(cache,artifact.archive.replace(/(?:\.tar\.gz|\.zip)$/,''));
 const node=path.join(extracted,process.platform==='win32'?'node.exe':'bin/node');
 if(!fs.existsSync(node)){
  if(process.platform==='win32')run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Expand-Archive -LiteralPath $env:WOOHAA_NODE_ARCHIVE -DestinationPath $env:WOOHAA_NODE_CACHE -Force`],{env:{...process.env,WOOHAA_NODE_ARCHIVE:archive,WOOHAA_NODE_CACHE:cache},windowsHide:true});
  else run(systemTar(), systemTarArgs(systemTar(), ['-xzf',archive,'-C',cache]));
 }const probe=execFileSync(node,['--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(':memory:');db.exec('create table probe(id)');db.close();process.stdout.write(process.versions.node)`],{encoding:'utf8',windowsHide:true});
 if(probe!==DESKTOP_NODE_VERSION)throw new Error('Node SQLite/version 探针失败');
 const binaries=path.join(root,'desktop/build/binaries');fs.mkdirSync(binaries,{recursive:true});const binary=path.join(binaries,`woohaa-node-${artifact.triple}${process.platform==='win32'?'.exe':''}`);fs.copyFileSync(node,binary);fs.chmodSync(binary,0o755);
 return {node:binary,nodeSha256:actual};
}
export async function prepareDesktopHost({output=path.join(root,'.local/desktop-host'),frontend=path.join(root,'web/frontend/dist'),build='development',runtimeReleaseVersion}={}){
 const artifact=nodeArtifact();const suffix=process.platform==='win32'?'.exe':'';
 const {node,nodeSha256:actual}=await prepareDesktopNode();
 // Rebuild the staging tree. Never copy user configuration from source packages.
 fs.rmSync(output,{recursive:true,force:true});fs.mkdirSync(output,{recursive:true});
 const yaml=createRequire(path.join(root,'web/backend/package.json'))('yaml');
 const state=new Map();state.platform=process.platform;state.arch=process.arch;state.runtimeOnly=true;state.excludeDependency=isExternalDesktopDependency;state.packageExtensions=yaml.parse(fs.readFileSync(path.join(root,'web/pnpm-workspace.yaml'),'utf8')).packageExtensions??{};
 attachRuntimePackage(path.join(root,'web/backend'),path.join(output,'backend-runtime'),output,state);
 fs.mkdirSync(path.join(output,'scripts/lib'),{recursive:true});
 for(const entry of fs.readdirSync(path.join(root,'scripts/lib')))if(entry.endsWith('.mjs')&&!entry.includes('.test.'))fs.copyFileSync(path.join(root,'scripts/lib',entry),path.join(output,'scripts/lib',entry));
 fs.copyFileSync(path.join(root,'scripts/desktop-host.mjs'),path.join(output,'scripts/desktop-host.mjs'));
 fs.copyFileSync(path.join(root,'scripts/extensions-preflight.mjs'),path.join(output,'scripts/extensions-preflight.mjs'));
 fs.writeFileSync(path.join(output,'desktop-host.mjs'),`import './scripts/desktop-host.mjs';\n`);
 copyRuntimeFiles(frontend,path.join(output,'frontend'));
 copyRuntimeFiles(path.join(root,'web/contracts/src/base-path'),path.join(output,'web/contracts/src/base-path'));
 fs.copyFileSync(path.join(root,'web/services/task-service/pptask.models.json'),path.join(output,'models.json'));
 const extensions=[];
 const inventory=JSON.parse(fs.readFileSync(path.join(root,'desktop/host-extensions.json'),'utf8')).extensions;
 const scanned=scanExtensions({repoRoot:root,env:{}}).extensions;
 for(const id of inventory)if(!scanned.some(extension=>extension.extensionId===id))throw new Error(`内置扩展不存在：${id}`);
 for(const extension of scanned){
  if(!inventory.includes(extension.extensionId))continue;
  const target=copyRuntimePackage(extension.dir,output,state);const link=path.join(output,'extensions',extension.extensionId);
  copyRuntimeFiles(target,link);
  // Scanner deliberately accepts directories only. Keep a physical extension root,
  // while its dependency edges share the central collected graph.
  if(process.platform==='win32'){
   const prefix=path.relative(output,path.join(target,'node_modules')).split(path.sep).join('/')+'/';
   for(const edge of [...(state.links??[])])if(edge.link.startsWith(prefix))state.links.push({...edge,link:path.relative(output,path.join(link,'node_modules')).split(path.sep).join('/')+'/'+edge.link.slice(prefix.length)});
  }else{
   const deps=path.join(target,'node_modules');
   if(fs.existsSync(deps))for(const name of fs.readdirSync(deps)){
    const names=name.startsWith('@')?fs.readdirSync(path.join(deps,name)).map(item=>`${name}/${item}`):[name];
    for(const dep of names)linkRuntimePackage(fs.realpathSync(path.join(deps,dep)),path.join(link,'node_modules',dep),output,state);
   }
  }
  fs.rmSync(path.join(target,'browser-dist'),{recursive:true,force:true});
  extensions.push(extension.extensionId);
 }
 const runtimeDownloads=JSON.parse(fs.readFileSync(path.join(root,'desktop/runtime-downloads.json'),'utf8'));
 const runtimeCdnRoot=process.env.WOOHAA_RUNTIME_CDN_BASE_URL??runtimeDownloads.cdn?.baseUrl??'';
 runtimeDownloads.cdn={baseUrl:runtimeReleaseVersion?runtimeReleaseLayout({version:runtimeReleaseVersion,cdnBaseUrl:runtimeCdnRoot}).baseUrl:runtimeCdnRoot};
 fs.writeFileSync(path.join(output,'runtime-downloads.json'),JSON.stringify(runtimeDownloads,null,2)+'\n');
 fs.writeFileSync(path.join(output,'runtime-components.lock.json'),JSON.stringify(resolvedRuntimeLock(),null,2)+'\n');
 fs.mkdirSync(path.join(output,'tools'),{recursive:true});
 fs.copyFileSync(path.join(root,'.local/desktop-node',artifact.archive.replace(/(?:\.tar\.gz|\.zip)$/,''),'LICENSE'),path.join(output,'tools/NODE_LICENSE'));
 if(process.platform==='win32')writeRuntimeLinks(output,state.links??[]);
 fs.writeFileSync(path.join(output,'host-manifest.json'),JSON.stringify({schema:1,build,nodeVersion:DESKTOP_NODE_VERSION,nodeSha256:actual,extensions,packages:state.size,inventory:[...state.keys()].map(dir=>{const pkg=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));return {name:pkg.name,version:pkg.version};})},null,2));
 assertPortableTree(output);
 console.log(`[desktop-host] ${state.size} packages, ${extensions.length} extensions → ${output}`);
 return {resourceRoot:output,node,nodeVersion:DESKTOP_NODE_VERSION,nodeSha256:actual,extensions,packages:state.size};
}
export async function prepareDevelopmentHost(){
 const prepared=await prepareDesktopNode();const artifact=nodeArtifact();const suffix=process.platform==='win32'?'.exe':'';
 const output=path.join(root,'.local/desktop-dev-host');fs.mkdirSync(output,{recursive:true});
 for(const [name,source] of [['backend-runtime',path.join(root,'web/backend')],['frontend',path.join(root,'web/frontend/dist')],['scripts',path.join(root,'scripts')],['models.json',path.join(root,'web/services/task-service/pptask.models.json')]]) {
  const dest=path.join(output,name);if(!fs.existsSync(dest)){if(process.platform==='win32'&&!fs.statSync(source).isDirectory())fs.copyFileSync(source,dest);else fs.symlinkSync(source,dest,process.platform==='win32'?'junction':'dir');}
 }
 fs.writeFileSync(path.join(output,'desktop-host.mjs'),`import './scripts/desktop-host.mjs';\n`);
 fs.writeFileSync(path.join(output,'host-manifest.json'),JSON.stringify({schema:1,build:'development',nodeVersion:DESKTOP_NODE_VERSION,developmentRoot:root}));
 fs.mkdirSync(path.join(output,'tools'),{recursive:true});
 for(const [name,source] of [['model-renderer',path.join(root,`bevy/target/${artifact.triple}/debug/model-renderer${suffix}`)],['shot-recorder',path.join(root,`desktop/target/debug/shot-recorder${suffix}`)]]){const dest=path.join(output,'tools',name+suffix);if(fs.existsSync(source)&&!fs.existsSync(dest)){if(process.platform==='win32')fs.copyFileSync(source,dest);else fs.symlinkSync(source,dest);}}
 return {...prepared,resourceRoot:output};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){prepareDesktopHost({build:process.env.WOOHAA_DESKTOP_BUILD??'development'}).catch(error=>{console.error(error);process.exitCode=1;});}
