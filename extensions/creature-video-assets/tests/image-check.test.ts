import { createHash } from "node:crypto";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import type { ApplicationExtensionServices } from "@woohaa3/contracts";
import { createRun, initialInput } from "../src/state/shared/workflow.js";
import { DEFAULT_PRODUCTION_PROFILE } from "../src/authoring/backend/production-profile.js";
import { createTaskExecutor } from "../src/authoring/backend/task-executor.js";
import { imageRequestParameters } from "../src/authoring/backend/image-request.js";
import { inspectImage } from "../src/authoring/backend/image-check.js";

it("a wide identity board is reviewable with a warning; checksum mismatch still fails",async()=>{
  const bytes=await sharp({create:{width:1681,height:936,channels:3,background:"#ccc"}}).png().toBuffer(),checksum=createHash("sha256").update(bytes).digest("hex");
  const artifact={id:"image",title:"identity",kind:"image" as const,storageKey:"image",checksum,size:bytes.length,contentType:"image/png"};
  const submit=vi.fn(async()=>({ok:true,state:"queued"})),services={media:{resources:{read:async()=>({bytes,contentType:"image/png"})}},tasks:{submit,result:async()=>({state:"succeeded",result:artifact})}} as unknown as ApplicationExtensionServices;
  const run=createRun("c","n","instance-123");run.productionProfile=structuredClone(DEFAULT_PRODUCTION_PROFILE);
  run.stages["01_brief"].structured={schema:"project-a.creature-video-creature-design.v1",displayName:"生物",summary:"四足生物",anatomy:["四足"],locomotion:"行走",materials:["毛发"],palette:["灰白"],signatureFeatures:["角"],scaleMeters:2,footBaselineNote:"水平",backgroundKind:"green_screen",forbiddenChanges:["身份"],mirrorSafety:{safe:true,asymmetricFeatures:[],handednessConstraints:[],textOrSymbolsPresent:false,userAcceptedSemanticMirroring:false},actionCandidates:[{stateId:"idle",displayName:"待机",kind:"loop",phase:"idle",durationSeconds:2,description:"站立",required:true,userRequested:true}],promptInvariants:["固定相机"],userRequest:"生物"};
  const stage=run.stages["02_identity_board"];stage.input={...initialInput(),modelKey:"litellm:gpt-image-2.5-sunburst"};
  const checkpoint=async()=>{};
  const ctx={run,stageId:"02_identity_board" as const,checkpoint,assertCurrent:checkpoint,isStopped:()=>false};
  const result=await createTaskExecutor(services)(ctx);expect(result.checks.hardPassed).toBe(true);expect(result.structured).toMatchObject({width:1681,height:936,warningCodes:["identity_aspect_mismatch"]});expect(result.checks.notes.join(" ")).toContain("1681 × 936");expect(submit).toHaveBeenCalledOnce();expect(submit).toHaveBeenCalledWith(expect.objectContaining({parameters:{aspectRatio:"1:1",resolution:"4K",quality:"high"}}));
  await expect(inspectImage(services,{...artifact,checksum:"wrong"},1)).rejects.toMatchObject({code:"image-check-failed"});
});

it("LiteLLM image parameters use the current family resolution and aspect-ratio contract",()=>{
  expect(imageRequestParameters("litellm:gpt-image-2.5-sunburst",DEFAULT_PRODUCTION_PROFILE.identityParameters)).toEqual({aspectRatio:"1:1",resolution:"4K",quality:"high"});
  expect(imageRequestParameters("other:image",DEFAULT_PRODUCTION_PROFILE.identityParameters)).toEqual(DEFAULT_PRODUCTION_PROFILE.identityParameters);
  const mapped=imageRequestParameters("litellm:image",DEFAULT_PRODUCTION_PROFILE.identityParameters);expect(imageRequestParameters("litellm:image",mapped)).toEqual(mapped);
});

