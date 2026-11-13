import { it, expect } from "vitest";
import {
  isCanvasTaskModelType,
  isCanvasTaskNodeType,
  isNodeModelTypeMatch,
  NODE_TYPE_TO_TASK_KIND,
  TASK_KIND_TO_MODEL_TYPE,
} from "./dto";
import { isTaskModelType } from "./history/guards";
import { taskMediaReadiness } from "./history/media-readiness";
it("accepts motion task/catalog identity and requires stable binary output", () => {
  expect(isCanvasTaskModelType("motion")).toBe(true);
  expect(isTaskModelType("motion")).toBe(true);
  expect(isCanvasTaskNodeType("motion")).toBe(true);
  expect(isNodeModelTypeMatch("motion" as never, "motion" as never)).toBe(true);
  expect((NODE_TYPE_TO_TASK_KIND as Record<string, string>).motion).toBe(
    "motion-generation",
  );
  expect(
    (TASK_KIND_TO_MODEL_TYPE as Record<string, string>)["motion-generation"],
  ).toBe("motion");
  expect(
    taskMediaReadiness({
      state: "succeeded",
      modelType: "motion" as never,
      result: { mediaKind: "motion" as never },
    }),
  ).toBe("preparing");
  expect(
    taskMediaReadiness({
      state: "succeeded",
      modelType: "motion" as never,
      result: {
        mediaKind: "motion" as never,
        storageKey: "motion.npz",
        checksum: "sha256",
      },
    }),
  ).toBe("ready");
});
import { isTaskExecutionSummary } from "./history/guards";
it("validates stable SOMA metadata without accepting invalid rates or skeletons", () => {
  const motion = {
    formatVersion: "kimodo-soma-v1",
    skeletonId: "somaskel77",
    restPoseId: "kimodo-standard-tpose",
    fps: 30,
    frameCount: 90,
    jointCount: 77,
  };
  const record = {
    taskKey: "motion-task",
    state: "succeeded",
    providerId: "test",
    modelType: "motion",
    createdAt: "now",
    updatedAt: "now",
    durationMs: 100,
    recordRevision: 1,
    result: { mediaKind: "motion", fps: 30, motion },
  };
  expect(isTaskExecutionSummary(record)).toBe(true);
  expect(
    isTaskExecutionSummary({
      ...record,
      result: { ...record.result, fps: NaN },
    }),
  ).toBe(false);
  expect(
    isTaskExecutionSummary({
      ...record,
      result: {
        ...record.result,
        motion: { ...motion, skeletonId: "unknown" },
      },
    }),
  ).toBe(false);
});
import {
  findAgentNodeDescriptor,
  defaultAgentNodeData,
} from "../canvas/agent-node-descriptors";
import { WOOHAA3_APP_NODE_TYPES } from "../canvas/domain/normalization";
it("preserves a canonical motion task node and exposes Agent creation", () => {
  expect((WOOHAA3_APP_NODE_TYPES as readonly string[]).includes("motion")).toBe(
    true,
  );
  expect(findAgentNodeDescriptor("motion")?.taskKind).toBe("motion-generation");
  expect(defaultAgentNodeData("motion")).toEqual({
    taskKind: "motion-generation",
    taskStatus: "idle",
  });
});
import {nodeHistoryKindForNodeType,nodeTypesForHistoryKind} from '../canvas/node-history/identity';
import {emptyNodeHistoryKindCounts} from '../canvas/node-history/query';
it('keeps motion node history distinct from image and audio history',()=>{
 expect(nodeHistoryKindForNodeType('motion')).toBe('motion');expect(nodeTypesForHistoryKind('motion' as never)).toEqual(['motion']);expect((emptyNodeHistoryKindCounts() as Record<string,number>).motion).toBe(0);
});
import {isGenerationStableMediaResult} from '../extension/services/host/generation';
it('requires canonical metadata on generated NPZ stable envelopes',()=>{
 const media={locator:'media://server/canvas/media/motion.npz',storageKey:'',contentType:'application/x-npz',size:100,checksum:'a'.repeat(64)};
 expect(isGenerationStableMediaResult({media})).toBe(false);
 expect(isGenerationStableMediaResult({media:{...media,motion:{fps:30,frameCount:90,skeletonId:'other',restPoseId:'kimodo-standard-tpose',formatVersion:'kimodo-soma-v1'}}})).toBe(false);
});
