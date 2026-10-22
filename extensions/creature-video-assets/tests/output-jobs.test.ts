import { describe, expect, it, vi } from "vitest";
import type { ApplicationExtensionServices } from "@woohaa3/contracts";
import { runOutputJobs } from "../src/authoring/backend/output-jobs.js";
import { task } from "../src/authoring/backend/task-runner.js";
import { createRun, WorkflowError, type OutputIssue, type OutputState } from "../src/state/shared/workflow.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return {promise,resolve}; }
describe("parallel output scheduling", () => {
  it("submits all independent host tasks before waiting for any result", async () => {
    const gates = [deferred(),deferred(),deferred()], submitted:string[] = [];
    const run = createRun("canvas","node","instance-123");
    const stage = run.stages["07_rgb_videos"]; stage.input.modelKey="video-model";
    const services = {tasks:{submit:vi.fn(async ({workerTaskKey}:{workerTaskKey:string})=>{submitted.push(workerTaskKey);return {ok:true,state:"queued"};}),result:vi.fn(async(key:string)=>{
      await gates[submitted.indexOf(key)]!.promise;
      return {state:"succeeded",result:{storageKey:key,checksum:"a".repeat(64),contentType:"video/mp4"}};
    })}} as unknown as ApplicationExtensionServices;
    const checkpoint=vi.fn(async()=>{}), outputs:Record<string,OutputState>={};
    const work=runOutputJobs(["a","b","c"].map(key=>({key,dependencies:[],execute:async()=>{
      await task({run,stageId:"07_rgb_videos",outputKey:key,checkpoint,assertCurrent:async()=>{},isStopped:()=>false},services,key,"video","prompt",[]);
    }})),new Set(),stage.outputIssues,checkpoint,outputs);
    await vi.waitFor(()=>expect(submitted).toHaveLength(3));
    expect(stage.outputs).toEqual({a:"queued",b:"queued",c:"queued"});
    gates.forEach(gate=>gate.resolve());await work;
    expect(outputs).toEqual({a:"succeeded",b:"succeeded",c:"succeeded"});
  });
  it("starts successors immediately and waits for unrelated in-flight tasks even after a failure", async()=>{
    const fast=deferred(),slow=deferred(),started:string[]=[],done=new Set<string>();
    const outputs:Record<string,OutputState>={},issues:Record<string,OutputIssue>={};
    let settled=false;
    const work=runOutputJobs([
      {key:"fast",dependencies:[],execute:async()=>{started.push("fast");await fast.promise;}},
      {key:"slow",dependencies:[],execute:async()=>{started.push("slow");await slow.promise;}},
      {key:"child",dependencies:["fast"],execute:async()=>{started.push("child");}},
      {key:"bad",dependencies:[],execute:async()=>{throw new WorkflowError("provider-rejected","rejected");}},
      {key:"blocked",dependencies:["bad"],execute:async()=>{throw Error("must not run");}}
    ],done,issues,async()=>{},outputs).then(()=>{settled=true;});
    await vi.waitFor(()=>expect(started).toEqual(["fast","slow"]));
    fast.resolve();await vi.waitFor(()=>expect(done.has("child")).toBe(true));
    expect(settled).toBe(false);expect(outputs.slow).toBe("processing");
    expect(issues.blocked?.state).toBe("blocked");expect(issues.bad?.message).toBe("rejected");
    slow.resolve();await work;expect(done).toEqual(new Set(["fast","child","slow"]));
  });
  it("executes only the requested output and preserves completed siblings",async()=>{
    const selected=vi.fn(async()=>{}),untouched=vi.fn(async()=>{}),completed=new Set(["done"]);
    const outputs:Record<string,OutputState>={done:"succeeded"};
    await runOutputJobs([{key:"done",dependencies:[],execute:untouched},{key:"selected",dependencies:[],execute:selected},{key:"other",dependencies:[],execute:untouched}],completed,{},async()=>{},outputs,new Set(["selected"]));
    expect(selected).toHaveBeenCalledOnce();expect(untouched).not.toHaveBeenCalled();
    expect(outputs).toEqual({done:"succeeded",selected:"succeeded"});
  });
  it("drains independent work before surfacing an unknown remote submission",async()=>{
    const slow=deferred();let settled=false;
    const work=runOutputJobs([
      {key:"unknown",dependencies:[],execute:async()=>{throw new WorkflowError("submit-unknown","unknown");}},
      {key:"slow",dependencies:[],execute:async()=>{await slow.promise;}}
    ],new Set(),{},async()=>{}).catch(error=>{settled=true;return error;});
    await new Promise(resolve=>setTimeout(resolve,10));expect(settled).toBe(false);
    slow.resolve();expect(await work).toMatchObject({code:"submit-unknown"});
  });
});
