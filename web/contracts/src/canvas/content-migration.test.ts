import { describe, expect, it } from "vitest";
import { ContentContributionRegistry, type ContentContribution } from "./content-contribution.js";
import { migrateCanvasContent } from "./content-migration.js";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";

function contribution(migrations: ContentContribution["migrations"]): ContentContribution {
  return {
    extensionId: "test-migrate",
    version: {
      read: (data) => {
        const value = (data as { version?: unknown }).version;
        return typeof value === "number" ? value : null;
      },
      write: (data, version) => ({ ...(data as Record<string, unknown>), version })
    },
    migrations
  };
}

function canvas(version: number) {
  const result = createEmptyWoohaa3ServerCanvas("canvas");
  result.document.nodes.push({ id: "node", type: "composite-asset", position: { x: 0, y: 0 } });
  result.nodeData.node = { extensionId: "test-migrate", version, value: "old" };
  return result;
}

function registry(migrations: ContentContribution["migrations"]): ContentContributionRegistry {
  const result = new ContentContributionRegistry();
  result.register(contribution(migrations));
  return result;
}

const chain: ContentContribution["migrations"] = [
  { extensionId: "test-migrate", from: 1, to: 2, migrate: (data) => ({ ...(data as object), value: "v2" }) },
  { extensionId: "test-migrate", from: 2, to: 3, migrate: (data) => ({ ...(data as object), value: "v3" }) }
];

describe("owner content migrations", () => {
  it("runs the chain in order and writes the final version", () => {
    const result = migrateCanvasContent(canvas(1), registry(chain));
    expect(result.changed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.canvas.nodeData.node).toEqual({ extensionId: "test-migrate", version: 3, value: "v3" });
    expect(result.migrated).toEqual([{ nodeId: "node", extensionId: "test-migrate", from: 1, to: 3 }]);
  });

  it("does not advance on a broken chain", () => {
    const broken: ContentContribution["migrations"] = [chain[1]!];
    const result = migrateCanvasContent(canvas(1), registry(broken));
    expect(result.changed).toBe(false);
    expect(result.failures).toEqual([{ nodeId: "node", extensionId: "test-migrate", code: "content-migration-chain-missing", from: 1, to: 3 }]);
    expect(result.canvas.nodeData.node).toEqual({ extensionId: "test-migrate", version: 1, value: "old" });
  });

  it("keeps a too-new node read-only without downgrading it", () => {
    const result = migrateCanvasContent(canvas(9), registry(chain));
    expect(result.changed).toBe(false);
    expect(result.readonlyNodeIds.has("node")).toBe(true);
    expect(result.failures[0]?.code).toBe("content-migration-too-new");
    expect(result.canvas.nodeData.node).toEqual({ extensionId: "test-migrate", version: 9, value: "old" });
  });

  it("rolls back a throwing step and does not write the version", () => {
    const throwing: ContentContribution["migrations"] = [
      chain[0]!,
      { extensionId: "test-migrate", from: 2, to: 3, migrate: () => { throw new Error("boom"); } }
    ];
    const result = migrateCanvasContent(canvas(1), registry(throwing));
    expect(result.changed).toBe(false);
    expect(result.failures[0]?.code).toBe("content-migration-failed");
    expect(result.canvas.nodeData.node).toEqual({ extensionId: "test-migrate", version: 1, value: "old" });
  });
});
