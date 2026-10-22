/** Build-time runtime collector. Links are relative and always remain inside the bundle. */
import { systemTar } from './desktop-platform-commands.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
export const DESKTOP_NODE_VERSION='24.22.0';
export function nodeArtifact(platform=process.platform,arch=process.arch){
 if(platform==='darwin'&&arch==='arm64')return {version:DESKTOP_NODE_VERSION,archive:`node-v${DESKTOP_NODE_VERSION}-darwin-arm64.tar.gz`,triple:'aarch64-apple-darwin'};
 if(platform==='win32'&&arch==='x64')return {version:DESKTOP_NODE_VERSION,archive:`node-v${DESKTOP_NODE_VERSION}-win-x64.zip`,triple:'x86_64-pc-windows-msvc'};
 throw new Error(`不支持的桌面平台：${platform}/${arch}`);
}
const excluded=name=>name==='node_modules'||name==='.git'||name.startsWith('.env')||name==='config.local.json'||name.includes('.secrets.')||/\.(sqlite|sqlite-shm|sqlite-wal)$/.test(name)||name.endsWith('.map')||name==='__tests__'||name==='coverage'||name==='target'||name==='.woohaa3';
export function copyRuntimeFiles(source,target){
 fs.mkdirSync(target,{recursive:true});
 for(const entry of fs.readdirSync(source,{withFileTypes:true})){
  if(excluded(entry.name))continue;const from=path.join(source,entry.name),to=path.join(target,entry.name);
  if(entry.isSymbolicLink()){
   // Some SDKs include internal executable aliases. Copy their resolved bytes, never workspace links.
   const resolved=fs.realpathSync(from);if(!resolved.startsWith(fs.realpathSync(source)+path.sep))throw new Error(`资源链接指向外部：${from}`);
   fs.cpSync(resolved,to,{recursive:true,dereference:true});
  }else if(entry.isDirectory())copyRuntimeFiles(from,to);
  else if(entry.isFile())fs.copyFileSync(from,to);
 }
}
function locateDependency(source,name){let dir=source;for(;;){const candidate=path.join(dir,'node_modules',name);if(fs.existsSync(path.join(candidate,'package.json')))return fs.realpathSync(candidate);const parent=path.dirname(dir);if(parent===dir)return null;dir=parent;}}
export function linkRuntimePackage(source,target,bundleRoot,state){if(state?.platform==='win32'){state.links??=[];state.links.push({link:path.relative(bundleRoot,target).split(path.sep).join('/'),target:path.relative(bundleRoot,source).split(path.sep).join('/')});return;}linkPackage(source,target);}
function linkPackage(source,target){fs.mkdirSync(path.dirname(target),{recursive:true});if(!fs.existsSync(target))fs.symlinkSync(path.relative(path.dirname(target),source),target,'dir');}
function supportsTarget(values,value){if(!values)return true;const allowed=values.filter(item=>!item.startsWith('!'));return !values.includes('!'+value)&&(!allowed.length||allowed.includes(value));}
export function copyRuntimePackage(source,bundleRoot,state=new Map()){
 source=fs.realpathSync(source);if(state.has(source))return state.get(source);
 const pkg=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
 const id=createHash('sha256').update(source).digest('hex').slice(0,16);
 const target=path.join(bundleRoot,'packages',`${pkg.name.replace(/[^a-zA-Z0-9_-]/g,'_')}-${id}`);
 state.set(source,target);copyRuntimeFiles(source,target);
 const extension=state.packageExtensions?.[`${pkg.name}@${pkg.version}`]??state.packageExtensions?.[pkg.name]??{};
 const dependencies={...pkg.peerDependencies,...extension.peerDependencies,...pkg.optionalDependencies,...extension.optionalDependencies,...pkg.dependencies,...extension.dependencies};
 for(const name of Object.keys(dependencies??{})){
  const dep=locateDependency(source,name);
  if(!dep){if(Object.hasOwn(pkg.optionalDependencies??{},name)||Object.hasOwn(pkg.peerDependencies??{},name))continue;throw new Error(`缺少生产依赖 ${pkg.name} → ${name}`);}
  const meta=JSON.parse(fs.readFileSync(path.join(dep,'package.json'),'utf8'));
  if(!supportsTarget(meta.os,state.platform??process.platform))continue;
  if(!supportsTarget(meta.cpu,state.arch??process.arch))continue;
  linkRuntimePackage(copyRuntimePackage(dep,bundleRoot,state),path.join(target,'node_modules',name),bundleRoot,state);
 }
 return target;
}
export function attachRuntimePackage(source,target,bundleRoot,state){const collected=copyRuntimePackage(source,bundleRoot,state);linkRuntimePackage(collected,target,bundleRoot,state);return collected;}
export function assertPortableTree(root){root=fs.realpathSync(root);const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
 const file=path.join(dir,entry.name);if(entry.isSymbolicLink()){const real=fs.realpathSync(file);if(!real.startsWith(root+path.sep)&&real!==root)throw new Error(`产物链接指向外部：${file}`);}else if(entry.isDirectory())walk(file);
 }};walk(root);}
export function standaloneBundleConfig({resourceRoot,node,endpoint=null,publicKey=null,platform=process.platform}) {
 if(Boolean(endpoint)!==Boolean(publicKey))throw new Error('更新 CDN endpoint 与公钥必须一起配置');
 if(endpoint&&new URL(endpoint).protocol!=='https:')throw new Error('更新 CDN 必须为 HTTPS');
 return {plugins:{updater:{pubkey:publicKey??''}},bundle:{externalBin:[node.replace(/-(?:aarch64-apple-darwin|x86_64-pc-windows-msvc)(?:\.exe)?$/,'')],resources:{},createUpdaterArtifacts:Boolean(endpoint),...(platform==='win32'?{icon:['icons/icon.ico'],windows:{nsis:{installMode:'currentUser'},webviewInstallMode:{type:'downloadBootstrapper',silent:true}}}:{})}};
}

export function createHostArchive(resourceRoot,output) {
 assertPortableTree(resourceRoot);fs.mkdirSync(path.dirname(output),{recursive:true});
 execFileSync(systemTar(),['-czf',output,...(process.platform==='darwin'?['--options','gzip:compression-level=1']:[]),'-C',resourceRoot,'.'],{env:{...process.env,COPYFILE_DISABLE:'1'},stdio:'inherit',windowsHide:true});
 return {path:output,sha256:createHash('sha256').update(fs.readFileSync(output)).digest('hex')};
}
