import { describe, expect, it, vi } from "vitest";
import type { ApplicationExtensionServices } from "@woohaa3/contracts";
import { WorkflowRepository } from "../src/state/backend/repository.js";
import { WorkflowService } from "../src/authoring/backend/service.js";
import { createTaskExecutor } from "../src/authoring/backend/task-executor.js";
import { createRun, initialInput } from "../src/state/shared/workflow.js";
import { memoryDocuments } from "./memory-documents.js";
import { planDirections } from "../src/state/shared/creature/direction.js";
import { executeOutputJobs } from "../src/authoring/backend/output-jobs.js";
import { stageOutputSlots } from "../src/state/shared/stage-output.js";
import { STAGES } from "../src/state/shared/recipe.js";
const design = {
  schema: "project-a.creature-video-creature-design.v1", displayName: "冰原", summary: "厚毛四足生物", anatomy: ["四足"], locomotion: "四足行走", materials: ["毛发"], palette: ["灰白"], signatureFeatures: ["长角"], scaleMeters: 2, footBaselineNote: "脚底水平", backgroundKind: "green_screen", forbiddenChanges: ["角的数量"], mirrorSafety: { safe: true, asymmetricFeatures: [], handednessConstraints: [], textOrSymbolsPresent: false, userAcceptedSemanticMirroring: false }, actionCandidates: [{ stateId: "idle", displayName: "站定", kind: "loop", phase: "idle", durationSeconds: 2, description: "站定", required: true, userRequested: true }, { stateId: "death", displayName: "倒地", kind: "one_shot", phase: "terminal", durationSeconds: 2, description: "倒地", required: true, userRequested: true }], promptInvariants: ["保持身份"], userRequest: "冰原"
};
describe("制作持久化与任务恢复", () => {
  it("single-output retry retains successes and sibling errors; execute-all fills only missing outputs",async()=>{
    const repository=new WorkflowRepository(memoryDocuments()),run=createRun("c","n","retry-instance");
    run.activeStage="05_direction_stills";
    for (const definition of STAGES) {if(definition.id===run.activeStage)break;run.stages[definition.id].status="approved";}
    run.stages["03_direction_plan"].structured=planDirections(["6_00","9_00","12_00"],{mirrorSafety:design.mirrorSafety,mirrorDecision:"promoted_all_to_master"}) as unknown as Record<string,unknown>;
    const stage=run.stages["05_direction_stills"];stage.status="failed";
    stage.artifacts=[{id:"retained",title:"retained",kind:"image",directionId:"6_00",outputKey:"direction:6_00",storageKey:"kept"}];
    stage.outputIssues["direction:12_00"]={state:"failed",code:"provider-rejected",message:"original error"};
    const executed:string[]=[];
    const service=new WorkflowService(repository,async context=>{
      const current=context.run.stages[context.stageId],slots=stageOutputSlots(context.run,context.stageId);
      await executeOutputJobs(context,slots.map(slot=>({key:slot.key,dependencies:slot.key==="contact"?slots.filter(item=>item.key!=="contact").map(item=>item.key):[],execute:async()=>{
        executed.push(slot.key);current.artifacts.push({id:slot.key,title:slot.title,kind:slot.kind,outputKey:slot.key});await context.checkpoint();
      }})),new Set(current.artifacts.map(artifact=>artifact.outputKey!)));
      return {artifacts:current.artifacts,structured:current.structured,checks:{hardPassed:true,agent:"pass",notes:[]}};
    });
    await service.start(run,"05_direction_stills",initialInput(),"direction:9_00");await service.settled();
    let saved=await repository.read("c","n","retry-instance");
    expect(executed).toEqual(["direction:9_00"]);expect(saved.stages["05_direction_stills"].status).toBe("failed");
    expect(saved.stages["05_direction_stills"].outputIssues["direction:12_00"]?.message).toBe("original error");
    expect(saved.stages["05_direction_stills"].artifacts.find(artifact=>artifact.id==="retained")?.storageKey).toBe("kept");
    executed.length=0;
    await service.start(saved,"05_direction_stills",initialInput());await service.settled();
    saved=await repository.read("c","n","retry-instance");
    expect(executed).toEqual(["direction:12_00","contact"]);expect(saved.stages["05_direction_stills"].status).toBe("review");
    expect(saved.stages["05_direction_stills"].outputIssues).toEqual({});
  });
  it("serializes concurrent checkpoints without losing output states or CAS conflicts", async()=>{
    const repository=new WorkflowRepository(memoryDocuments());
    const service=new WorkflowService(repository,async context=>{
      const stage=context.run.stages[context.stageId];stage.outputs={};
      await Promise.all(Array.from({length:24},async(_,i)=>{
        stage.outputs![`output-${i}`]="queued";await context.checkpoint();
        stage.outputs![`output-${i}`]="succeeded";await context.checkpoint();
      }));
      return {artifacts:[],structured:null,checks:{hardPassed:true,agent:"pass",notes:[]}};
    });
    await service.start(createRun("c","n","parallel-instance"),"01_brief",{...initialInput(),prompt:"creature"});await service.settled();
    const saved=await repository.read("c","n","parallel-instance");
    expect(saved.stages["01_brief"].status).toBe("review");
    expect(Object.values(saved.stages["01_brief"].outputs!)).toEqual(Array(24).fill("succeeded"));
    expect(saved.version).toBeGreaterThanOrEqual(50);
  });
  it("取消后保留在途远端身份；核对恢复沿用原版本", async()=>{
    const repository=new WorkflowRepository(memoryDocuments());let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
    const executor=vi.fn(async(context:import("../src/authoring/backend/service.js").ExecutionContext)=>{
      const stage=context.run.stages[context.stageId];
      if(!stage.operations.length){stage.operations.push({key:"remote-original",modelKey:"chosen",state:"submitted",remoteRef:"task-original"});await context.checkpoint();entered();while(!context.isStopped())await new Promise(r=>setTimeout(r,1));await context.assertCurrent();}
      return {artifacts:[],structured:null,checks:{hardPassed:true,agent:"pass" as const,notes:[]}};
    });
    const service=new WorkflowService(repository,executor);await service.start(createRun("c","n","cancel-instance"),"01_brief",{...initialInput(),prompt:"creature",modelKey:"chosen"});await ready;
    let run=await service.cancel(await repository.read("c","n","cancel-instance"));expect(run.stages["01_brief"].status).toBe("submit_unknown");
    await service.reconcile(run);await service.settled();run=await repository.read("c","n","cancel-instance");expect(run.stages["01_brief"].status).toBe("review");expect(run.stages["01_brief"].revision).toBe(1);expect(run.stages["01_brief"].operations.map(op=>op.remoteRef)).toEqual(["task-original"]);
  });
  it("同实例用 CAS 防止旧批准覆盖新记录", async () => {
    const repository = new WorkflowRepository(memoryDocuments());
    const first = await repository.read("c", "n", "instance-123"), second = await repository.read("c", "n", "instance-123");
    await repository.save(first);
    await expect(repository.save(second)).rejects.toMatchObject({ code: "revision-conflict" });
  });
  it("提交未知只对账同一个任务；使用所选制作模型且不会自动批准", async () => {
    const repository = new WorkflowRepository(memoryDocuments());
    const submitted: { key: string; model: string }[] = []; let throwOnce = true, reconciled = false;
    const services = { tasks: {
      submit: vi.fn(async (input: { workerTaskKey: string; modelKey: string }) => { submitted.push({ key: input.workerTaskKey, model: input.modelKey }); if (throwOnce) { throwOnce = false; throw new Error("connection lost after accept"); } return { ok: true, workerTaskKey: input.workerTaskKey, reused: false, state: "queued" }; }),
      status: vi.fn(async (workerTaskKey: string) => reconciled ? { workerTaskKey, state: "succeeded" } : null),
      result: vi.fn(async (workerTaskKey: string) => ({ workerTaskKey, state: "succeeded", result: { text: submitted.find(item => item.key === workerTaskKey)?.model === "review-model" ? '{"status":"pass","notes":["已查看设计"]}' : JSON.stringify(design) } })), cancel: vi.fn()
    }, media: { stat: vi.fn() }, canvas: {} } as unknown as ApplicationExtensionServices;
    const service = new WorkflowService(repository, createTaskExecutor(services));
    await service.start(createRun("c", "n", "instance-123"), "01_brief", { ...initialInput(), prompt: "冰原", modelKey: "design-model", reviewModelKey: "review-model" });
    await service.settled();
    let run = await repository.read("c", "n", "instance-123");
    expect(run.stages["01_brief"].status).toBe("submit_unknown");
    await service.reconcile(run); await service.settled();
    run = await repository.read("c", "n", "instance-123");
    expect(submitted).toHaveLength(1); expect(run.stages["01_brief"].status).toBe("submit_unknown");
    reconciled = true;
    await service.reconcile(run); await service.settled();
    run = await repository.read("c", "n", "instance-123");
    expect(submitted.map(item => item.model)).toEqual(["design-model"]);
    expect(run.stages["01_brief"].status).toBe("review");
    expect(run.activeStage).toBe("01_brief"); expect(run.stages["01_brief"].approvals).toEqual({});
  });
  it("发布候选通过同一份 CAS 切换；旧记录不能覆盖已发布版本", async () => {
    const repository=new WorkflowRepository(memoryDocuments()),service=new WorkflowService(repository,vi.fn());
    const run=createRun("c","n","publish-instance"),old={revision:1,bundle:{id:"old",title:"old",kind:"web" as const,storageKey:"old"},files:{}};
    for(const stage of Object.values(run.stages))stage.status="approved";
    run.activeStage="09_publish";run.publication={current:old};const stage=run.stages["09_publish"];stage.status="review";stage.revision=2;stage.checks.hardPassed=true;stage.inputVersions=Object.fromEntries(Object.entries(run.stages).filter(([id])=>id!=="09_publish").map(([id,s])=>[id,s.revision]));
    const artifact={id:"new",title:"new",kind:"web" as const,storageKey:"new"};stage.structured={candidate:{revision:2,bundle:artifact,files:{"manifest.json":artifact,"index.html":artifact}}};await repository.save(run);
    const stale=structuredClone(run);await service.approve(run,{stageId:"09_publish",revision:2,gate:"stage-output",accepted:[],actor:"user"});expect(run.publication?.previous).toEqual(old);
    await expect(service.approve(stale,{stageId:"09_publish",revision:2,gate:"stage-output",accepted:[],actor:"user"})).rejects.toMatchObject({code:"revision-conflict"});
    await service.rollback(run);expect((await repository.read("c","n","publish-instance")).publication?.current).toEqual(old);
  });
  it("恢复沿用已保存的 revision，不创建新候选", async () => {
    const repository = new WorkflowRepository(memoryDocuments()), run = createRun("c", "n", "instance-123");
    run.stages["01_brief"].status = "running"; run.stages["01_brief"].revision = 3; await repository.save(run);
    const execute = vi.fn(async () => ({ artifacts: [], structured: null, checks: { hardPassed: false, agent: "pending" as const, notes: ["缺少证据"] } }));
    const service = new WorkflowService(repository, execute); await service.recover(); await service.settled();
    expect(execute).toHaveBeenCalledOnce();
    const recovered = await repository.read("c", "n", "instance-123");
    expect(recovered.stages["01_brief"].revision).toBe(3); expect(recovered.stages["01_brief"].status).toBe("review");
  });
});
