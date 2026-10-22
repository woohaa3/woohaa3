import {it,expect} from 'vitest';
import {mergeRuntimeModelViews} from './runtime-model-catalog.js';
import type {GenerationModelPolicyView} from '@woohaa3/contracts';
const cached:GenerationModelPolicyView={modelKey:'litellm:team',providerId:'litellm',extensionId:'litellm-provider',modelType:'image',title:'团队模型',enabled:true,isDefault:true,executable:false};
it('restores discovered metadata for missing models without granting execution',()=>{
 expect(mergeRuntimeModelViews([], [cached], [], {initialized:false,models:[]})).toEqual([cached]);
 expect(mergeRuntimeModelViews([], [{...cached,executable:true}], [], {initialized:true,models:[{modelKey:cached.modelKey,enabled:false}]})).toEqual([expect.objectContaining({enabled:false,isDefault:false,executable:false})]);
});
it('uses the fresh provider catalog and does not revive removed models',()=>{
 const live={...cached,title:'新标题',executable:true};
 expect(mergeRuntimeModelViews([live],[cached],[{providerId:'litellm',models:[{}]}],{initialized:false,models:[]})).toEqual([live]);
 expect(mergeRuntimeModelViews([], [cached],[{providerId:'litellm',models:[{}]}],{initialized:false,models:[]})).toEqual([]);
});
it('fills policy-only placeholders with correct types and extension ownership',()=>{
 const placeholder={...cached,modelType:'language' as const,extensionId:undefined,executable:false};
 expect(mergeRuntimeModelViews([placeholder],[cached],[],{initialized:false,models:[]})).toEqual([expect.objectContaining({modelType:'image',extensionId:'litellm-provider',executable:false})]);
});

it('loads only public catalog fields and never restores executable authority from disk',async()=>{
 const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');
 const {readRuntimeModelViews}=await import('./runtime-model-catalog.js');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'woohaa-imported-models-'));
 try{
 const file=path.join(directory,'runtime-models.json');fs.writeFileSync(file,JSON.stringify([{...cached,executable:true,apiKey:'not-public'}]));
 const models=readRuntimeModelViews(file);expect(models[0].executable).toBe(false);expect(JSON.stringify(models)).not.toContain('not-public');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

it('a successfully refreshed empty catalog removes the old snapshot, while failed discovery retains display metadata',()=>{
 expect(mergeRuntimeModelViews([], [cached], [{providerId:'litellm',models:[],available:true,catalogRevision:1}], {initialized:false,models:[]})).toEqual([]);
 expect(mergeRuntimeModelViews([], [cached], [{providerId:'litellm',models:[],available:true}], {initialized:false,models:[]})).toEqual([cached]);
 expect(mergeRuntimeModelViews([], [{...cached,enabled:false}], [], {initialized:false,models:[]})[0].enabled).toBe(false);
});
