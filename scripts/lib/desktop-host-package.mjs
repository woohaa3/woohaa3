/** Build-time runtime collector. Links are relative and always remain inside the bundle. */
import {systemTarExec} from './desktop-platform-commands.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
export const DESKTOP_NODE_VERSION='24.22.0';
export function nodeArtifact(platform=process.platform,arch=process.arch){
 if(platform==='darwin'&&arch==='arm64')return {version:DESKTOP_NODE_VERSION,archive:`node-v${DESKTOP_NODE_VERSION}-darwin-arm64.tar.gz`,triple:'aarch64-apple-darwin'};
 if(platform==='win32'&&arch==='x64')return {version:DESKTOP_NODE_VERSION,archive:`node-v${DESKTOP_NODE_VERSION}-win-x64.zip`,triple:'x86_64-pc-windows-msvc'};
 throw new Error(`不支持的桌面平台：${platform}/${arch}`);
}
const excluded=name=>name==='node_modules'||name==='.git'||name.startsWith('.env')||name==='config.local.json'||name.includes('.secrets.')||/\.(sqlite|sqlite-shm|sqlite-wal)$/.test(name)||name.endsWith('.map')||/\.d\.(?:ts|mts|cts)$/.test(name)||name==='__tests__'||name==='coverage'||name==='target'||name==='.woohaa3';
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
export function locateDependency(source,name){let dir=source;for(;;){const candidate=path.join(dir,'node_modules',name);if(fs.existsSync(path.join(candidate,'package.json')))return fs.realpathSync(candidate);const parent=path.dirname(dir);if(parent===dir)return null;dir=parent;}}
export function linkRuntimePackage(source,target,bundleRoot,state){if((state?.platform==='win32'||state?.deferLinks)){state.links??=[];state.links.push({link:path.relative(bundleRoot,target).split(path.sep).join('/'),target:path.relative(bundleRoot,source).split(path.sep).join('/')});return;}linkPackage(source,target);}
function linkPackage(source,target){fs.mkdirSync(path.dirname(target),{recursive:true});if(!fs.existsSync(target))fs.symlinkSync(path.relative(fs.realpathSync(path.dirname(target)),fs.realpathSync(source)),target,'dir');}
function supportsTarget(values,value){if(!values)return true;const allowed=values.filter(item=>!item.startsWith('!'));return !values.includes('!'+value)&&(!allowed.length||allowed.includes(value));}
export function copyRuntimePackage(source,bundleRoot,state=new Map()){
 source=fs.realpathSync(source);if(state.has(source))return state.get(source);
 const pkg=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
 const id=createHash('sha256').update(source).digest('hex').slice(0,16);
 const target=path.join(bundleRoot,'packages',`${pkg.name.replace(/[^a-zA-Z0-9_-]/g,'_')}-${id}`);
 state.set(source,target);copyRuntimeFiles(source,target);
 // Workspace packages execute compiled dist entrypoints; source maps/types and duplicated
 // browser builds are not needed by the Node host. Keep explicit resource directories.
 if(state.runtimeOnly&&pkg.name?.startsWith('@woohaa3/')){
  for(const name of ['src','server-dist','.local','test','tests'])fs.rmSync(path.join(target,name),{recursive:true,force:true});
 }

 const extension=state.packageExtensions?.[`${pkg.name}@${pkg.version}`]??state.packageExtensions?.[pkg.name]??{};
 const dependencies={...pkg.peerDependencies,...extension.peerDependencies,...pkg.optionalDependencies,...extension.optionalDependencies,...pkg.dependencies,...extension.dependencies};
 for(const name of Object.keys(dependencies??{})){
  if(state.excludeDependency?.(name,pkg))continue;
  const dep=locateDependency(source,name);
  if(!dep){if(Object.hasOwn(pkg.optionalDependencies??{},name)||Object.hasOwn(pkg.peerDependencies??{},name))continue;throw new Error(`缺少生产依赖 ${pkg.name} → ${name}`);}
  const meta=JSON.parse(fs.readFileSync(path.join(dep,'package.json'),'utf8'));
  if(!supportsTarget(meta.os,state.platform??process.platform))continue;
  if(!supportsTarget(meta.cpu,state.arch??process.arch))continue;
  linkRuntimePackage(copyRuntimePackage(dep,bundleRoot,state),path.join(target,'node_modules',name),bundleRoot,state);
 }
 return target;
}
export const isExternalDesktopDependency=name=>name==='@openai/codex'||name.startsWith('@anthropic-ai/claude-agent-sdk-')||name==='@deepseek-ai/dsh'||name==='@woohaa3/frontend';
export function attachRuntimePackage(source,target,bundleRoot,state){const collected=copyRuntimePackage(source,bundleRoot,state);linkRuntimePackage(collected,target,bundleRoot,state);return collected;}
export function assertPortableTree(root){root=fs.realpathSync(root);const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
 const file=path.join(dir,entry.name);if(entry.isSymbolicLink()){const real=fs.realpathSync(file);if(!real.startsWith(root+path.sep)&&real!==root)throw new Error(`产物链接指向外部：${file}`);}else if(entry.isDirectory())walk(file);
 }};walk(root);}
