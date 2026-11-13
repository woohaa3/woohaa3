import {describe,it,expect} from 'vitest';
import {createPptaskProvider,createMemoryJobRepository} from '../src/index.ts';
describe('motion model jobs',()=>{
 it('persists a motion operation and resumes without image coercion or resubmission',async()=>{
  const store=createMemoryJobRepository();let starts=0;
  const media={storageKey:`generation-outputs/${'a'.repeat(64)}.npz`,contentType:'application/x-npz',size:620066};
  const build=()=>createPptaskProvider({providerId:'motion-test',jobRepository:store,pollIntervalMs:1,motionModel:()=>({doStart:async()=>{starts++;return {operation:{taskId:'remote'}};},doStatus:async()=>({status:'completed',media})})});
  const first=build();const handle=await first.jobs.start({model:first.motionModel('kimodo'),input:{prompt:'backflip'}});
  const second=build();const restored=await second.jobs.resume<{media:typeof media}>(handle.id);
  expect((await restored.wait()).media).toEqual(media);expect(starts).toBe(1);
  expect((await restored.status()).modelType).toBe('motion');
 });
});
