import { describe, expect, it } from "vitest";
import { FILM_SET_SHOT_PREVIEW_NODE_TYPE, SHOT_PREVIEW_SCHEMA_VERSION } from "@woohaa3/contracts";
import { filmSetInteractionPolicy } from "./interaction.js";

const preview = { shotPreview: { schemaVersion: SHOT_PREVIEW_SCHEMA_VERSION, filmSetNodeId: "film", clipId: "clip-1" } };

describe("film-set content interaction policy", () => {
  it("declares owner/entity targets for preview hover and double click", () => {
    expect(filmSetInteractionPolicy.isManagedNode(FILM_SET_SHOT_PREVIEW_NODE_TYPE, preview)).toBe(true);
    expect(filmSetInteractionPolicy.hoverPlaybackTarget(FILM_SET_SHOT_PREVIEW_NODE_TYPE, preview)).toEqual({ ownerNodeId: "film", entityId: "clip-1" });
    expect(filmSetInteractionPolicy.doubleClickTarget(FILM_SET_SHOT_PREVIEW_NODE_TYPE, preview)).toEqual({ kind: "shot-preview", nodeId: "film", entityId: "clip-1" });
  });

  it("protects previews and legacy composite nodes from destructive actions", () => {
    expect(filmSetInteractionPolicy.selectionActions("delete", FILM_SET_SHOT_PREVIEW_NODE_TYPE, preview).allowed).toBe(false);
    expect(filmSetInteractionPolicy.selectionActions("copy", "composite-asset", { extensionId: "film-set" }).allowed).toBe(false);
  });
});
