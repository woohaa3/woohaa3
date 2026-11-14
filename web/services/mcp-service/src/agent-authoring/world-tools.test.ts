import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { SOMA77_JOINTS, assistantWorldToolsForScope, ASSISTANT_WORLD_TOOL } from "@woohaa3/contracts";
import type { ApplicationToolGrant, WorldAnimationScript } from "@woohaa3/contracts";
import { createModelMcpHttpHandler, MODEL_MCP_HTTP_PATH } from "../model-mcp/mcp-http.js";
import type { AgentCanvasClient } from "../downstream/agent-canvas-client.js";
import type { AssistantWorldToolClient } from "./world-tools.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function baseClient(): AgentCanvasClient {
  return {
    async listCanvases() { return { ok: true, canvases: [] }; },
    async getGraph() { return { ok: false, code: "unavailable", message: "not used" }; },
    async getChanges() { return { ok: false, code: "unavailable", message: "not used" }; },
    async applyPlan() { return { ok: false, code: "unavailable", message: "not used" }; },
    async runNode() { return { ok: false, code: "unavailable", message: "not used" }; },
    async getRun() { return { ok: false, code: "unavailable", message: "not used" }; },
    async cancelRun() { return { ok: false, code: "unavailable", message: "not used" }; },
    async getOutput() { return { ok: false, code: "unavailable", message: "not used" }; }
  } as AgentCanvasClient;
}

function grant(): ApplicationToolGrant {
  return {
    token: "grant-token",
    canvasIds: ["canvas-1"],
    nodeIds: [],
    tools: [...assistantWorldToolsForScope({ kind: "scene-area", areaId: "area-1" })],
    workId: "req-1",
    subject: "owner-1",
    world: {
      contextId: "ctx-1",
      completionId: "completion-1",
      runId: "run-1",
      epoch: 0,
      executionId: "exec-1",
      scope: { scope: { kind: "scene-area", areaId: "area-1" }, scopeVersion: "scope-1" }
    }
  };
}

