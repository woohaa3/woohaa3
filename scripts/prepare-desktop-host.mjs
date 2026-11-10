#!/usr/bin/env node
import fs from 'node:fs';
import { readTrustDocument } from './lib/extension-trust/store.mjs';
import { exact, requireTrust } from './lib/extension-trust/encoding.mjs';
import { rotateRoot } from './lib/extension-trust/verify.mjs';
import { runtimeReleaseLayout } from './lib/runtime-release-layout.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { nodeArtifact, DESKTOP_NODE_VERSION, copyRuntimeFiles, copyRuntimePackage, attachRuntimePackage, assertPortableTree, linkRuntimePackage, isExternalDesktopDependency, copyNpmCli } from './lib/desktop-host-package.mjs';
import { systemTar, systemTarArgs } from './lib/desktop-platform-commands.mjs';
import { writeRuntimeLinks } from './lib/desktop-runtime-links.mjs';
import { resolvedRuntimeLock } from './package-runtime-components.mjs';
import { assertRuntimeNpmLockCurrent, auditRuntimeNpmScripts } from './lib/runtime-npm-manifest.mjs';
import { scanExtensions } from './lib/extension-scan.mjs';
import { loadBuildProfile } from './lib/build-profile.mjs';
import { applySiteDefaultEnabled } from './lib/site-extension-defaults.mjs';
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
/**
 * 校验并返回随包固定的信任配置（release desktop 的唯一 anchor 来源）。
 * 缺省返回 null；build 不是 development 时缺 anchor 直接失败，避免发布版静默退回
 * v1 裸 key 行为。build profile 的 allowUnmanagedExtensionTrust 或
 * WOOHAA_DESKTOP_TRUST_UNAMANAGED=1 显式声明“本次不启用 v2”；固定根始终优先。
 */
