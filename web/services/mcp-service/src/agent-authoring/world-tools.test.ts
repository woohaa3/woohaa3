import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { SOMA77_JOINTS, executeModelWithStoredRig, describeWorldModelAnimationRig, HUMANOID_REFERENCE_PARAMETERS, assistantWorldToolsForScope, ASSISTANT_WORLD_TOOL } from "@woohaa3/contracts";
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
    tools: Object.values(ASSISTANT_WORLD_TOOL),
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
    const guidance = catalog.result.tools.find(tool => tool.name === "set_scene_animation_script")?.description ?? "";
    expect(guidance).toContain("256 个逻辑通道");
    expect(guidance).toContain("motion.part.cycle");
    expect(guidance).toContain("phase:0.5");
    expect(guidance).toContain("不按时长展开");
    expect(guidance).toContain("不可为绕过通道预算降低步态频率");
    expect(guidance).toContain("motion.instance.walk");
    for(const term of ["motionReference", "armsDownPose", "longAxisLocal", "joint-twist-without-swing", "T-pose", "endpoint"]) expect(guidance).toContain(term);

    const result = await callTool(base, "get_world_context", {}, issued.token);
    expect(result.result?.structuredContent).toMatchObject({ ok: true, sceneArea: { nodeId: "area-node", revision: 7, animationScript } });
    const text = result.result?.content?.find(item => item.type === "text")?.text ?? "";
    expect(JSON.parse(text.slice(text.indexOf("\n") + 1)).sceneArea.animationScript).toEqual(animationScript);
    expect(reads).toEqual([{ canvasId: "canvas-1", contextId: "ctx-1" }]);
  });

  it("derives the context from the host grant and rejects model-supplied context", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const world: AssistantWorldToolClient = {
      read: () => ({
        ok: true,
        view: {
          version: "assistant-world-authority-v1",
          canvasId: "canvas-1",
          contextId: "ctx-1",
          runId: "run-1",
          epoch: 0,
          scope: { scope: { kind: "scene-area", areaId: "area-1" }, scopeVersion: "scope-1" },
          writable: [],
          readOnly: [],
          objects: [],
          worldWritable: true
        }
      }),
      async write(input) {
        calls.push(input as unknown as Record<string, unknown>);
        return {
          ok: true,
          canvasId: "canvas-1",
          commandId: "cmd-1",
          revision: 2,
          duplicate: false,
          noop: false,
          instanceId: input.operation.kind === "create-model" ? "instance-new" : undefined
        };
      },
      async complete() {
        return { ok: true, duplicate: false, settingsVersion: "cv-2", completionId: "completion-1" };
      }
    };
    const token = grant();
    const base = await start(world, token);
    const context = await callTool(base, "get_world_context", {}, token.token);
    expect(context.result?.structuredContent).toMatchObject({ ok: true, canvasId: "canvas-1", contextId: "ctx-1" });
    const created = await callTool(base, "create_world_model", {
      nodeId: "node-new",
      modelScript: "scene.box({});",
      transform: {
        version: "shared-world-v1",
        position: { u: 1, v: 1, h: 0 },
        rotation: [0, 0, 0, 1],
        scale: 1
      }
    }, token.token);
    expect(created.result?.structuredContent).toMatchObject({ ok: true, instanceId: "instance-new" });
    expect(calls[0]).toMatchObject({ contextId: "ctx-1" });
    const animated = await callTool(base, "set_scene_animation_script", {
      duration: 4,
      loop: false,
      script: 'motion.instance.tween("instance-new", { property: "rotation", startTime: 0, endTime: 4, from: [0, 0, 0], to: [90, 0, 0], easing: "easeIn" });'
    }, token.token);
    expect(animated.result?.structuredContent).toMatchObject({ ok: true });
    expect((calls[1] as { operation: { kind: string } }).operation.kind).toBe("set-scene-animation-script");
    const smuggled = await callTool(base, "create_world_model", {
      contextId: "ctx-other",
      nodeId: "node-new",
      modelScript: "scene.box({});",
      transform: {
        version: "shared-world-v1",
        position: { u: 1, v: 1, h: 0 },
        rotation: [0, 0, 0, 1],
        scale: 1
      }
    }, token.token);
    expect(smuggled.result?.isError).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("turns lookAt into an exact unit quaternion and forwards partial camera patches", async () => {
    const calls: Array<import("@woohaa3/contracts").AssistantWorldWriteInput> = [];
    const world: AssistantWorldToolClient = {
      read: () => ({ ok: false, code: "not-issued", message: "not used" }),
      async write(input) {
        calls.push(input);
        return {
          ok: true,
          canvasId: "canvas-1",
          commandId: "cmd-camera",
          revision: 3,
          duplicate: false,
          noop: false,
          cameraId: "camera-1",
          settingsVersion: "camera-v2",
          version: "camera-v2",
          view: { forward: { u: 0, v: 1, h: 0 }, groundIntersection: { u: 10, v: 5 } }
        };
      },
      async complete() {
        return { ok: true, duplicate: false, settingsVersion: "camera-v2", completionId: "completion-1" };
      }
    };
    const token = grant();
    const base = await start(world, token);
    const created = await callTool(base, "create_world_camera", {
      settings: {
        position: { u: 10, v: 0, h: 1 },
        lookAt: { u: 12, v: 0, h: 1 },
        projection: { kind: "perspective", verticalFovRadians: Math.PI / 3, nearMeters: 0.1, farMeters: 500 },
        captureMode: { kind: "static" },
        aspect: { width: 16, height: 9 },
        boundInstanceId: null
      }
    }, token.token);
    expect(created.result?.isError).toBeFalsy();
    const createdOperation = calls[0]?.operation;
    if (createdOperation?.kind !== "create-world-camera") throw new Error("missing create operation");
    expect(createdOperation.settings).not.toHaveProperty("lookAt");
    const norm = createdOperation.settings.rotation.reduce((sum, value) => sum + value * value, 0);
    expect(Math.abs(norm - 1)).toBeLessThan(1e-6);
    expect(createdOperation.settings.rotation[2]).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(createdOperation.settings.rotation[3]).toBeCloseTo(Math.SQRT1_2, 9);
    // The result hands back where the lens points so the caller can check framing.
    expect(created.result?.content?.[0]?.text).toContain("朝向 (u,v,h)=(0, 1, 0)");
    expect(created.result?.content?.[0]?.text).toContain("地面落点 (u,v)=(10, 5)");

    const adjusted = await callTool(base, "set_world_camera", {
      cameraId: "camera-1",
      expectedSettingsVersion: "camera-v1",
      settings: { position: { u: 11, v: 0, h: 0.5 } }
    }, token.token);
    expect(adjusted.result?.isError).toBeFalsy();
    const adjustedOperation = calls[1]?.operation;
    if (adjustedOperation?.kind !== "set-world-camera") throw new Error("missing set operation");
    expect(adjustedOperation.settings).toEqual({ position: { u: 11, v: 0, h: 0.5 } });
  });

  it("resizes the director area through the dedicated range tool", async () => {
    const calls: Array<import("@woohaa3/contracts").AssistantWorldWriteInput> = [];
    const world: AssistantWorldToolClient = {
      read: () => ({ ok: false, code: "not-issued", message: "not used" }),
      async write(input) {
        calls.push(input);
        return {
          ok: true,
          canvasId: "canvas-1",
          commandId: "cmd-area",
          revision: 4,
          duplicate: false,
          noop: false,
          version: "area-scope-2"
        };
      },
      async complete() {
        return { ok: false, code: "not-issued", message: "not used" };
      }
    };
    const token = grant();
    const base = await start(world, token);
    const bounds = { min: { u: -50, v: -50 }, max: { u: 190, v: 190 } };
    const result = await callTool(base, "resize_scene_area", { expectedScopeVersion: "scope-1", bounds }, token.token);
    expect(result.result?.isError).toBeFalsy();
    expect(calls[0]?.operation).toMatchObject({ kind: "resize-scene-area", expectedScopeVersion: "scope-1", bounds });

    const unordered = await callTool(base, "resize_scene_area", {
      expectedScopeVersion: "scope-1",
      bounds: { min: { u: 5, v: 5 }, max: { u: 0, v: 0 } }
    }, token.token);
    expect(unordered.result?.isError).toBe(true);
    expect(calls).toHaveLength(1);
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
 const rig = await callTool(base,"get_world_model_rig",{instanceId:"actor"},issued.token);
 expect(rig.result?.structuredContent).toMatchObject({transform:{position:{h:1}},animationRig:{spatial:{rootToGroundHeightMeters:1}},animationBudget:{segmentCount:1}});
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
 expect((await callTool(base,"get_world_model_rig",{instanceId:"foreign"},issued.token)).result?.isError).toBe(true);
});

it.each([
  ["outside-scope", { ok: false, code: "outside-scope", message: "模型 footprint 超出导演区" }, "outside-scope", "resize_scene_area"],
  ["version-conflict", { ok: false, code: "version-conflict", message: "模型版本已变化" }, "version-conflict", "get_world_context"],
  ["version-unknown", { ok: false, code: "outside-scope", message: "无法确认目标当前版本", spatialReason: "version-unknown" }, "version-unknown", "无法确认"]
] as const)("keeps the %s failure visible with actionable diagnostics", async (_name, failure, kind, hint) => {
  const issued = grant();
  const base = await start({
    read: () => ({ ok: false, code: "not-issued", message: "not used" }),
    async write() { return failure; },
    async complete() { return failure; }
  }, issued);
  const result = await callTool(base, "create_world_model", {
    modelScript: "scene.box({});",
    transform: { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 }
  }, issued.token);
  expect(result.result?.isError).toBe(true);
  const structured = result.result?.structuredContent ?? {};
  expect(structured).toMatchObject({ ok: false, code: failure.code, message: failure.message, failureKind: kind });
  if ("spatialReason" in failure) expect(structured.spatialReason).toBe(failure.spatialReason);
  const text = result.result?.content?.[0]?.text ?? "";
  expect(text).toContain(`[${kind}]`);
  expect(text).toContain(hint);

  const moved = await callTool(base, "move_world_model", {
    instanceId: "actor",
    expectedVersion: "actor-v1",
    transform: { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 }
  }, issued.token);
  expect(moved.result?.structuredContent).toMatchObject({ ok: false, failureKind: kind });
  expect(moved.result?.content?.[0]?.text).toContain(`[${kind}]`);
});

it("describes the default 4x4 area and the resize prerequisite", async () => {
  const issued = grant();
  const base = await start({
    read: () => ({ ok: false, code: "not-issued", message: "not used" }),
    async write() { throw new Error("unused"); },
    async complete() { throw new Error("unused"); }
  }, issued);
  const response = await fetch(`${base}${MODEL_MCP_HTTP_PATH}`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26", authorization: `Bearer ${issued.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })
  });
  const raw = await response.text();
  const json = response.headers.get("content-type")?.includes("text/event-stream")
    ? raw.split("\n").filter(line => line.startsWith("data:")).at(-1)!.slice(5).trim()
    : raw;
  const catalog = JSON.parse(json) as { result: { tools: Array<{ name: string; description: string }> } };
  const describe = (name: string) => catalog.result.tools.find(tool => tool.name === name)?.description ?? "";
  for (const name of ["get_world_context", "create_world_model", "resize_scene_area"]) {
    expect(describe(name)).toContain("4×4");
    expect(describe(name)).toContain(name === "get_world_context" ? "edit_scene_area" : "resize_scene_area");
  }
  const create = describe("create_world_model");
  for (const term of ["outside-scope", "version-conflict", "version-unknown"]) expect(create).toContain(term);
  expect(describe("resize_scene_area")).toContain("重新 get_world_context");
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

it.each(["failed", "throw", "missing-area", "script", "duration", "loop", "context", "area", "old-revision"])("preserves a saved animation when readback is unavailable: %s", async mode => {
 const issued = grant();
 const candidate = {script:'motion.instance.tween("actor",{property:"position",startTime:0,endTime:2,from:[0,0,1],to:[0,-2,1],easing:"linear"});',duration:2,loop:false};
 let saved = false;
 const base = await start({
  read() {
   expect(saved).toBe(true);
   if(mode === "throw") throw new Error("readback offline");
   if(mode === "failed") return {ok:false,code:"not-issued",message:"readback offline"};
   return {ok:true,view:{version:"assistant-world-authority-v1",canvasId:"canvas-1",contextId:"ctx-1",runId:"run-1",epoch:0,scope:issued.world!.scope,writable:[],readOnly:[],objects:[],worldWritable:true,
    ...(mode === "context" ? {contextId:"different-context"} : mode === "area" ? {scope:{scope:{kind:"scene-area",areaId:"different-area"},scopeVersion:"scope-2"}} : {}),
    ...(mode === "missing-area" ? {} : {sceneArea:{nodeId:"area",revision:mode === "old-revision" ? 7 : 8,scopeVersion:"scope-1",animationOrigin:{u:0,v:0},animationScript:{...candidate,scriptLanguage:"javascript",scriptVersion:"woohaa-world-animation-js-v2",sourceHash:"saved",revision:1,
     ...(mode === "script" ? {script:"// concurrently replaced"} : mode === "duration" ? {duration:3} : mode === "loop" ? {loop:true} : {})}}})}};
  },
  async write(){saved=true;return {ok:true,canvasId:"canvas-1",commandId:"saved",revision:8,duplicate:false,noop:false};},
  async complete(){throw new Error("unused");}
 },issued);
 const result = await callTool(base,"set_scene_animation_script",candidate,issued.token);
 expect(result.result?.isError).not.toBe(true);
 expect(result.result?.structuredContent).toMatchObject({ok:true,motionVerification:{verification:"sampled-data-only",status:"unavailable",reason:expect.any(String)}});
});

it.each(["clear", "warnings"])("automatically verifies the committed animation with %s data evidence", async expectedStatus => {
 const issued = grant();
 const height = expectedStatus === "clear" ? 1 : 0;
 const destination = expectedStatus === "clear" ? -2 : 2;
 const candidate = {script:`motion.instance.tween("actor",{property:"position",startTime:0,endTime:2,from:[0,0,${height}],to:[0,${destination},${height}],easing:"linear"});`,duration:2,loop:false};
 let saved = false;
 const base = await start({
  read() {
   expect(saved).toBe(true);
   return {ok:true,view:{version:"assistant-world-authority-v1",canvasId:"canvas-1",contextId:"ctx-1",runId:"run-1",epoch:0,scope:issued.world!.scope,writable:[],readOnly:[],objects:[],worldWritable:true,
    sceneArea:{nodeId:"area",revision:9,scopeVersion:"scope-1",animationOrigin:{u:10,v:20},animationScript:{...candidate,scriptLanguage:"javascript",scriptVersion:"woohaa-world-animation-js-v2",sourceHash:"saved",revision:1}},
    bounds:{min:{u:9,v:17},max:{u:11,v:23}},sceneModels:[{instanceId:"actor",nodeId:"actor-node",title:"Actor",localBounds:null,
     transform:{version:"shared-world-v1",position:{u:10,v:20,h:1},rotation:[0,0,0,1],scale:1},
     animationRig:{groups:[],rig:null,spatial:{forwardLocal:[0,0,1],forwardSource:"humanoid-v1",groundAnchorLocal:[0,-1,0],rootToGroundHeightMeters:1,anchorSource:"geometry-bounds"},
      shapes:[{id:"body",parent:null,position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],localBounds:{min:[-0.5,-1,-0.5],max:[0.5,1,0.5]}}]}}]}};
  },
  async write(){saved=true;return {ok:true,canvasId:"canvas-1",commandId:"saved",revision:8,duplicate:false,noop:false};},
  async complete(){throw new Error("unused");}
 },issued);
 const result = await callTool(base,"set_scene_animation_script",candidate,issued.token);
 expect(result.result?.structuredContent).toMatchObject({ok:true,revision:8,motionVerification:{verification:"sampled-data-only",status:expectedStatus,observedRevision:9,unavailableTargets:[]}});
 const receipt = result.result?.structuredContent?.motionVerification as {sampleCount:number;issues:Array<{code:string}>};
 expect(receipt.sampleCount).toBeGreaterThan(1);
 if(expectedStatus === "warnings") expect(receipt.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(["backward-motion","below-ground-bounds"]));
 else expect(receipt.issues).toEqual([]);
 expect(result.result?.content?.[0]?.text).toContain("未进行视觉验收");
});

it("returns axial joint warnings after a successful save in a fresh director area",async()=>{
 const issued=grant(),stored={profile:"humanoid",templateId:"humanoid",templateVersion:1,parameters:HUMANOID_REFERENCE_PARAMETERS} as const;
 const execution=executeModelWithStoredRig('scene.segment({id:"abdomen",parent:rig.joint("Spine"),from:[0,-0.5,0],to:[0,0,0],width:0.32,depth:0.24,shape:"box"});scene.box({id:"foot",parent:rig.joint("LeftFoot"),size:[0.2,0.1,0.3]});',"woohaa-model-js-v2",stored);
 if(!execution.ok)throw new Error(execution.message);
 const animationRig=describeWorldModelAnimationRig(execution.scene.ops,stored);
 const candidate={script:'motion.part.tween("actor","LeftUpperArm",{property:"rotation",startTime:0,endTime:2,from:[-25,0,0],to:[25,0,0]});',duration:2,loop:false};
 let saved=false;
 const base=await start({
  read(){return {ok:true,view:{version:"assistant-world-authority-v1",canvasId:"canvas-1",contextId:"ctx-1",runId:"run-1",epoch:0,scope:issued.world!.scope,writable:[],readOnly:[],objects:[],worldWritable:true,
   sceneArea:{nodeId:"fresh-area",revision:saved?8:7,scopeVersion:"scope-1",animationOrigin:{u:0,v:0},animationScript:saved?{...candidate,scriptLanguage:"javascript",scriptVersion:"woohaa-world-animation-js-v2",sourceHash:"saved",revision:1}:null},
   sceneModels:[{instanceId:"actor",nodeId:"actor-node",title:"Actor",localBounds:null,transform:{version:"shared-world-v1",position:{u:0,v:0,h:1},rotation:[0,0,0,1],scale:1},animationRig}]}};},
  async write(){saved=true;return {ok:true,canvasId:"canvas-1",commandId:"saved",revision:8,duplicate:false,noop:false};},async complete(){throw new Error("unused");}
 },issued);
 const rig=await callTool(base,"get_world_model_rig",{instanceId:"actor"},issued.token);
 expect(rig.result?.structuredContent).toMatchObject({animationRig:{motionReference:{profile:"humanoid-v1",armsDownPose:expect.any(Object)}}});
 const result=await callTool(base,"set_scene_animation_script",candidate,issued.token);
 expect(result.result?.isError).not.toBe(true);
 expect(result.result?.structuredContent).toMatchObject({ok:true,motionVerification:{status:"warnings",issues:expect.arrayContaining([expect.objectContaining({code:"joint-twist-without-swing",detail:expect.objectContaining({jointId:"LeftUpperArm",rotationRadians:expect.any(Number),endpointDisplacementMeters:expect.any(Number)})})])}});
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
  expect(model.somaMotion).toMatchObject({skeletonId:'somaskel77',jointCount:77,tool:'animate_humanoid'});
  expect(model.animationRig.groups).toBeUndefined();
 });
