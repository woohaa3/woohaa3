import { expect, it, vi } from "vitest";
import type { CanvasOperationRecord, NodeGenerationHistoryListItem } from "@woohaa3/contracts";
import { ExecutionPreview } from "./execution-preview.js";
import { VersionSelectionController, type VersionApplyResult } from "./version-selection.js";

const item = (id: string, current = false, outcome: NodeGenerationHistoryListItem["outcome"] = "succeeded"): NodeGenerationHistoryListItem => ({
  entryId: id, kind: "image", createdAt: id, current, recoverable: outcome === "succeeded", previewable: true,
  outcome, source: { runId: `run-${id}`, label: id }, preview: { kind: "image", href: `/preview/${id}` }
});
const operation = (id: string, state: CanvasOperationRecord["state"] = "running"): CanvasOperationRecord =>
  ({ nodeId: "n", operationId: id, state, createdAt: id, updatedAt: id, canvasId: "c", kind: "image", owner: "server" } as CanvasOperationRecord);

function setup(items = [item("a"), item("b", true), item("c")]) {
  const history = new Map([["n", items]]);
  const selected = new Map<string, string>();
  const preview = new ExecutionPreview(() => history, vi.fn(), undefined, undefined, undefined, () => selected);
  const apply = vi.fn(async (_nodeId: string, _entryId: string): Promise<VersionApplyResult> => ({ ok: true }));
  const markSeenEntry = vi.fn();
  const markSettledSeen = vi.fn();
  const onApplyError = vi.fn();
  const controller = new VersionSelectionController({
    selected, items: nodeId => history.get(nodeId), preview, apply,
    refreshNode: async () => {}, markSeenEntry, markSettledSeen, onApplyError, onChange: vi.fn()
  });
  return { history, selected, preview, controller, apply, markSeenEntry, markSettledSeen, onApplyError };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

it("activates a completed non-current success and leaves current or red dots as preview only", async () => {
  const { selected, controller, apply } = setup();
  controller.activate({ nodeId: "n", entryId: "c" }); await flush();
  expect(apply).toHaveBeenCalledWith("n", "c");
  expect(selected.get("n")).toBe("operation:run-c");
  controller.activate({ nodeId: "n", entryId: "b" }); await flush();
  controller.activate({ nodeId: "n", entryId: "a" }); await flush();
  expect(apply).toHaveBeenCalledTimes(2);
  expect(selected.get("n")).toBe("operation:run-a");
});

it("does not apply failed entries and surfaces a guard failure without moving the current version", async () => {
  const failed = item("failed", false, "failed");
  const history = new Map([["n", [item("a", true), item("c"), failed]]]);
  const selected = new Map<string, string>();
  const preview = new ExecutionPreview(() => history, vi.fn(), undefined, undefined, undefined, () => selected);
  const apply = vi.fn(async (): Promise<VersionApplyResult> => ({ ok: true }));
  const onApplyError = vi.fn();
  const controller = new VersionSelectionController({
    selected, items: nodeId => history.get(nodeId), preview, apply,
    refreshNode: async () => {}, markSeenEntry: vi.fn(), markSettledSeen: vi.fn(), onApplyError, onChange: vi.fn(),
    canActivate: () => ({ ok: false, reason: "请先保存当前草稿" })
  });
  controller.activate({ nodeId: "n", entryId: "failed" }); await flush();
  expect(apply).not.toHaveBeenCalled();
  expect(onApplyError).not.toHaveBeenCalled();
  expect(selected.get("n")).toBe("operation:run-failed");
  controller.activate({ nodeId: "n", entryId: "c" }); await flush();
  expect(apply).not.toHaveBeenCalled();
  expect(onApplyError).toHaveBeenCalledWith({ nodeId: "n", error: "请先保存当前草稿" });
  expect(selected.get("n")).toBe("operation:run-c");
});

it("selects an unarchived running identity instead of falling back to a neighbouring green", async () => {
  const { selected, controller, apply } = setup();
  controller.activate({ nodeId: "n", presentationId: "operation:run-new", operationId: "run-new" }); await flush();
  expect(apply).not.toHaveBeenCalled();
  expect(selected.get("n")).toBe("operation:run-new");
});

it("pins an explicit selection so new running tasks cannot steal it", () => {
  const { selected, controller } = setup();
  controller.select({ nodeId: "n", presentationId: "operation:run-b" });
  controller.observeRunState([operation("new-task")]);
  expect(selected.get("n")).toBe("operation:run-b");
});

it("auto-follows a running task before any explicit selection and keeps its failure visible", () => {
  const { selected, preview, controller } = setup();
  controller.observeRunState([operation("run-new")]);
  expect(selected.get("n")).toBe("operation:run-new");
  controller.observeRunState([{ ...operation("run-new", "failed"), error: "provider 超时" }]);
  const projected = preview.project({
    version: 1, canvasId: "c", document: { nodes: [{ id: "n", type: "image", position: { x: 0, y: 0 } }] },
    nodeData: { n: { outputAssetId: "old" } }, assets: []
  } as never)!.nodeData.n as Record<string, unknown>;
  expect(projected.historyPreviewFailure).toEqual({ outcome: "failed", message: "provider 超时" });
  expect(projected.outputAssetId).toBeUndefined();
});

it("queues the latest activation while an apply is still in flight", async () => {
  const { controller, apply } = setup();
  let finish!: (value: VersionApplyResult) => void;
  apply.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  controller.activate({ nodeId: "n", entryId: "a" }); await flush();
  controller.activate({ nodeId: "n", entryId: "c" }); await flush();
  expect(apply).toHaveBeenCalledTimes(1);
  finish({ ok: true }); await flush();
  expect(apply).toHaveBeenLastCalledWith("n", "c");
});
