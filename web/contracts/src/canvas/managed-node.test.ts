import { describe, expect, it } from "vitest";
import { decodeManagedNodeRelation, managedNodeRelationOf, nodePolicy, partitionManagedNodeDeletion } from "./managed-node.js";

describe("managed node relation", () => {
  const valid = { schemaVersion: 1, extensionId: "test.extension", ownerNodeId: "owner", entityId: "clip-1", lifecycle: "owner-managed" };
  it("accepts the neutral versioned shape and keeps ordinary nodes independent", () => {
    expect(decodeManagedNodeRelation(valid)).toEqual({ ok: true, value: valid });
    expect(nodePolicy({})).toEqual({ canDeleteIndependently: true, lifecycle: "independent" });
    expect(nodePolicy({ managedBy: valid })).toEqual({ canDeleteIndependently: false, lifecycle: "owner-managed" });
  });
  it("rejects malformed, self-referential, and unknown lifecycle values", () => {
    expect(decodeManagedNodeRelation({ ...valid, schemaVersion: 2 }).ok).toBe(false);
    expect(decodeManagedNodeRelation({ ...valid, ownerNodeId: "" }).ok).toBe(false);
    expect(decodeManagedNodeRelation({ ...valid, lifecycle: "independent" }).ok).toBe(false);
    expect(managedNodeRelationOf({ managedBy: { ...valid, entityId: "bad id" } })).toBeNull();
  });
  it("uses persistent relations for mixed selections, owners and group cascades without a registered extension", () => {
    const nodes = [{ id: "group" }, { id: "owner", parentId: "group" }, { id: "child", parentId: "group" }, { id: "ordinary" }];
    const data = { child: { managedBy: valid } };
    expect(partitionManagedNodeDeletion(nodes, data, ["child", "ordinary"])).toEqual({ allowed: ["ordinary"], blocked: ["child"] });
    expect(partitionManagedNodeDeletion(nodes, data, ["owner", "child"]).blocked).toEqual([]);
    expect(partitionManagedNodeDeletion(nodes, data, ["group"]).allowed).toEqual(["group"]);
    expect(partitionManagedNodeDeletion([{ id: "owner" }, { id: "group" }, { id: "child", parentId: "group" }], data, ["group", "ordinary"]).allowed).toEqual([]);
  });
});