export function standaloneBundleConfig({resourceRoot,node,endpoint=null,publicKey=null,github=null,platform=process.platform}) {
 if(endpoint&&github)throw new Error('更新通道只能二选一：endpoint 或 GitHub Release');
 const updater=Boolean(endpoint||github);
 if(updater!==Boolean(publicKey))throw new Error('更新通道（endpoint 或 GitHub Release）与公钥必须一起配置');
 if(endpoint&&new URL(endpoint).protocol!=='https:')throw new Error('更新 CDN 必须为 HTTPS');
 if(github&&!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(github.repo??'')))throw new Error('GitHub 更新通道必须提供 owner/name 仓库');
 return {plugins:{updater:{pubkey:publicKey??''}},bundle:{externalBin:[node.replace(/-(?:aarch64-apple-darwin|x86_64-pc-windows-msvc)(?:\.exe)?$/,'')],resources:{},createUpdaterArtifacts:updater,...(platform==='win32'?{icon:['icons/icon.ico'],windows:{nsis:{installMode:'currentUser'},webviewInstallMode:{type:'downloadBootstrapper',silent:true}}}:{})}};
}

const TAR_BLOCK=512;
/** ustar 头；名字过长时按 prefix/name 拆分（Windows 宿主目录层级很深）。 */
function tarHeader({name,prefix,mode,size,mtime,type}){
 const header=Buffer.alloc(TAR_BLOCK,0);
 header.write(name,0,100,'utf8');
 header.write(mode.toString(8).padStart(7,'0')+'\0',100,'ascii');
 header.write('0000000\0',108,'ascii');
 header.write('0000000\0',116,'ascii');
 header.write(size.toString(8).padStart(11,'0')+'\0',124,'ascii');
 header.write(Math.floor(mtime).toString(8).padStart(11,'0')+'\0',136,'ascii');
 header.write('        ',148,'ascii');
 header.write(type,156,'ascii');
 header.write('ustar\0',257,'ascii');
 header.write('00',263,'ascii');
 header.write(prefix,345,155,'utf8');
 let sum=0;for(const byte of header)sum+=byte;
 header.write(sum.toString(8).padStart(6,'0')+'\0 ',148,'ascii');
 return header;
}
function splitTarName(name){
 if(Buffer.byteLength(name,'utf8')<=100)return {name,prefix:''};
 for(let index=name.length-1;index>0;index-=1){
  if(name[index]!=='/')continue;
  const prefix=name.slice(0,index),rest=name.slice(index+1);
  if(Buffer.byteLength(prefix,'utf8')<=155&&Buffer.byteLength(rest,'utf8')<=100)return {name:rest,prefix};
 }
 return {name,prefix:''};
}
/**
 * 在 Node 内直接生成 tar.gz。
 *
 * Windows 上没有可靠的 bsdtar（Server 2016/2012 完全没有），而混用 MSYS2 tar 与
 * Git 的 gzip 会因 cygwin 运行时不同直接崩溃；自己写 ustar 再交给 zlib，不依赖
 * 任何外部压缩进程。
 */
export function createHostArchiveInNode(resourceRoot,output){
 const chunks=[];
 const visit=(dir,relative)=>{
  const entries=fs.readdirSync(dir,{withFileTypes:true}).sort((left,right)=>(left.name<right.name?-1:left.name>right.name?1:0));
  for(const entry of entries){
   const full=path.join(dir,entry.name);const name=relative?relative+'/'+entry.name:entry.name;
   const stat=fs.statSync(full);
   if(stat.isDirectory()){
    const split=splitTarName(name+'/');
    chunks.push(tarHeader({...split,mode:0o755,size:0,mtime:stat.mtimeMs/1000,type:'5'}));
    visit(full,name);
   }else{
    const data=fs.readFileSync(full);const split=splitTarName(name);
    chunks.push(tarHeader({...split,mode:0o644,size:data.length,mtime:stat.mtimeMs/1000,type:'0'}));
    chunks.push(data);
    const pad=(TAR_BLOCK-(data.length%TAR_BLOCK))%TAR_BLOCK;
    if(pad>0)chunks.push(Buffer.alloc(pad,0));
   }
  }
 };
 visit(resourceRoot,'');
 chunks.push(Buffer.alloc(TAR_BLOCK*2,0));
 fs.writeFileSync(output,zlib.gzipSync(Buffer.concat(chunks)));
}

export function createHostArchive(resourceRoot,output) {
 assertPortableTree(resourceRoot);fs.mkdirSync(path.dirname(output),{recursive:true});
 if(process.platform==='win32'){createHostArchiveInNode(resourceRoot,output);}
 else systemTarExec(['-czf',output,...(process.platform==='darwin'?['--options','gzip:compression-level=1']:[]),'-C',resourceRoot,'.'],{env:{...process.env,COPYFILE_DISABLE:'1'},stdio:'inherit',windowsHide:true});
 return {path:output,sha256:createHash('sha256').update(fs.readFileSync(output)).digest('hex')};
}

/** The host serves the real UI over loopback; embed only the independent startup page. */
export function prepareStartupFrontend(frontend,output){
 const source=path.join(frontend,'desktop-startup.html');
 if(!fs.existsSync(source))throw new Error(`桌面启动页面缺失：${source}`);
 const html=fs.readFileSync(source,'utf8');
 if(/<(?:script|link|img)\b[^>]*(?:src|href)\s*=/i.test(html))throw new Error('桌面启动页面必须自包含，不能引用外部资源');
 fs.rmSync(output,{recursive:true,force:true});fs.mkdirSync(output,{recursive:true});
 fs.writeFileSync(path.join(output,'desktop-startup.html'),html);fs.writeFileSync(path.join(output,'index.html'),html);
 return path.resolve(output);
}
