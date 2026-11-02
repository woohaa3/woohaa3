import { expect, it } from "vitest";
import type { NodeGenerationHistoryListItem } from "@woohaa3/contracts";
import {
  presentationOfItem,
  refFromPresentation,
  resolveVersionItem,
  unseenEntryIds
} from "./version-model.js";

const item = (id: string, current = false, outcome: NodeGenerationHistoryListItem["outcome"] = "succeeded"): NodeGenerationHistoryListItem => ({
  entryId: id, kind: "image", createdAt: id, current, recoverable: true, previewable: true,
  outcome, source: { runId: `run-${id}`, label: id }, preview: { kind: "image", href: `/preview/${id}` }
});

it("maps version identities to stable presentation ids in both directions", () => {
  expect(presentationOfItem(item("a"))).toBe("operation:run-a");
  expect(presentationOfItem({ ...item("b"), source: { label: "b" } })).toBe("entry:b");
  expect(refFromPresentation("operation:run-a")).toEqual({ kind: "operation", operationId: "run-a" });
  expect(refFromPresentation("entry:b")).toEqual({ kind: "entry", entryId: "b" });
  expect(refFromPresentation("current")).toBeNull();
  expect(refFromPresentation(undefined)).toBeNull();
});

it("resolves explicit entries, presentations and relative steps without inventing identities", () => {
  const items = [item("a"), item("b", true), item("c")];
  expect(resolveVersionItem(items, { nodeId: "n", entryId: "c" }, undefined)?.entryId).toBe("c");
  expect(resolveVersionItem(items, { nodeId: "n", presentationId: "operation:run-a" }, undefined)?.entryId).toBe("a");
  expect(resolveVersionItem(items, { nodeId: "n", step: 1 }, undefined)?.entryId).toBe("c");
  expect(resolveVersionItem(items, { nodeId: "n", step: -1 }, "operation:run-c")?.entryId).toBe("b");
  expect(resolveVersionItem(items, { nodeId: "n", entryId: "missing" }, undefined)).toBeUndefined();
});

it("marks only successful entries newer than the seen baseline", () => {
  const items = [item("a"), item("b"), item("failed", false, "failed"), item("cancelled", false, "cancelled")];
  expect([...unseenEntryIds(items, "a")]).toEqual(["b"]);
  expect(unseenEntryIds(items, "b").size).toBe(0);
  expect(unseenEntryIds(items, undefined).size).toBe(0);
});
