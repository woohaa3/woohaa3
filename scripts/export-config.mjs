#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {collectDevelopmentConfig} from './lib/development-config.mjs';
import {loadServiceEnv} from './lib/service-env.mjs';
import {readRuntimeModels} from './lib/runtime-models-export.mjs';
import {exportConfigPackage} from './lib/config-handoff.mjs';
const args=process.argv.slice(2).filter(arg=>arg!=='--');
const root=fileURLToPath(new URL('../',import.meta.url));
try{
 if(args.includes('--help'))console.log('pnpm config:export --out <team.woohaa> [--from http://127.0.0.1:5180/]\n先启动 pnpm dev；导出包含该宿主发现的完整模型目录。\n导出开发配置和共享 API 凭证，不含个人登录、画布、任务或媒体；文件不加密。');
 else{
  if(![2,4].includes(args.length)||args[0]!=='--out'||!args[1]||(args.length===4&&(args[2]!=='--from'||!args[3])))throw new Error('用法：pnpm config:export --out <team.woohaa> [--from http://127.0.0.1:5180/]');
  const env=loadServiceEnv(root,process.env.WOOHAA3_SERVICE_ENV_FILE);
  const runtime=await readRuntimeModels({env,origin:args[3]});
  const {payload,omitted,unknownKeys}=await collectDevelopmentConfig({root,env});
  payload.runtimeModels=runtime.models;
  const output=path.resolve(args[1]);const result=exportConfigPackage({output,payload});
  console.log(JSON.stringify({output,...result,modelSource:runtime.origin,modelCount:runtime.models.length,modelsByProvider:Object.fromEntries([...new Set(runtime.models.map(model=>model.providerId))].map(id=>[id,runtime.models.filter(model=>model.providerId===id).length])),omitted,unknownKeys},null,2));
  console.log('配置包包含共享凭证且未加密。个人登录、画布、任务、媒体未导出。');
  if(unknownKeys.length)console.log('未知配置项未导出；请核对上述 unknownKeys。');
 }
}catch(error){console.error(`配置导出失败：${error.code==='ERR_MODULE_NOT_FOUND'?'缺少构建产物，请先执行 pnpm services:build。':error.message}`);process.exitCode=1;}
