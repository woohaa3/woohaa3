import { expect, it, vi } from 'vitest';
import type { ModelMcpService, AgentCanvasInternalService } from '@woohaa3/canvas-service';
import { modelMcpServiceToClient, agentCanvasServiceToClient } from './mcp-adapters.js';
import { withMcpPrincipal } from './mcp-principal.js';
it('forwards the selected animation clip and sampled time to the authoritative renderer', async () => {
  const renderPreview = vi.fn().mockResolvedValue({ok:false,code:'renderer-unavailable',message:'fixture'});
  const client = modelMcpServiceToClient({renderPreview} as unknown as ModelMcpService);
  await client.renderPreview({canvasId:'canvas',nodeId:'model',clipId:'clip',timeSeconds:8,width:960,height:540});
  expect(renderPreview).toHaveBeenCalledWith({canvasId:'canvas',nodeId:'model',clipId:'clip',timeSeconds:8,width:960,height:540});
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

it('Agent Canvas 读写用本轮 grant 的可信主体，而不是静态缺省', async () => {
  const readGraph = vi.fn().mockResolvedValue({ ok: true, graph: { canvasId: 'c', revision: 1, nodes: [], edges: [] } });
  const apply = vi.fn().mockResolvedValue({ ok: true, canvasId: 'c', requestId: 'r', revision: 2, duplicate: false, noop: false, nodes: [], edges: [] });
  const client = agentCanvasServiceToClient({ readGraph, apply } as unknown as AgentCanvasInternalService, { principalId: 'dev-admin' });
  await withMcpPrincipal('user-a', async () => {
    await client.getGraph({ canvasId: 'c' });
    await client.applyPlan({ requestId: 'r', commandId: 'cmd', payloadHash: 'h', baseRevision: 1, commands: [] });
  });
  expect(readGraph).toHaveBeenCalledWith(expect.objectContaining({ principalId: 'user-a', canvasId: 'c' }));
  expect(apply).toHaveBeenCalledWith(expect.objectContaining({ principalId: 'user-a' }));
});

it('Agent Canvas 脚本面同样绑定本轮 grant 主体', async () => {
  const validateScript = vi.fn().mockResolvedValue({ ok: true, receipt: {} });
  const submitScript = vi.fn().mockResolvedValue({ ok: true, receipt: {} });
  const scriptCapability = vi.fn().mockResolvedValue({ ok: true, available: false, reason: 'x' });
  const client = agentCanvasServiceToClient({ validateScript, submitScript, scriptCapability } as unknown as AgentCanvasInternalService, { principalId: 'dev-admin' });
  await withMcpPrincipal('user-b', async () => {
    await client.scriptCapability!({ canvasId: 'c' });
    await client.validateScript!({ canvasId: 'c', requestId: 'r', version: 'v1', source: '' });
    await client.submitScript!({ canvasId: 'c', requestId: 'r', version: 'v1', source: '' });
  });
  expect(scriptCapability).toHaveBeenCalledWith(expect.objectContaining({ principalId: 'user-b' }));
  expect(validateScript).toHaveBeenCalledWith(expect.objectContaining({ principalId: 'user-b' }));
  expect(submitScript).toHaveBeenCalledWith(expect.objectContaining({ principalId: 'user-b' }));
});

it('无本轮主体时回落到静态缺省（本地实例 owner）', async () => {
  const readGraph = vi.fn().mockResolvedValue({ ok: true, graph: { canvasId: 'c', revision: 1, nodes: [], edges: [] } });
  const client = agentCanvasServiceToClient({ readGraph } as unknown as AgentCanvasInternalService, { principalId: ' local-agent ' });
  await client.getGraph({ canvasId: 'c' });
  expect(readGraph).toHaveBeenCalledWith(expect.objectContaining({ principalId: 'local-agent' }));
});

it('本轮主体与静态缺省都为空时，列举画布 fail closed 且不触达 Canvas', async () => {
  const listCanvases = vi.fn();
  const client = agentCanvasServiceToClient({ listCanvases } as unknown as AgentCanvasInternalService, { principalId: '' });
  expect(await client.listCanvases({})).toMatchObject({ ok: false, code: 'unauthorized' });
  expect(listCanvases).not.toHaveBeenCalled();
});
