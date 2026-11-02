import { expect, it } from "vitest";
import type { NodeGenerationHistoryListItem } from "@woohaa3/contracts";
import { HistorySeenStore, type SeenStorage } from "./seen-store.js";

const item = (id: string, createdAt = id, outcome: NodeGenerationHistoryListItem["outcome"] = "succeeded"): NodeGenerationHistoryListItem => ({
  entryId: id, kind: "image", createdAt, current: false, recoverable: true, previewable: true,
  outcome, source: { label: id }, preview: { kind: "text", excerpt: id }
});
const memory = (): SeenStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
};

it("baselines existing history at the newest entry and an empty node at page-open time", () => {
  const store = new HistorySeenStore("c", { storage: memory(), now: () => "2026-01-01T00:00:00.000Z" });
  store.baselineNode("existing", [item("a"), item("b")]);
  expect(store.seenAtOf("existing")).toBe("b");
  store.baselineNode("empty", []);
  expect(store.seenAtOf("empty")).toBe("2026-01-01T00:00:00.000Z");
  expect(store.unseenFor("empty", [item("first", "2026-01-01T00:00:01.000Z")]).has("first")).toBe(true);
});

it("marks a selected entry and all known entries seen, persisting across instances", () => {
  const storage = memory();
  const first = new HistorySeenStore("c", { storage, now: () => "2026-01-01T00:00:00.000Z" });
  first.baselineNode("n", [item("a")]);
  first.markEntry("n", item("b"));
  expect(first.unseenFor("n", [item("a"), item("b")]).size).toBe(0);
  const second = new HistorySeenStore("c", { storage, now: () => "2026-01-01T00:00:00.000Z" });
  expect(second.seenAtOf("n")).toBe("b");
  second.markNode("n", [item("a"), item("c")]);
  expect(second.seenAtOf("n")).toBe("c");
});

it("keeps failed terminal entries out of the unseen set", () => {
  const store = new HistorySeenStore("c", { storage: memory(), now: () => "2026-01-01T00:00:00.000Z" });
  store.baselineNode("n", [item("a")]);
  expect(store.unseenFor("n", [item("a"), item("failed", "z", "failed")]).size).toBe(0);
});