async function start(world: AssistantWorldToolClient, issued: ApplicationToolGrant | null) {
  const handler = createModelMcpHttpHandler({
    agentAuthoring: {
      client: baseClient(),
      world,
      runAvailability: { available: false }
    },
    toolGrant: {
      allowedTools: token => token === issued?.token ? issued.tools : undefined,
      resolve: token => token === issued?.token ? issued : null,
      authorize: () => ({ ok: true })
    }
  });
  const server = http.createServer((req, res) => void handler.handle(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  closers.push(async () => { await handler.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return `http://127.0.0.1:${port}`;
}

async function callTool(base: string, name: string, args: Record<string, unknown>, bearer?: string) {
  const response = await fetch(`${base}${MODEL_MCP_HTTP_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
  });
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1) ?? "{}"
    : text;
  return JSON.parse(payload) as { error?: { code: number; message: string }; result?: { content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean } };
}

describe("assistant world MCP tools", () => {
  it("awaits current animation reads without widening the scoped tool catalog", async () => {
    const animationScript: WorldAnimationScript = {
      script: 'motion.instance.tween("actor-1", { property: "rotation", startTime: 0, endTime: 5, from: [0, 0, 0], to: [0, 90, 0], easing: "easeOut" });',
      scriptLanguage: "javascript",
      scriptVersion: "woohaa-world-animation-js-v2",
      revision: 1,
      sourceHash: "hash-script",
      duration: 5,
      loop: true
    };
    const reads: unknown[] = [];
    const world: AssistantWorldToolClient = {
      async read(input) {
        await Promise.resolve();
        reads.push(input);
        return { ok: true, view: {
          version: "assistant-world-authority-v1", canvasId: "canvas-1", contextId: "ctx-1", runId: "run-1", epoch: 0,
          scope: { scope: { kind: "scene-area", areaId: "area-1" }, scopeVersion: "scope-1" },
          writable: [{ kind: "instance", instanceId: "actor-1", version: "actor-v1" }], readOnly: [], objects: [],
          worldWritable: true, sceneArea: { nodeId: "area-node", revision: 7, scopeVersion: "scope-1", animationOrigin: { u: 0, v: 0 }, animationScript }
        } };
      },
      async write() { throw new Error("Read must not write"); },
      async complete() { throw new Error("Read must not complete"); }
    };
    const issued = grant();
    const base = await start(world, issued);
    const response = await fetch(`${base}${MODEL_MCP_HTTP_PATH}`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-03-26", authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    });
    const raw = await response.text();
    const json = response.headers.get("content-type")?.includes("text/event-stream")
      ? raw.split("\n").filter(line => line.startsWith("data:")).at(-1)!.slice(5).trim()
      : raw;
    const catalog = JSON.parse(json) as { result: { tools: Array<{ name: string; description: string }> } };
    expect(catalog.result.tools.map(tool => tool.name).sort()).toEqual([...issued.tools].sort());
    const guidance = catalog.result.tools.find(tool => tool.name === "edit_scene_animation_script")?.description ?? "";
    expect(guidance).toContain("create/replace/append/patch/delete");
    expect(guidance).toContain("motion.instance/part/camera");
    expect(guidance).toContain("world_model_rig");

    const result = await callTool(base, "get_world_context", {}, issued.token);
    expect(result.result?.structuredContent).toMatchObject({ ok: true, sceneArea: { nodeId: "area-node", revision: 7 } });
    const text = result.result?.content?.find(item => item.type === "text")?.text ?? "";
    expect(JSON.parse(text.slice(text.indexOf("\n") + 1)).sceneArea).not.toHaveProperty("animationScript");
    expect(reads).toEqual([{ canvasId: "canvas-1", contextId: "ctx-1" }]);
  });

  it("rejects legacy director writes before the authority is called", async () => {
    let writes = 0;
    const issued = grant();
    const base = await start({ read: () => ({ ok: false, code: "not-issued", message: "unused" }), async write() { writes++; throw new Error("must not write"); }, async complete() { throw new Error("unused"); } }, issued);
    const result = await callTool(base, "set_scene_animation_script", { duration: 1, loop: false, script: "retired" }, issued.token);
    expect(result.error?.code).toBe(-32602);
    expect(writes).toBe(0);
  });

  it("does not expose the retired resize tool", async () => {
    const calls: Array<import("@woohaa3/contracts").AssistantWorldWriteInput> = [];
    const world: AssistantWorldToolClient = {
      read: () => ({ ok: false, code: "not-issued", message: "not used" }),
      async write(input) {
        calls.push(input);
        return { ok: false, code: "capability-unsupported", message: "旧范围写入已停用" };
      },
      async complete() {
        return { ok: false, code: "not-issued", message: "not used" };
      }
    };
    const token = grant();
    const base = await start(world, token);
    const bounds = { min: { u: -50, v: -50 }, max: { u: 190, v: 190 } };
    const result = await callTool(base, "resize_scene_area", { expectedScopeVersion: "scope-1", bounds }, token.token);
    expect(result.error?.code).toBe(-32602);
    expect(calls).toHaveLength(0);
  });

  it("does not expose or execute world writes without a host grant", async () => {
    const world: AssistantWorldToolClient = {
      read: () => ({ ok: false, code: "not-issued", message: "not issued" }),
      async write() { return { ok: false, code: "not-issued", message: "not issued" }; },
      async complete() { return { ok: false, code: "not-issued", message: "not issued" }; }
    };
    const base = await start(world, null);
    const result = await callTool(base, "get_world_context", {});
    expect(result.result?.isError).toBe(true);
    expect(result.result?.structuredContent).toMatchObject({ ok: false, code: "capability-unsupported" });
  });
});

it("samples the published timeline with its origin and reports data-only evidence", async () => {
 const issued = grant();
 const base = await start({
  read: () => ({ok:true,view:{version:"assistant-world-authority-v1",canvasId:"canvas-1",contextId:"ctx-1",runId:"run-1",epoch:0,
   scope:issued.world!.scope,writable:[],readOnly:[],objects:[],worldWritable:true,
   sceneArea:{nodeId:"area",revision:8,scopeVersion:"scope-1",animationOrigin:{u:10,v:20},animationScript:{
    script:'motion.instance.tween("actor",{property:"position",startTime:0,endTime:2,from:[0,0,0],to:[0,2,0],easing:"linear"});',
    scriptLanguage:"javascript",scriptVersion:"woohaa-world-animation-js-v2",sourceHash:"x",revision:3,duration:2,loop:false
   }},bounds:{min:{u:9,v:19},max:{u:11,v:21}},sceneModels:[{instanceId:"actor",nodeId:"actor-node",title:"Actor",localBounds:null,
    transform:{version:"shared-world-v1",position:{u:10,v:20,h:1},rotation:[0,0,0,1],scale:1},
    animationRig:{groups:[],rig:null,spatial:{forwardLocal:[0,0,1],forwardSource:"humanoid-v1",groundAnchorLocal:[0,-1,0],rootToGroundHeightMeters:1,anchorSource:"geometry-bounds"},
      shapes:[{id:"body",parent:null,position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],localBounds:{min:[-0.5,-1,-0.5],max:[0.5,1,0.5]}}]}
   }]}}),
  async write(){throw new Error("must not write");}, async complete(){throw new Error("must not complete");}
 },issued);
 const context = await callTool(base,"get_world_context",{},issued.token);
 expect(context.result?.structuredContent).toMatchObject({animationBudget:{maxChannels:256,channelCount:1,logicalTrackCount:1,keyframeCount:2,cycleCount:0,segmentCount:1},motionConventions:{cameraForward:expect.stringContaining("-Z")}});
 const rig = await callTool(base,"read_world_resource",{operation:"get",resourceType:"world_model_rig",target:{instanceId:"actor"}},issued.token);
 expect(rig.result?.structuredContent).toMatchObject({resource:{transform:{position:{h:1}},animationRig:{spatial:{rootToGroundHeightMeters:1}},animationBudget:{segmentCount:1}}});
 const result = await callTool(base,"sample_scene_animation",{times:[0,1,2]},issued.token);
 expect(result.result?.structuredContent).toMatchObject({animationBudget:{maxChannels:256,channelCount:1,logicalTrackCount:1,keyframeCount:2,cycleCount:0,segmentCount:1,instanceSegmentCount:1,partSegmentCount:0,cameraSegmentCount:0},ok:true,verification:"sampled-data-only",revision:8,samples:[
  {time:0,instances:{actor:{position:{u:10,v:20,h:0}}}},
  {time:1,instances:{actor:{position:{u:10,v:21,h:0}}}},
  {time:2,instances:{actor:{position:{u:10,v:22,h:0}}}}
 ]});
 expect(result.result?.structuredContent).toMatchObject({samples:[
  {diagnostics:{actor:{heading:{status:"backward"},ground:{status:"below-ground",method:"conservative-posed-bounds"}}}},
  {diagnostics:{actor:{heading:{status:"backward"}}}},
  {diagnostics:{actor:{heading:{status:"backward"},bounds:{outsideSceneArea:true}}}}
 ]});
 expect((await callTool(base,"sample_scene_animation",{times:[3]},issued.token)).result?.isError).toBe(true);
 expect((await callTool(base,"read_world_resource",{operation:"get",resourceType:"world_model_rig",target:{instanceId:"foreign"}},issued.token)).result?.isError).toBe(true);
});

it("describes the frozen expansion policy and omits the retired resize tool", async () => {
  const issued = grant();
  const base = await start({ read: () => ({ ok: false, code: "not-issued", message: "unused" }), async write() { throw new Error("unused"); }, async complete() { throw new Error("unused"); } }, issued);
  const response = await fetch(`${base}${MODEL_MCP_HTTP_PATH}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26", authorization: `Bearer ${issued.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }) });
  const raw = await response.text();
  const json = response.headers.get("content-type")?.includes("text/event-stream") ? raw.split("\n").filter(line => line.startsWith("data:")).at(-1)!.slice(5).trim() : raw;
  const catalog = JSON.parse(json) as { result: { tools: Array<{ name: string; description: string }> } };
  expect(catalog.result.tools.find(tool => tool.name === "get_world_context")?.description).toContain("锁定大小策略");
  expect(catalog.result.tools.find(tool => tool.name === "resize_scene_area")).toBeUndefined();
});

it("rejects rig and scene sample tools when camera or 2D grants omit them", async () => {
  for (const scope of [{kind:"world-camera",cameraId:"camera"},{kind:"workflow-group-2d",groupId:"group"}] as const) {
    const issued = grant();
    issued.world!.scope = {scope,scopeVersion:"scope-1"};
    issued.tools = [...assistantWorldToolsForScope(scope)];
    const base = await start({
      read(){throw new Error("Unauthorized tools must not read context");},
      async write(){throw new Error("must not write");},
      async complete(){throw new Error("must not complete");}
    },issued);
    expect((await callTool(base,"get_world_model_rig",{instanceId:"actor"},issued.token)).error).toBeDefined();
    expect((await callTool(base,"sample_scene_animation",{times:[0]},issued.token)).error).toBeDefined();
  }
});
 it('binds one-call animation to the host grant and keeps SOMA context compact',async()=>{
  let request:unknown;
  const groups=[{id:'soma'},...SOMA77_JOINTS.map(j=>({id:`soma.${j.name}`,parent:j.parent<0?'soma':`soma.${SOMA77_JOINTS[j.parent]!.name}`,position:[...j.position],rotation:[...j.rotation],scale:[1,1,1]}))];
  const world:AssistantWorldToolClient={
   async read(){return {ok:true,view:{scope:grant().world!.scope,sceneModels:[{instanceId:'actor',animationRig:{groups}}]} as any};},
   async write(){throw Error('not used');},async complete(){throw Error('not used');},
   humanoidMotion:{async animate(input){request=input;return {ok:true};},async generate(){throw Error('not used');},async get(){throw Error('not used');},async apply(){throw Error('not used');}}
  };
  const base=await start(world,grant());
  const result=await callTool(base,'animate_humanoid',{instanceId:'actor',prompt:'walk',duration:1,rootMotion:'translate'},grant().token);
  expect(result.result?.structuredContent).toMatchObject({ok:true});
  expect(request).toMatchObject({canvasId:'canvas-1',contextId:'ctx-1',requestId:'req-1',instanceId:'actor',rootMotion:'translate'});
  const context=await callTool(base,'get_world_context',{},grant().token);
  const model=(context.result?.structuredContent?.sceneModels as any[])[0];
 expect(model.somaMotion).toMatchObject({skeletonId:'somaskel77',jointCount:77});
  expect(model.animationRig).toBeUndefined();
 });

it('forwards inspection and source-window inputs under the current world grant',async()=>{
 let inspected:unknown,applied:unknown;
 const world:AssistantWorldToolClient={async read(){throw Error('unused');},async write(){throw Error('unused');},async complete(){throw Error('unused');},humanoidMotion:{async animate(){throw Error('unused');},async generate(){throw Error('unused');},async get(input){inspected=input;return {ok:true};},async apply(input){applied=input;return {ok:true};}}};
 const base=await start(world,grant());
 const inspection=await callTool(base,'get_humanoid_motion',{instanceId:'actor',generationId:'known',inspectTiming:true},grant().token);
 expect(inspection.result?.structuredContent).toMatchObject({ok:true});
 expect(inspected).toMatchObject({canvasId:'canvas-1',contextId:'ctx-1',inspectTiming:true});
 const result=await callTool(base,'apply_humanoid_motion',{instanceId:'actor',assetId:'bound',expectedVersion:'v1',startTime:.6,sourceStartTime:1.1,blendInDuration:.1,replaceExisting:true},grant().token);
 expect(result.result?.structuredContent).toMatchObject({ok:true});
 expect(applied).toMatchObject({canvasId:'canvas-1',contextId:'ctx-1',assetId:'bound',sourceStartTime:1.1,blendInDuration:.1,replaceExisting:true});
 const bad=await callTool(base,'apply_humanoid_motion',{instanceId:'actor',generationId:'known',expectedVersion:'v1',startTime:-.1},grant().token);
 expect(bad.error??bad.result?.isError).toBeTruthy();
});
