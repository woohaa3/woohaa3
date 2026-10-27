import { describe, expect, it } from "vitest";
import { applyCanvasCommands } from "./command-reducer.js";
import {
  ContentContributionRegistry,
  EMPTY_CONTENT_RESOLVER,
  type ContentContribution
} from "./content-contribution.js";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";
import { planCanvasEdit } from "./edit-plan.js";
import { normalizeCanvas } from "./domain/normalization.js";
import { sanitizeNodeDataForClipboard } from "./domain/runtime-node-data.js";
import { buildCanvasRenderScene } from "./render-scene/scene-builder.js";

const film: ContentContribution = { extensionId: "film-set" };
const furnace: ContentContribution = { extensionId: "game-furnace" };

describe("content contribution registry", () => {
  it("rejects a duplicate extension id and keeps the first contribution", () => {
    const registry = new ContentContributionRegistry();
    registry.register(film);
    expect(() => registry.register({ extensionId: "film-set" })).toThrow(/content-registration-conflict/);
    expect(registry.resolve("film-set")).toBe(film);
    expect(() => registry.register({ extensionId: "Film_Set" })).toThrow(/content-registration-invalid/);
  });

  it("replaces nothing when the same disposer runs again after a new registration", () => {
    const registry = new ContentContributionRegistry();
    const release = registry.register(film);
    expect(registry.resolve("film-set")).toBe(film);
    release();
    release();
    const next: ContentContribution = { extensionId: "film-set" };
    registry.register(next);
    release();
    expect(registry.resolve("film-set")).toBe(next);
  });

  it("rolls back an activation in reverse order when a later contribution conflicts", () => {
    const registry = new ContentContributionRegistry();
    expect(() => registry.activate([film, furnace, { extensionId: "film-set" }])).toThrow(/content-registration-conflict/);
    expect(registry.implementations()).toEqual([]);
    expect(registry.resolve("film-set")).toBeNull();
    expect(registry.resolve("game-furnace")).toBeNull();
  });

  it("does not return a cached contribution after release or before the next registration", () => {
    const registry = new ContentContributionRegistry();
    expect(registry.resolve("film-set")).toBeNull();
    const release = registry.register(film);
    expect(registry.resolve("film-set")).toBe(film);
    release();
    expect(registry.resolve("film-set")).toBeNull();
    const next: ContentContribution = { extensionId: "film-set" };
    registry.register(next);
    expect(registry.resolve("film-set")).toBe(next);
    expect(registry.resolve("film-set")).not.toBe(film);
  });

  it("rejects a later contribution that reuses a tool name or route", () => {
    const registry = new ContentContributionRegistry();
    registry.register({
      extensionId: "film-set",
      mcpTools: [{ name: "import_content", title: "导入", description: "导入", inputSchema: {}, handle: () => ({ ok: true }) }],
      routes: [{ method: "POST", path: ["import"], handle: () => ({ status: 204 }) }]
    });
    expect(() => registry.register({
      extensionId: "game-furnace",
      mcpTools: [{ name: "import_content", title: "导入", description: "导入", inputSchema: {}, handle: () => ({ ok: true }) }]
    })).toThrow(/content-tool-conflict/);
    expect(() => registry.register({
      extensionId: "game-furnace",
      routes: [{ method: "POST", path: ["import"], handle: () => ({ status: 204 }) }]
    })).toThrow(/content-route-conflict/);
    expect(registry.resolve("game-furnace")).toBeNull();
    expect(registry.resolve("film-set")?.extensionId).toBe("film-set");
  });
});

describe("content resolver seam", () => {
  it("keeps existing command, edit, normalize, copy and scene results when the resolver is empty", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("canvas", "2026-10-27T00:00:00.000Z");
    const commands = [{ type: "canvas.setTitle" as const, title: "标题" }];
    const plain = applyCanvasCommands(canvas, commands, { now: "2026-10-27T00:00:00.000Z" });
    const withResolver = applyCanvasCommands(canvas, commands, { now: "2026-10-27T00:00:00.000Z", content: EMPTY_CONTENT_RESOLVER });
    expect(withResolver).toEqual(plain);
    expect(planCanvasEdit(canvas, commands, { content: EMPTY_CONTENT_RESOLVER }).ok).toBe(planCanvasEdit(canvas, commands).ok);
    expect(normalizeCanvas(canvas, { content: EMPTY_CONTENT_RESOLVER })).toEqual(normalizeCanvas(canvas));
    expect(sanitizeNodeDataForClipboard({ title: "标题", prompt: "保持" }, { content: EMPTY_CONTENT_RESOLVER })).toEqual(
      sanitizeNodeDataForClipboard({ title: "标题", prompt: "保持" })
    );
    expect(buildCanvasRenderScene({ canvas, content: EMPTY_CONTENT_RESOLVER }).version).toBe(buildCanvasRenderScene({ canvas }).version);
  });
});
