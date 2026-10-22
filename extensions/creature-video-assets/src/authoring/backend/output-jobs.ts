import { WorkflowError, type OutputIssue, type OutputState } from "../../state/shared/workflow.js";
import type { ExecutionContext } from "./service.js";

export type OutputJob = { key: string; dependencies: string[]; execute(): Promise<void> };

export async function setOutputState(context: ExecutionContext, state: OutputState): Promise<void> {
  if (!context.outputKey) return;
  const stage = context.run.stages[context.stageId];
  stage.outputs ??= {};
  if (stage.outputs[context.outputKey] === state) return;
  stage.outputs[context.outputKey] = state;
  await context.checkpoint();
}

/** Each promise waits only for its own dependencies. Always drain before disposing media files. */
export async function runOutputJobs(jobs: OutputJob[], completed: Set<string>, issues: Record<string, OutputIssue>, checkpoint: () => Promise<void>, outputs: Record<string, OutputState> = {}, requested?: Set<string>): Promise<void> {
  const byKey = new Map(jobs.map(job => [job.key, job]));
  const visiting = new Set<string>(), visited = new Set<string>();
  const validate = (key: string) => {
    if (completed.has(key) || visited.has(key)) return;
    if (visiting.has(key) || !byKey.has(key)) throw new WorkflowError("invalid-clip-dependency", "产物依赖成环或缺少前序产物。");
    visiting.add(key);
    byKey.get(key)!.dependencies.forEach(validate);
    visiting.delete(key); visited.add(key);
  };
  jobs.forEach(job => validate(job.key));
  const pending = new Map<string, Promise<void>>();
  let fatal: unknown;
  const execute = (key: string): Promise<void> => {
    if (completed.has(key)) { outputs[key] = "succeeded"; delete issues[key]; return Promise.resolve(); }
    if (requested && !requested.has(key)) return Promise.resolve();
    const found = pending.get(key);
    if (found) return found;
    const job = byKey.get(key)!;
    const promise = Promise.resolve().then(async () => {
      outputs[key] = "waiting";
      await checkpoint();
      await Promise.all(job.dependencies.map(execute));
      if (job.dependencies.some(dependency => !completed.has(dependency))) {
        outputs[key] = "blocked";
        issues[key] = { state: "blocked", code: "output-dependency-failed", message: "所依赖的前序产物未完成，请先重试该产物。" };
        await checkpoint(); return;
      }
      try {
        outputs[key] = "processing"; delete issues[key]; await checkpoint();
        await job.execute();
        completed.add(key); outputs[key] = "succeeded"; delete issues[key];
      } catch (error) {
        const code = error instanceof WorkflowError ? error.code : "output-failed";
        outputs[key] = code === "submit-unknown" ? "unknown" : "failed";
        issues[key] = { state: "failed", code, message: error instanceof Error ? error.message : "本产物制作失败，请重试。" };
        if (["executor-stopped", "revision-conflict", "submit-unknown"].includes(code)) fatal ??= error;
      }
      await checkpoint();
    });
    pending.set(key, promise); return promise;
  };
  const settled = await Promise.allSettled(jobs.map(job => execute(job.key)));
  const rejected = settled.find(result => result.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
  if (fatal) throw fatal;
}

export async function executeOutputJobs(context: ExecutionContext, jobs: OutputJob[], completed: Set<string>): Promise<void> {
  const stage = context.run.stages[context.stageId];
  stage.outputs ??= {};
  await runOutputJobs(jobs, completed, stage.outputIssues, context.checkpoint, stage.outputs, stage.targetOutputs ? new Set(stage.targetOutputs) : undefined);
  if (jobs.some(job => !completed.has(job.key))) throw new WorkflowError("partial-output-failure", "部分产物未完成，请在对应产物节点查看原因并重试。");
}
