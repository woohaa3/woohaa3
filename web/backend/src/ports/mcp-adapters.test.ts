import { expect, it, vi } from 'vitest';
import type { ModelMcpService } from '@woohaa3/canvas-service';
import { modelMcpServiceToClient } from './mcp-adapters.js';
it('forwards the selected animation clip and sampled time to the authoritative renderer', async () => {
  const renderPreview = vi.fn().mockResolvedValue({ok:false,code:'renderer-unavailable',message:'fixture'});
  const client = modelMcpServiceToClient({renderPreview} as unknown as ModelMcpService);
  await client.renderPreview({canvasId:'canvas',nodeId:'film',clipId:'parkour',timeSeconds:8,width:960,height:540});
  expect(renderPreview).toHaveBeenCalledWith({canvasId:'canvas',nodeId:'film',clipId:'parkour',timeSeconds:8,width:960,height:540});
});
it('批量模型能力在进程内直连权威服务，并用内部 actor 作为 principal', async () => {
  const getModelNodes = vi.fn().mockResolvedValue({ok:true,canvasId:'canvas',revision:1,nodes:[]});
  const validateScripts = vi.fn().mockResolvedValue({ok:true,canvasId:'canvas',requestId:'b1',commandId:'cmd',revision:1,duplicate:false,noop:false,validatedOnly:true,nodes:[]});
  const submitScripts = vi.fn().mockResolvedValue({ok:true,canvasId:'canvas',requestId:'b1',commandId:'cmd',revision:1,duplicate:false,noop:false,validatedOnly:false,nodes:[]});
  const client = modelMcpServiceToClient({getModelNodes,validateScripts,submitScripts} as unknown as ModelMcpService);
  const batch = {canvasId:'canvas',requestId:'b1',items:[{nodeId:'m1',source:'export default {}'}]};
  expect(await client.getModelNodes?.({canvasId:'canvas',nodeIds:['m1']})).toMatchObject({ok:true,revision:1});
  expect(await client.validateScripts?.(batch)).toMatchObject({validatedOnly:true});
  expect(await client.submitScripts?.(batch)).toMatchObject({commandId:'cmd'});
  expect(getModelNodes).toHaveBeenCalledWith({canvasId:'canvas',nodeIds:['m1']});
  expect(validateScripts).toHaveBeenCalledWith(batch,{principalId:'wolf-woohaa3-mcp-internal-actor'});
  expect(submitScripts).toHaveBeenCalledWith(batch,{principalId:'wolf-woohaa3-mcp-internal-actor'});
});
it('批量模型能力在权威服务缺失时 fail closed', async () => {
  const client = modelMcpServiceToClient(null);
  expect(await client.getModelNodes?.({canvasId:'canvas',nodeIds:['m1']})).toMatchObject({ok:false,code:'unavailable'});
  expect(await client.submitScripts?.({canvasId:'canvas',requestId:'b1',items:[{nodeId:'m1',source:'x'}]})).toMatchObject({ok:false,code:'unavailable'});
});
it('模型统计透传 source/includeStatistics（change: 2026-10-18-align-model-statistics-with-agent）', async () => {
  const getModelNode = vi.fn().mockResolvedValue({ok:true,canvasId:'canvas',nodeId:'m1',title:'',prompt:'',source:'',references:[],cameras:[]});
  const getModelStatistics = vi.fn().mockResolvedValue({ok:true,canvasId:'canvas',nodeId:'m1',source:'candidate',statistics:{objects:1,groups:0,vertices:8,triangles:12,materials:0,animations:0},breakdown:{}});
  const client = modelMcpServiceToClient({getModelNode,getModelStatistics} as unknown as ModelMcpService);
  await client.getModelNode({canvasId:'canvas',nodeId:'m1',includeStatistics:true});
  expect(getModelNode).toHaveBeenCalledWith({canvasId:'canvas',nodeId:'m1',includeStatistics:true});
  await client.getModelStatistics({canvasId:'canvas',nodeId:'m1',source:'scene.box({ id: "b" });'});
  expect(getModelStatistics).toHaveBeenCalledWith({canvasId:'canvas',nodeId:'m1',source:'scene.box({ id: "b" });'});
  await client.getModelStatistics({canvasId:'canvas',nodeId:'m1'});
  expect(getModelStatistics).toHaveBeenLastCalledWith({canvasId:'canvas',nodeId:'m1'});
});