export function resolveDesktopTrustConfig({env=process.env,build='development',allowUnmanaged=false}={}){
 const trustConfig=env.WOOHAA3_EXTENSION_TRUST_CONFIG;
 if(!trustConfig){
  const override=env.WOOHAA_DESKTOP_TRUST_UNAMANAGED;
  const unmanaged=override===undefined||override===''?allowUnmanaged===true:override==='1';
  if(build!=='development'&&!unmanaged)throw new Error("发布版桌面必须固定扩展信任根：设置 WOOHAA3_EXTENSION_TRUST_CONFIG；确认本次不启用 v2 时在 build profile 设 desktop.allowUnmanagedExtensionTrust=true，或显式设 WOOHAA_DESKTOP_TRUST_UNAMANAGED=1"+(override!==undefined&&override!==''?`（当前 WOOHAA_DESKTOP_TRUST_UNAMANAGED=${JSON.stringify(override)}，只接受精确值 1）`:''));
  return null;
 }
 const config=readTrustDocument(path.resolve(trustConfig));exact(config,["schemaVersion","domains"]);requireTrust(config.schemaVersion===2&&Array.isArray(config.domains)&&config.domains.length>0,"invalid-trust-config");
 const now=Math.floor(Date.now()/1000);
 for(const domain of config.domains){exact(domain,["root","floors","extensionIds",...['metadataUrl','bootstrap'].filter(key=>Object.hasOwn(domain,key))]);rotateRoot(domain.root,[],now);exact(domain.floors,["root","targets","snapshot","timestamp"])}
 return config;
}
export async function prepareDesktopHost({output=path.join(root,'.local/desktop-host'),frontend=path.join(root,'web/frontend/dist'),build='development',runtimeReleaseVersion}={}){
 const buildProfile=loadBuildProfile({repoRoot:path.dirname(root),env:process.env});
 if(!buildProfile.ok)throw new Error('build profile 校验失败：'+buildProfile.errors.map(error=>`${error.path}: ${error.message}`).join('; '));
 const trustConfig=resolveDesktopTrustConfig({env:process.env,build,allowUnmanaged:buildProfile.resolved.allowUnmanagedExtensionTrust});
 const appVersion=runtimeReleaseVersion??JSON.parse(fs.readFileSync(path.join(root,'desktop/tauri.conf.json'),'utf8')).version;
 const artifact=nodeArtifact();const suffix=process.platform==='win32'?'.exe':'';
 const {node,nodeSha256:actual}=await prepareDesktopNode();
 // Rebuild the staging tree. Never copy user configuration from source packages.
 fs.rmSync(output,{recursive:true,force:true});fs.mkdirSync(output,{recursive:true});
 const yaml=createRequire(path.join(root,'web/backend/package.json'))('yaml');
 const state=new Map();state.platform=process.platform;state.arch=process.arch;state.runtimeOnly=true;state.excludeDependency=isExternalDesktopDependency;state.packageExtensions=yaml.parse(fs.readFileSync(path.join(root,'web/pnpm-workspace.yaml'),'utf8')).packageExtensions??{};
 attachRuntimePackage(path.join(root,'web/backend'),path.join(output,'backend-runtime'),output,state);
 fs.mkdirSync(path.join(output,'scripts/lib'),{recursive:true});
 for(const entry of fs.readdirSync(path.join(root,'scripts/lib')))if(entry.endsWith('.mjs')&&!entry.includes('.test.'))fs.copyFileSync(path.join(root,'scripts/lib',entry),path.join(output,'scripts/lib',entry));
 fs.mkdirSync(path.join(output,"scripts/lib/extension-trust"),{recursive:true});
 for(const file of ["encoding.mjs","verify.mjs","store.mjs","runtime.mjs"])fs.copyFileSync(path.join(root,"scripts/lib/extension-trust",file),path.join(output,"scripts/lib/extension-trust",file));
 if(trustConfig)fs.writeFileSync(path.join(output,"extension-trust.json"),JSON.stringify(trustConfig));
 fs.copyFileSync(path.join(root,'scripts/desktop-host.mjs'),path.join(output,'scripts/desktop-host.mjs'));
 fs.copyFileSync(path.join(root,'scripts/extensions-preflight.mjs'),path.join(output,'scripts/extensions-preflight.mjs'));
 fs.writeFileSync(path.join(output,'desktop-host.mjs'),`import './scripts/desktop-host.mjs';\n`);
 copyRuntimeFiles(frontend,path.join(output,'frontend'));
 copyRuntimeFiles(path.join(root,'web/contracts/src/base-path'),path.join(output,'web/contracts/src/base-path'));
 fs.copyFileSync(path.join(root,'web/services/task-service/pptask.models.json'),path.join(output,'models.json'));
 const siteDefaults=buildProfile.ok?buildProfile.resolved.siteExtensionDefaults:{};
 const extensions=[];
 // 入包扩展以目录位置为权威：`web/extensions/` 下的每个扩展都进桌面包，不再维护单独清单。
 const webExtensionsRoot=path.join(root,'web/extensions');
 const scanned=scanExtensions({repoRoot:root,env:{}}).extensions;
 for(const extension of scanned){
  if(extension.root!==webExtensionsRoot)continue;
  const target=copyRuntimePackage(extension.dir,output,state);const link=path.join(output,'extensions',extension.extensionId);
  copyRuntimeFiles(target,link);
  if(siteDefaults[extension.extensionId]!==undefined)applySiteDefaultEnabled({extensionDir:link,enabled:siteDefaults[extension.extensionId]});
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
 const runtimeCdnRoot=(buildProfile.ok?buildProfile.resolved.runtimeCdnUrl:'')||runtimeDownloads.cdn?.baseUrl||'';
 runtimeDownloads.cdn={baseUrl:runtimeReleaseVersion?runtimeReleaseLayout({version:runtimeReleaseVersion,cdnBaseUrl:runtimeCdnRoot}).baseUrl:runtimeCdnRoot};
 fs.writeFileSync(path.join(output,'runtime-downloads.json'),JSON.stringify(runtimeDownloads,null,2)+'\n');
 fs.writeFileSync(path.join(output,'runtime-components.lock.json'),JSON.stringify(resolvedRuntimeLock(),null,2)+'\n');
 fs.mkdirSync(path.join(output,'tools'),{recursive:true});
 fs.copyFileSync(path.join(root,'.local/desktop-node',artifact.archive.replace(/(?:\.tar\.gz|\.zip)$/,''),'LICENSE'),path.join(output,'tools/NODE_LICENSE'));
 // app-local npm CLI：运行期从 npm registry 安装 Agent runtime 的唯一入口。
 const npmCli=copyNpmCli(path.join(root,'.local/desktop-node',artifact.archive.replace(/(?:\.tar\.gz|\.zip)$/,'')),path.join(output,'tools'));
 const npmLock=assertRuntimeNpmLockCurrent({clientRoot:root});
 fs.writeFileSync(path.join(output,'runtime-npm-lock.json'),JSON.stringify(npmLock,null,2)+'\n');
 // 构建期审核：本平台已安装依赖里出现未审核的 lifecycle script 直接失败。
 const scriptAudit=auditRuntimeNpmScripts({clientRoot:root,lock:npmLock});
 fs.writeFileSync(path.join(output,'runtime-npm-scripts.audit.json'),JSON.stringify(scriptAudit,null,2)+'\n');
 fs.writeFileSync(path.join(output,'runtime-npm-toolchain.json'),JSON.stringify({schema:1,node:DESKTOP_NODE_VERSION,npmCli:path.relative(output,npmCli.npmCli).split(path.sep).join('/'),bytes:npmCli.bytes},null,2)+'\n');
 if(process.platform==='win32')writeRuntimeLinks(output,state.links??[]);
 fs.writeFileSync(path.join(output,'host-manifest.json'),JSON.stringify({schema:1,version:appVersion,build,nodeVersion:DESKTOP_NODE_VERSION,nodeSha256:actual,extensions,packages:state.size,npmCli:path.relative(output,npmCli.npmCli).split(path.sep).join('/'),npmLock:'runtime-npm-lock.json',inventory:[...state.keys()].map(dir=>{const pkg=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));return {name:pkg.name,version:pkg.version};})},null,2));
 assertPortableTree(output);
 console.log(`[desktop-host] ${state.size} packages, ${extensions.length} extensions → ${output}`);
 return {resourceRoot:output,node,nodeVersion:DESKTOP_NODE_VERSION,nodeSha256:actual,extensions,packages:state.size,npmCli:npmCli.npmCli};
}
export async function prepareDevelopmentHost(){
 const prepared=await prepareDesktopNode();const artifact=nodeArtifact();const suffix=process.platform==='win32'?'.exe':'';
 const output=path.join(root,'.local/desktop-dev-host');fs.mkdirSync(output,{recursive:true});
 for(const [name,source] of [['backend-runtime',path.join(root,'web/backend')],['frontend',path.join(root,'web/frontend/dist')],['scripts',path.join(root,'scripts')],['models.json',path.join(root,'web/services/task-service/pptask.models.json')]]) {
  const dest=path.join(output,name);if(!fs.existsSync(dest)){if(process.platform==='win32'&&!fs.statSync(source).isDirectory())fs.copyFileSync(source,dest);else fs.symlinkSync(source,dest,process.platform==='win32'?'junction':'dir');}
 }
 fs.writeFileSync(path.join(output,'desktop-host.mjs'),`import './scripts/desktop-host.mjs';\n`);
 const appVersion=JSON.parse(fs.readFileSync(path.join(root,'desktop/tauri.conf.json'),'utf8')).version;
 fs.writeFileSync(path.join(output,'host-manifest.json'),JSON.stringify({schema:1,version:appVersion,build:'development',nodeVersion:DESKTOP_NODE_VERSION,developmentRoot:root}));
 fs.mkdirSync(path.join(output,'tools'),{recursive:true});
 for(const [name,source] of [['model-renderer',path.join(root,`bevy/target/${artifact.triple}/debug/model-renderer${suffix}`)],['world-video-encoder',path.join(root,`bevy/target/${artifact.triple}/debug/world-video-encoder${suffix}`)]]){const dest=path.join(output,'tools',name+suffix);if(fs.existsSync(source)&&!fs.existsSync(dest)){if(process.platform==='win32')fs.copyFileSync(source,dest);else fs.symlinkSync(source,dest);}}
 return {...prepared,resourceRoot:output};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){prepareDesktopHost({build:process.env.WOOHAA_DESKTOP_BUILD??'development'}).catch(error=>{console.error(error);process.exitCode=1;});}
