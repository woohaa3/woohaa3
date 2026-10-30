import { describe, expect, it } from "vitest";
import { ContentContributionRegistry } from "./content-contribution.js";
import { locateContentNode } from "./content-location.js";

const groupOwner = {
  extensionId: "test.group",
  ownerLocators: [{ nodeTypes: ["group"], fields: ["testGroup"] }],
  interaction: {
    isManagedNode: (type: string, data: unknown) => type === "group" && typeof data === "object" && data !== null && "testGroup" in data,
    selectionActions: () => ({ allowed: true as const }),
    hoverPlaybackTarget: () => null,
    doubleClickTarget: () => null
  }
};

describe("unified content owner location", () => {
  it("locates composite, managed and extension group declarations without authorizing them", () => {
    const registry = new ContentContributionRegistry();
    registry.register(groupOwner);
    expect(locateContentNode(registry, "composite-asset", { extensionId: "inactive.owner" })).toEqual({
      ok: true,
      location: { extensionId: "inactive.owner", sources: ["composite"] }
    });
    expect(locateContentNode(registry, "image", {
      managedBy: { schemaVersion: 1, extensionId: "test.group", ownerNodeId: "owner", entityId: "entity-1", lifecycle: "owner-managed" }
    })).toEqual({
      ok: true,
      location: { extensionId: "test.group", sources: ["managed"], entityId: "entity-1", ownerNodeId: "owner" }
    });
    expect(locateContentNode(registry, "group", { testGroup: { version: 1 } })).toEqual({
      ok: true,
      location: { extensionId: "test.group", sources: ["locator", "group"] }
    });
  });

  it("keeps ordinary groups unowned and rejects conflicting or malformed declarations", () => {
    const registry = new ContentContributionRegistry();
    registry.register(groupOwner);
    expect(locateContentNode(registry, "group", {})).toEqual({ ok: true, location: null });
    expect(locateContentNode(registry, "composite-asset", {
      extensionId: "inactive.owner",
      managedBy: { schemaVersion: 1, extensionId: "test.group", ownerNodeId: "owner", entityId: "entity-1", lifecycle: "owner-managed" }
    })).toEqual({ ok: false, code: "content-location-conflict" });
    expect(locateContentNode(registry, "image", { managedBy: { schemaVersion: 1, extensionId: "Bad Id" } })).toEqual({
      ok: false,
      code: "content-location-invalid"
    });
    expect(locateContentNode(registry, "composite-asset", { extensionId: "Bad Id" })).toEqual({
      ok: false,
      code: "content-location-invalid"
    });
  });

  it("uses a serialized locator even without an interaction policy", () => {
    const registry = new ContentContributionRegistry();
    registry.register({ extensionId: "test.locator", ownerLocators: [{ nodeTypes: ["group"], fields: ["testGroup"] }] });
    expect(locateContentNode(registry, "group", { testGroup: {} })).toEqual({
      ok: true,
      location: { extensionId: "test.locator", sources: ["locator"] }
    });
  });

  it("retains the last verified locator after the contribution is released", () => {
    const registry = new ContentContributionRegistry();
    const release = registry.register({ extensionId: "test.locator", ownerLocators: [{ nodeTypes: ["group"], fields: ["testGroup"] }] });
    release();
    expect(registry.resolve("test.locator")).toBeNull();
    expect(locateContentNode(registry, "group", { testGroup: {} })).toEqual({
      ok: true,
      location: { extensionId: "test.locator", sources: ["locator"] }
    });
  });
});
