import type { ExtensionDocumentStore, ExtensionDocumentValue } from "@woohaa3/contracts";
import { createRun, WorkflowError, type WorkflowRun } from "../shared/workflow.js";

export class WorkflowRepository {
  constructor(private readonly documents: ExtensionDocumentStore) {}
  private key(canvasId: string, nodeId: string, instanceId: string): string {
    return `run/${encodeURIComponent(canvasId)}/${encodeURIComponent(nodeId)}/${encodeURIComponent(instanceId)}`;
  }
  async read(canvasId: string, nodeId: string, instanceId: string): Promise<WorkflowRun> {
    const found = await this.documents.get(this.key(canvasId, nodeId, instanceId));
    if (!found.found) return createRun(canvasId, nodeId, instanceId);
    const run = structuredClone(found.document.value) as unknown as WorkflowRun;
    if (run.schemaVersion !== 1 || run.canvasId !== canvasId || run.nodeId !== nodeId || run.instanceId !== instanceId) throw new WorkflowError("invalid-run", "制作记录版本或归属不匹配。");
    this.normalize(run);
    run.version = found.document.revision;
    return run;
  }
  async save(run: WorkflowRun): Promise<void> {
    run.updatedAt = new Date().toISOString();
    const result = await this.documents.batch([{ op: "set", key: this.key(run.canvasId, run.nodeId, run.instanceId),
      expectedRevision: run.version === 0 ? null : run.version, value: JSON.parse(JSON.stringify(run)) as ExtensionDocumentValue }]);
    if (!result.ok) throw new WorkflowError("revision-conflict", "制作记录已被其他操作更新，请刷新。");
    run.version = result.revisions[this.key(run.canvasId, run.nodeId, run.instanceId)]!;
  }
  async pending(): Promise<WorkflowRun[]> {
    const runs: WorkflowRun[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.documents.scan("run/", { cursor, limit: 100 });
      for (const entry of page.entries) {
        const run = structuredClone(entry.value) as unknown as WorkflowRun;
        if (run.schemaVersion === 1 && Object.values(run.stages).some(stage => stage.status === "running")) {
          this.normalize(run);
          run.version = entry.revision; runs.push(run);
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return runs;
  }
  private normalize(run: WorkflowRun): void {
    for (const stage of Object.values(run.stages)) {
      stage.input.outputPrompts ??= {};
      stage.input.outputModels ??= {};
      stage.outputIssues ??= {};
      stage.outputs ??= {};
    }
  }
}
