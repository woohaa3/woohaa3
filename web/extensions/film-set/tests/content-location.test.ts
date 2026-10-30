import { ContentContributionRegistry, createFilmSetGroupMarker, locateContentNode } from "@woohaa3/contracts";
import { describe, expect, it } from "vitest";
import { filmSetContentContribution } from "../src/state/shared/content/contribution.js";
import { filmSetInteractionPolicy } from "../src/state/shared/content/interaction.js";
import { filmSetOwnerLocators } from "../src/state/shared/content/locators.js";

describe("film-set owner location", () => {
  it("locates the current group marker without changing its persisted shape", () => {
    const registry = new ContentContributionRegistry();
    registry.register({ ...filmSetContentContribution, interaction: filmSetInteractionPolicy, ownerLocators: filmSetOwnerLocators });
    const marker = createFilmSetGroupMarker({ sceneBindings: [] });
    expect(locateContentNode(registry, "group", { filmSetGroup: marker })).toEqual({
      ok: true,
      location: { extensionId: "film-set", sources: ["locator", "group"] }
    });
    expect(locateContentNode(registry, "group", {})).toEqual({ ok: true, location: null });
  });
});
