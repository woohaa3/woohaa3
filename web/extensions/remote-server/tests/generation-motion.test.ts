import {describe,it,expect} from 'vitest';
import {normalizeRemoteModelType,decodeTask} from '../src/backend/generation/protocol.js';
import {createRemoteGenerationProvider} from '../src/backend/generation/provider.js';

describe('remote motion generation',()=>{
 it('accepts explicit motion models and preserves NPZ motion identity',()=>{
  expect(normalizeRemoteModelType('motion')).toBe('motion');
  const task=decodeTask({taskId:'t',state:'succeeded',media:{storageKey:`generation-outputs/${'a'.repeat(64)}.npz`,contentType:'application/x-npz',size:12,checksum:'b'.repeat(64),motion:{fps:30,frameCount:90,skeletonId:'somaskel77',restPoseId:'kimodo-standard-tpose',formatVersion:'kimodo-soma-v1'}}});
  expect(task.media?.media.motion).toMatchObject({fps:30,frameCount:90,skeletonId:'somaskel77'});
 });
 it('offers a dedicated motion model without using image/video adapters',async()=>{
  const calls:string[]=[];
  const provider=createRemoteGenerationProvider({modelFor:()=>undefined,admissionFor:()=>undefined,session:async()=>({serverUrl:'http://localhost:8792',token:'dev'}),client:{submitTask:async(_session:unknown,body:{modelType:string})=>{calls.push(body.modelType);return {ok:true,value:{taskId:'t',state:'queued'}};}} as never});
  expect(typeof provider.motionModel).toBe('function');
  const model=provider.motionModel('kimodo');
  await model.doStart!({__remoteServerGeneration:1,idempotencyKey:'op',canvasId:'c',modelKey:'kimodo',modelType:'motion',prompt:'Backflip',parameters:{},inputs:[]} as never);
  expect(calls).toEqual(['motion']);
 });
});
