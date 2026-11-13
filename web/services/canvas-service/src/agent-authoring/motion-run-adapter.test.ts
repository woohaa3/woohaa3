import {it,expect,vi} from 'vitest';
import {createEmptyWoohaa3ServerCanvas,type CanvasTaskCatalog} from '@woohaa3/contracts';
import {AgentRunAdapter,projectOutputView} from './run-adapter.js';
import type {CanvasRoom} from '../sync/index.js';
it('lets AI choose the default motion model and read a completed NPZ output',async()=>{
 const canvas=createEmptyWoohaa3ServerCanvas('c');canvas.document.nodes.push({id:'m',type:'motion',position:{x:0,y:0}});canvas.nodeData.m={};
 const run=vi.fn(async(_request:unknown)=>({ok:true as const,runId:'r',jobId:'j',workerTaskKey:'r',state:'accepted' as const}));
 const catalog={available:true,models:[{modelKey:'remote-server:kimodo',modelType:'motion'}],defaultModels:{motion:'remote-server:kimodo'}} as CanvasTaskCatalog;
 const adapter=new AgentRunAdapter({resolveRoom:async()=>({exportCanvas:()=>({ok:true,canvas})} as unknown as CanvasRoom),runService:{run,cancel:async()=>({ok:false,code:'unused',message:'unused'})},resolveCatalog:async()=>catalog});
 expect(await adapter.run({canvasId:'c',nodeId:'m',requestId:'request'})).toMatchObject({ok:true});
 expect(run.mock.calls[0]?.[0]).toMatchObject({modelKey:'remote-server:kimodo'});
 const motion={fps:30,frameCount:90,skeletonId:'somaskel77',restPoseId:'kimodo-standard-tpose',formatVersion:'kimodo-soma-v1'};
 canvas.nodeData.m={activeRunId:'r',taskStatus:'successed',outputAssetId:'asset-r'};canvas.assets.push({id:'asset-r',title:'Motion',mediaKind:'motion',source:'generated',status:'ready',createdAt:new Date().toISOString(),metadata:{storageKey:`generation-outputs/${'a'.repeat(64)}.npz`,checksum:'a'.repeat(64),contentType:'application/x-npz',size:12,motion}});
 expect(projectOutputView(canvas,'c','m','r')).toMatchObject({available:true,output:{kind:'motion',fps:30,motion}});
});
