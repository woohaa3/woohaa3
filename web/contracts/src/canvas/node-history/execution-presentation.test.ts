import { expect, it } from "vitest";
import { mergeNodeExecutionPresentation, nodeExecutionWindow, showNodeExecutionDots } from "./execution-presentation.js";
import type { CanvasOperationRecord } from "../run-state/types.js";
import type { NodeGenerationHistoryListItem } from "./types.js";
const operation = (state: CanvasOperationRecord["state"], id = "run-1"): CanvasOperationRecord => ({
  operationId: id, canvasId: "canvas", nodeId: "node", kind: "image", owner: "server", state,
  createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:01Z"
});
const entry = (overrides: Partial<NodeGenerationHistoryListItem> = {}): NodeGenerationHistoryListItem => ({
  entryId: "entry-1", kind: "image", createdAt: "2026-10-20T00:00:02Z", outcome: "succeeded",
  current: true, recoverable: true, previewable: true, source: { label: "Image generation", runId: "run-1" },
  preview: { kind: "image", href: "/preview" }, ...overrides
});
it("hands success to archive without changing identity, current or recovery before archive", () => {
  const pending = mergeNodeExecutionPresentation([operation("succeeded")], []);
  expect(pending[0]).toMatchObject({ current: false, recoverable: false, presentationId: "operation:run-1" });
  expect(showNodeExecutionDots(pending)).toBe(true);
  for (const records of [[operation("running")], [operation("succeeded"), operation("queued")]]) {
    const archived = mergeNodeExecutionPresentation(records, [entry(), entry()]);
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ presentationId: pending[0]!.presentationId, entryId: "entry-1", state: "succeeded", current: true, recoverable: true });
    expect(showNodeExecutionDots(archived)).toBe(false);
  }
});
it("does not guess agent, local or edit associations from timestamps or labels", () => {
  const records = [operation("running", "agent:turn-1"), { ...operation("failed", "local-capture"), owner: "local" as const }];
  const merged = mergeNodeExecutionPresentation(records, [entry({ source: { label: "same time", sourceHash: "model-hash" } })]);
  expect(merged).toHaveLength(3);
  expect(merged.filter(item => item.current)).toHaveLength(1);
});
it("failed archive remains visible and never becomes current or recoverable", () => {
  const failed = mergeNodeExecutionPresentation([operation("running")], [entry({ outcome: "failed", recoverable: false, preview: { kind: "failure", outcome: "failed", message: "Safe reason" } })]);
  expect(failed[0]).toMatchObject({ state: "failed", current: false, recoverable: false, error: "Safe reason" });
  expect(showNodeExecutionDots(failed)).toBe(true);
});
it("retains current, active and latest failure in the bounded chronological window", () => {
  const items = mergeNodeExecutionPresentation(Array.from({ length: 60 }, (_, index) => ({
    ...operation(index === 1 ? "failed" : index === 2 ? "running" : "succeeded", String(index)),
    createdAt: String(index).padStart(3, "0")
  })), []);
  items[0]!.current = true;
  const window = nodeExecutionWindow(items);
  expect(window).toHaveLength(24);
  expect(window.slice(0, 3).map(item => item.operationId)).toEqual(["0", "1", "2"]);
  expect(window.map(item => item.createdAt)).toEqual(window.map(item => item.createdAt).sort());
});
it("rejected submissions are page-only facts with no archive identity", () => {
  const rejected = mergeNodeExecutionPresentation([{ ...operation("failed"), localFailure: true, error: "Denied" }], []);
  expect(rejected[0]).toMatchObject({ localFailure: true, recoverable: false, error: "Denied" });
  expect(rejected[0]?.entryId).toBeUndefined();
  expect(mergeNodeExecutionPresentation([], [])).toEqual([]);
});
