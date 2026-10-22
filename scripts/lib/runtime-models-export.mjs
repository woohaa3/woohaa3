/** Read the host's public model management snapshot. No login tokens or requests to providers. */
import {resolveAppBasePath} from './app-base-path.mjs';
const fields=['modelKey','providerId','extensionId','modelType','title','enabled','isDefault','order','taskTimeoutMs','interaction','tombstone'];
export function portableRuntimeModels(models){
 if(!Array.isArray(models))throw new Error('模型目录格式无效');
 const seen=new Set();
 return models.map(model=>{
  if(!model||typeof model.providerId!=='string'||!model.providerId||typeof model.modelKey!=='string'||!model.modelKey.startsWith(model.providerId+':')||seen.has(model.modelKey)||!['language','image','video','audio'].includes(model.modelType)||typeof model.enabled!=='boolean'||typeof model.isDefault!=='boolean')throw new Error('模型目录条目无效');
  seen.add(model.modelKey);
  const value=Object.fromEntries(fields.filter(key=>model[key]!==undefined).map(key=>[key,model[key]]));
  if(value.interaction!==undefined){if(!value.interaction||typeof value.interaction.id!=='string'||!Number.isInteger(value.interaction.version))throw new Error('模型交互配置无效');value.interaction={id:value.interaction.id,version:value.interaction.version};}
  if(value.extensionId!==undefined&&typeof value.extensionId!=='string'||value.title!==undefined&&typeof value.title!=='string')throw new Error('模型目录字段无效');
  for(const key of ['order','taskTimeoutMs'])if(value[key]!==undefined&&(!Number.isInteger(value[key])||value[key]<0))throw new Error('模型目录数值无效');
  if(value.tombstone!==undefined&&typeof value.tombstone!=='boolean')throw new Error('模型目录删除标记无效');
  return {...value,executable:false};
 });
}
export async function readRuntimeModels({env=process.env,origin,fetchImpl=globalThis.fetch}={}){
 const base=origin??`http://127.0.0.1:${env.BACKEND_PORT??env.PORT??5180}${resolveAppBasePath(env)}`;
 const url=new URL(base.endsWith('/')?base:base+'/');
 if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash)throw new Error('模型导出来源必须是本机 loopback 宿主地址');
 const endpoint=new URL('api/generation-models',url);
 try{
  const response=await fetchImpl(endpoint,{signal:AbortSignal.timeout(5000),redirect:'error'});
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  const snapshot=await response.json();if(!Number.isInteger(snapshot.revision)||typeof snapshot.initialized!=='boolean')throw new Error('宿主模型快照无效');
  return {origin:url.href,models:portableRuntimeModels(snapshot.models)};
 }catch{throw new Error(`无法读取开发宿主模型目录 ${endpoint}。请先启动 pnpm dev；自定义端口使用 --from http://127.0.0.1:端口/。未生成不完整的配置包。`);}
}
