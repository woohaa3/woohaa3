import {it,expect} from 'vitest';
import {createEmptyWoohaa3ServerCanvas,type TaskExecutionDetail} from '@woohaa3/contracts';
import {toExecutionRecord} from './result-consumer.js';
import {buildProjectionCommands} from '../sync/task-projector.js';
it('projects stable NPZ as motion and retains animation metadata across reopen',()=>{
 const motion={fps:30,frameCount:90,skeletonId:'somaskel77',restPoseId:'kimodo-standard-tpose',formatVersion:'kimodo-soma-v1'} as const;
 const item={taskKey:'t',state:'succeeded',providerId:'remote-server',modelType:'motion',result:{mediaKind:'motion',storageKey:`generation-outputs/${'a'.repeat(64)}.npz`,checksum:'a'.repeat(64),contentType:'application/x-npz',size:24,motion},canvasId:'c',nodeId:'m',runId:'r',createdAt:'2026-11-12T00:00:00Z',updatedAt:'2026-11-12T00:00:01Z',finishedAt:'2026-11-12T00:00:01Z',recordRevision:1,durationMs:1000,events:[]} as TaskExecutionDetail;
 const record=toExecutionRecord(item)!;
 expect(record.output?.asset?.metadata).toMatchObject({motion});
 const canvas=createEmptyWoohaa3ServerCanvas("c");canvas.document.nodes.push({id:'m',type:'motion',position:{x:0,y:0},size:{width:260,height:195}} as never);canvas.nodeData.m={activeRunId:'r'};
 const result=buildProjectionCommands({record,currentCanvas:canvas});
 expect(result.ok).toBe(true);if(!result.ok)return;
 expect(result.commands).toContainEqual(expect.objectContaining({type:'nodeData.patch',value:expect.objectContaining({outputAssetId:'asset-r',resourceKind:'motion',taskStatus:'successed'})}));
});
