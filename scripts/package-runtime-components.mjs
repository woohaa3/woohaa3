/** Build immutable, signed self-hosted component artifacts. Never installs dependencies. */
import fs from 'node:fs';
import { runtimeReleaseLayout } from './lib/runtime-release-layout.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { copyRuntimeFiles, copyRuntimePackage, locateDependency, nodeArtifact } from './lib/desktop-host-package.mjs';
import { writeRuntimeLinks } from './lib/desktop-runtime-links.mjs';
import { createComponentArchive } from './lib/runtime-archive.mjs';
export { createComponentArchive } from './lib/runtime-archive.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const sha256=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function nativeToolSources({platform=process.platform,arch=process.arch}={}){
 const artifact=nodeArtifact(platform,arch),suffix=platform==='win32'?'.exe':'';
 return Object.fromEntries(['shot-recorder','model-renderer'].map(id=>{
  const preferred=path.join(root,`bevy/target/${artifact.triple}/release/${id}${suffix}`);
  const fallback=path.join(root,id==='model-renderer'?'bevy':'desktop',`target/release/${id}${suffix}`);
  return [id,fs.existsSync(preferred)?preferred:fallback];
 }));
}
export function resolvedRuntimeLock(options={}){
 const lock=readJson(path.join(root,'desktop/runtime-components.lock.json'));
 for(const [id,file] of Object.entries(nativeToolSources(options))){
  if(!fs.existsSync(file))throw new Error(`构建组件前请先构建 release 工具：${id} (${file})`);
  lock.components[id]={version:`0.1.0-${sha256(file).slice(0,16)}`};
 }
 return lock;
}
function dependency(source,name){const found=locateDependency(fs.realpathSync(source),name);if(!found)throw new Error(`缺少已安装依赖 ${name}`);return found;}
function copyLicenses(source,target){for(const name of fs.readdirSync(source))if(/^(license|licence|notice|readme)/i.test(name)&&fs.statSync(path.join(source,name)).isFile())fs.copyFileSync(path.join(source,name),path.join(target,name));}
export async function packageRuntimeComponents({output=path.join(root,'artifacts/runtimes/upload'),platform=process.platform,arch=process.arch,releaseVersion=readJson(path.join(root,'desktop/tauri.conf.json')).version,keyFile=process.env.WOOHAA_RUNTIME_SIGNING_KEY_FILE,key=process.env.WOOHAA_RUNTIME_SIGNING_KEY,ids=['codex','claude','dsh','shot-recorder','model-renderer']}={}){
 const layout=runtimeReleaseLayout({platform,arch,version:releaseVersion});
 output=path.join(output,...layout.relativeDirectory.split('/'));
 const privateKey=createPrivateKey(keyFile?fs.readFileSync(keyFile):key??(()=>{throw new Error('需要 WOOHAA_RUNTIME_SIGNING_KEY_FILE（Ed25519 PEM 私钥路径）');})());
 if(privateKey.asymmetricKeyType!=='ed25519')throw new Error('组件签名必须使用 Ed25519');
 const lock=resolvedRuntimeLock({platform,arch});const sdkSource=path.join(root,'web/extensions/sdk-agent');
 const catalogFile=path.join(output,'catalog.json'),signatureFile=path.join(output,'catalog.sig');
 let previous=[];
 if(fs.existsSync(catalogFile)){
  const bytes=fs.readFileSync(catalogFile);
  if(!fs.existsSync(signatureFile)||!verify(null,bytes,createPublicKey(privateKey),Buffer.from(fs.readFileSync(signatureFile,'utf8').trim(),'base64')))throw new Error('现有组件目录签名无效；拒绝覆盖');
  const existing=JSON.parse(bytes);if(existing.schemaVersion!==1||!Array.isArray(existing.components))throw new Error('现有组件目录格式无效');previous=existing.components;
 }
 const components=[];const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'woohaa-components-'));
 try{for(const id of ids){
  if(!lock.components[id])throw new Error(`未知组件 ${id}`);
  const version=lock.components[id].version,staging=path.join(temporary,id);
  if(previous.some(item=>item.id===id&&item.platform===platform&&item.arch===arch&&item.version!==version))throw new Error(`Runtime release conflict for ${id}; use a new --version`);
  const published=previous.find(item=>item.id===id&&item.version===version&&item.platform===platform&&item.arch===arch);
  if(published){
   const file=path.resolve(output,published.url);if(!file.startsWith(path.resolve(output)+path.sep)||!fs.existsSync(file)||sha256(file)!==published.sha256)throw new Error(`已发布组件缺失或被修改：${id}@${version}`);
   components.push(published);continue;
  }
  fs.mkdirSync(staging);
  let entry,kind='executable';
  if(id==='codex'){
   const sdk=dependency(sdkSource,'@openai/codex-sdk'),cli=dependency(sdk,'@openai/codex');
   const meta=readJson(path.join(cli,'package.json'));
   if(readJson(path.join(sdk,'package.json')).version!==version)throw new Error(`Codex SDK 与锁文件版本不符：${version}`);
   const variant=Object.keys(meta.optionalDependencies??{}).find(name=>name===`@openai/codex-${platform}-${arch}`);
   const source=variant?dependency(cli,variant):cli;
   copyRuntimeFiles(source,staging);copyLicenses(cli,staging);
   const triple=platform==='darwin'?(arch==='arm64'?'aarch64-apple-darwin':'x86_64-apple-darwin'):'x86_64-pc-windows-msvc';
   entry=`vendor/${triple}/bin/codex${platform==='win32'?'.exe':''}`;
  }else if(id==='claude'){
   const sdk=dependency(sdkSource,'@anthropic-ai/claude-agent-sdk');
   if(readJson(path.join(sdk,'package.json')).version!==version)throw new Error(`Claude SDK 与锁文件版本不符：${version}`);
   const source=dependency(sdk,`@anthropic-ai/claude-agent-sdk-${platform}-${arch}`);
   copyRuntimeFiles(source,staging);copyLicenses(sdk,staging);entry=platform==='win32'?'claude.exe':'claude';
  }else if(id==='dsh'){
   const source=dependency(sdkSource,'@deepseek-ai/dsh');
   if(readJson(path.join(source,'package.json')).version!==version)throw new Error(`DSH 与锁文件版本不符：${version}`);
   // Store the graph as plain files; the launcher creates validated internal links only.
   const state=new Map();state.platform=platform;state.arch=arch;state.deferLinks=true;
   const yaml=createRequire(path.join(root,'web/backend/package.json'))('yaml');
   state.packageExtensions=yaml.parse(fs.readFileSync(path.join(root,'web/pnpm-workspace.yaml'),'utf8')).packageExtensions??{};
   state.excludeDependency=(name,owner)=>name==='@deepseek-ai/dsh-skill-office'||(owner.name==='@deepseek-ai/dsh'&&(name==='@deepseek-ai/dsh-web-app'||name==='@deepseek-ai/dsh-acp-app'||name.startsWith('@deepseek-ai/dsh-client-ui-')));
   const collected=copyRuntimePackage(source,staging,state);
   state.links??=[];
   const hoisted=new Set();for(const [origin,target] of state){const name=readJson(path.join(origin,'package.json')).name;if(!hoisted.has(name)){hoisted.add(name);state.links.push({link:`node_modules/${name}`,target:path.relative(staging,target).split(path.sep).join('/')});}}
   state.links.push({link:'dsh',target:path.relative(staging,collected).split(path.sep).join('/')});
   writeRuntimeLinks(staging,state.links);
   fs.copyFileSync(path.join(root,'scripts/lib/desktop-runtime-links.mjs'),path.join(staging,'runtime-links.mjs'));
   fs.writeFileSync(path.join(staging,'entry.mjs'),`import { materializeRuntimeLinks } from './runtime-links.mjs';\nimport { fileURLToPath } from 'node:url';\nmaterializeRuntimeLinks(fileURLToPath(new URL('.',import.meta.url)));\nexport async function runCli(options){const cli=await import('./dsh/lib/bin.js');return cli.runCli(options); }\n`);
   entry='entry.mjs';kind='node';

  }else{
   entry=id+(platform==='win32'?'.exe':'');fs.copyFileSync(nativeToolSources({platform,arch})[id],path.join(staging,entry));
  }
  if(!fs.existsSync(path.join(staging,entry)))throw new Error(`组件入口不存在 ${id}: ${entry}`);
  if(kind==='executable')fs.chmodSync(path.join(staging,entry),0o755);
  const url=`${id}/${version}/${platform}-${arch}.tar.gz`;
  components.push({id,version,platform,arch,url,...await createComponentArchive(staging,path.join(output,url)),entry,kind});
 }
 const merged=[...previous.filter(old=>!components.some(item=>item.id===old.id&&item.version===old.version&&item.platform===old.platform&&item.arch===old.arch)),...components];
 const catalog=Buffer.from(JSON.stringify({schemaVersion:1,components:merged},null,2)+'\n');fs.mkdirSync(output,{recursive:true});
 const signature=sign(null,catalog,privateKey).toString('base64');
 fs.writeFileSync(path.join(output,'catalog.json'),catalog);fs.writeFileSync(path.join(output,'catalog.sig'),signature+'\n');
 fs.writeFileSync(path.join(output,'catalog.signed.json'),JSON.stringify({schemaVersion:1,catalog:catalog.toString('base64'),signature},null,2)+'\n');
 fs.writeFileSync(path.join(output,'runtime-release.json'),JSON.stringify({schemaVersion:1,platform:layout.platformKey,version:releaseVersion,relativeDirectory:layout.relativeDirectory},null,2)+'\n');
 fs.writeFileSync(path.join(output,'runtime-components.lock.json'),JSON.stringify(lock,null,2)+'\n');
 fs.writeFileSync(path.join(output,'trust-key.pem'),createPublicKey(privateKey).export({type:'spki',format:'pem'}));
 return {output,relativeDirectory:layout.relativeDirectory,releaseVersion,components};
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2);const value=name=>{const at=args.indexOf(name);return at<0?undefined:args[at+1];};
 packageRuntimeComponents({...(value('--version')?{releaseVersion:value('--version')}:{}),...(value('--output')?{output:path.resolve(value('--output'))}:{}),...(value('--components')?{ids:value('--components').split(',')}:{})}).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
