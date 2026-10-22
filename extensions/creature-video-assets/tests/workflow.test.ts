import { describe, expect, it } from "vitest";
import { approveStage, createRun, dependencies, initialInput, markDependentsStale, prepareStage, type WorkflowRun } from "../src/state/shared/workflow.js";
import { STAGES } from "../src/state/shared/recipe.js";
import type { StageId } from "../src/state/shared/creature/ids.js";
function approvedThrough(run: WorkflowRun, target: StageId) {
  for (const stage of STAGES) { if (stage.id === target) break; run.stages[stage.id].status = "approved"; }
  run.activeStage = target;
}
function readyToApprove(run: WorkflowRun, id: StageId) {
  const state = run.stages[id]; state.status = "review"; state.checks = { hardPassed: true, agent: "pass", notes: [] };
  state.inputVersions = Object.fromEntries(dependencies(id).map(dep => [dep, run.stages[dep].revision]));
}
describe("制作步骤与批准门", () => {
  it("第 2–8 步不允许人工回填参考图", () => {
    for (const stage of STAGES.slice(1)) {
      const run = createRun("canvas", "node", "instance-123"); approvedThrough(run, stage.id);
      expect(() => prepareStage(run, stage.id, { ...initialInput(), referenceImages: [{ sourceNodeId: "image", assetId: "a", storageKey: "key", checksum: "hash", contentType: "image/png", size: 24, title: "参考" }] })).toThrow("只有第一步");
    }
  });
  it("前序批准与完整性检查必须通过，用户下一步即验收且不受监督结论阻断", () => {
    const run = createRun("canvas", "node", "instance-123");
    expect(() => prepareStage(run, "02_identity_board", initialInput())).toThrow();
    expect(() => approveStage(run, "01_brief", 1, "stage-output", [true, true], "user", 2)).toThrow();
    readyToApprove(run, "01_brief");
    expect(() => approveStage(run, "01_brief", 2, "stage-output", [true, true], "user", 2)).toThrow("版本");
    run.stages["01_brief"].checks.agent = "fail";
    run.stages["01_brief"].checks.hardPassed = false;
    approveStage(run, "01_brief", 1, "stage-output", [], "user", 2);
    expect(run.activeStage).toBe("02_identity_board");
  });
  it("开始重做旧步骤时刷新游标回到当前步骤", () => {
    const run = createRun("canvas", "node", "instance-123");
    for (const stage of STAGES) run.stages[stage.id].status = "approved";
    run.activeStage = "07_rgb_videos";
    prepareStage(run, "05_direction_stills", initialInput());
    expect(run.activeStage).toBe("05_direction_stills");
  });
  it("试片通过只打开同版本的批量门；失败后可以直接重新执行", () => {
    const run = createRun("canvas", "node", "instance-123"); approvedThrough(run, "07_rgb_videos");
    const stage = run.stages["07_rgb_videos"]; readyToApprove(run, "07_rgb_videos");
    stage.artifacts = [{ id: "pilot", title: "试片", kind: "video" }]; stage.operations = [{ key: "pilot-task", modelKey: "model", state: "succeeded" }];
    approveStage(run, "07_rgb_videos", 1, "pilot", [true, true, true], "user", 3);
    expect(run.activeStage).toBe("07_rgb_videos");
    expect(stage.gate).toBe("batch");
    prepareStage(run, "07_rgb_videos", stage.input);
    expect(stage.revision).toBe(1); expect(stage.artifacts[0]?.id).toBe("pilot"); expect(stage.approvals.pilot).toBeDefined();
    stage.status = "failed";
    stage.outputIssues.test = {state:"failed",code:"test",message:"test"};
    prepareStage(run, "07_rgb_videos", stage.input);
    expect(stage.gate).toBe("pilot"); expect(stage.revision).toBe(2); expect(stage.outputIssues).toEqual({});
  });
  it("前序改版使依赖分支 stale，同时保留旧证据", () => {
    const run = createRun("canvas", "node", "instance-123");
    for (const stage of Object.values(run.stages)) { stage.status = "approved"; stage.artifacts = [{ id: "old", kind: "text", title: "旧证据", text: "old" }]; }
    markDependentsStale(run, "02_identity_board");
    expect(run.stages["01_brief"].status).toBe("approved");
    for (const definition of STAGES.slice(2)) { expect(run.stages[definition.id].status).toBe("stale"); expect(run.stages[definition.id].artifacts[0]?.id).toBe("old"); }
  });
  it("结果未知时阻止新任务", () => {
    const run = createRun("canvas", "node", "instance-123"); run.stages["01_brief"].status = "submit_unknown";
    expect(() => prepareStage(run, "01_brief", { ...initialInput(), prompt: "生物" })).toThrow("先对账");
  });
});
