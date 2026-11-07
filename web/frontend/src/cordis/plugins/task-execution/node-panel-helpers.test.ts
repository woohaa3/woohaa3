/**
 * 身份参考策略的面板阻止原因（change: 2026-11-06-require-identity-reference，任务 2.1）。
 *
 * 覆盖无参考、参考未 ready、参考 ready 与 optional 不受影响四条路径。
 */
import { describe, expect, it } from "vitest";
import type { CanvasTaskCatalog, CanvasTaskCatalogModel, CanvasTaskInputBinding } from "@woohaa3/contracts";
import { IDENTITY_REFERENCE_REQUIRED_REASON } from "@woohaa3/contracts";
import { canvasFixture, imageAsset } from "./test-support/fixtures.js";
import { resolveBlockingReasons } from "./node-panel-helpers.js";

const BINDINGS: CanvasTaskInputBinding[] = [
  {
    field: "referenceImages",
    semantic: "reference-image",
    roles: ["reference_image"],
    mediaKinds: ["image"],
    mediaTypes: ["image/png", "image/jpeg", "image/webp"],
    maxItems: 4,
    valueFormat: "url"
  }
];

const MODEL: CanvasTaskCatalogModel = {
  modelKey: "m",
  providerId: "p",
  providerModelId: "m",
  modelType: "image",
  title: "M",
  interaction: { id: "generic-model", version: 1 },
  inputSchema: {},
  defaultInput: {},
  bindings: BINDINGS,
  taskTimeoutMs: 1000
};

function catalog(): CanvasTaskCatalog {
  return { available: true, models: [MODEL], defaultModels: {} };
}

function canvasWithReference(options: { status?: "ready" | "generating"; title?: string } = {}) {
  return canvasFixture({
    nodes: [
      { id: "up-1", type: "image", data: { outputAssetId: "asset-a" } },
      { id: "target", type: "image", data: {} }
    ],
    edges: [{ id: "e1", source: "up-1", target: "target" }],
    assets: [imageAsset({ id: "asset-a", status: options.status ?? "ready", title: options.title ?? "角色参考" })]
  });
}

function reasons(canvas: ReturnType<typeof canvasWithReference>, referencePolicy: "optional" | "identity-required") {
  return resolveBlockingReasons({
    panelKind: "image-generation",
    nodeId: "target",
    disabledReason: null,
    pendingSelection: false,
    catalog: catalog(),
    catalogState: { status: "ready", catalog: catalog() },
    model: "m",
    canvas,
    panelParameters: {},
    referencePolicy
  });
}

describe("身份参考阻止原因", () => {
  it("identity-required 且没有参考时阻止提交", () => {
    const canvas = canvasFixture({
      nodes: [{ id: "target", type: "image", data: {} }],
      edges: []
    });
    expect(reasons(canvas, "identity-required")).toContain(IDENTITY_REFERENCE_REQUIRED_REASON);
  });

  it("identity-required 且参考未 ready 时阻止提交", () => {
    expect(reasons(canvasWithReference({ status: "generating" }), "identity-required")).toContain(
      IDENTITY_REFERENCE_REQUIRED_REASON
    );
  });

  it("identity-required 且参考 ready 时不产生身份阻止原因", () => {
    expect(reasons(canvasWithReference(), "identity-required")).not.toContain(
      IDENTITY_REFERENCE_REQUIRED_REASON
    );
  });

  it("optional 任务无参考仍可提交", () => {
    const canvas = canvasFixture({
      nodes: [{ id: "target", type: "image", data: {} }],
      edges: []
    });
    expect(reasons(canvas, "optional")).toEqual([]);
  });
});
