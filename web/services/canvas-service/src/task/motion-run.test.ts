import {it,expect,vi} from 'vitest';
import {createEmptyWoohaa3ServerCanvas} from '@woohaa3/contracts';
import {YJS_SYNC_PROTOCOL_VERSION} from '@woohaa3/contracts/canvas-yjs';
import {CanvasRoom,InMemoryYjsDocumentRepository} from '../sync/index.js';
import {CanvasRunService} from './run-service.js';
it('submits a canonical motion node as motion to Task with durable begin',async()=>{
 const room=new CanvasRoom({canvasId:'c',repository:new InMemoryYjsDocumentRepository()});
 await room.initialize({canvas:createEmptyWoohaa3ServerCanvas('c'),roomEpoch:'epoch',createdAt:new Date().toISOString()});
 const added=await room.submit({protocolVersion:YJS_SYNC_PROTOCOL_VERSION,canvasId:'c',commandId:'seed',baseRevision:0,actorId:'test',commands:[{type:'node.add',node:{id:'motion',type:'motion',position:{x:0,y:0}},nodeData:{taskKind:'motion-generation'}}]});expect(added.ok).toBe(true);
 const submit=vi.fn(async()=>({reused:false}));
 const service=new CanvasRunService({resolveRoom:async()=>room,taskClient:{submit,cancel:async()=>{}} as never,resolveCatalog:async()=>({available:true,models:[{modelKey:'remote-server:kimodo',providerId:'remote-server',providerModelId:'kimodo',modelType:'motion',title:'Kimodo',interaction:{id:'generic-model',version:1},inputSchema:{},defaultInput:{},bindings:[],taskTimeoutMs:60000}],defaultModels:{}})});
 const result=await service.run({canvasId:'c',nodeId:'motion',runId:'run',jobId:'job',modelKey:'remote-server:kimodo',prompt:'Backflip',parameters:{}});
 expect(result.ok).toBe(true);expect(submit).toHaveBeenCalledWith(expect.objectContaining({nodeType:'motion',modelType:'motion'}));
});
