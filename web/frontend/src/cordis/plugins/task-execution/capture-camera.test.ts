/**
 * T10 capture-source ownership regression.
 *
 * The production ModelExecutionHost must treat capture framing as explicit-only:
 * a world-camera card that happens to exist on the canvas must not change an
 * ordinary image submission, regardless of node order or camera binding. The
 * explicit `captureCameraId` prop remains the only generation-entry selection.
 *
 * @vitest-environment jsdom
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CanvasTaskCatalog } from "@woohaa3/contracts";
import { explicitWorldCaptureSelection } from "./capture-camera.js";
import { ModelExecutionHost } from "./model-execution-host.js";
import { createModelDraftStore } from "./model-draft.js";
import { nodeDraftStore } from "./drafts.js";
import type { ModelPanelProps } from "../../contract/model-interaction.js";
import { catalogFixture, canvasFixture } from "./test-support/fixtures.js";
import { ModelInteractionService } from "../../services/model-interaction-service.js";
import { DialogService } from "../../services/dialogs/service.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import type { CatalogState, TaskCatalogService } from "../../contracts.js";
import type { SubmitInput } from "./submit-coordinator.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IMAGE_NODE_ID = "image-node";

class StubCatalogService implements TaskCatalogService {
  private listeners = new Set<() => void>();
  private state: CatalogState;

  constructor(catalog: CanvasTaskCatalog) {
    this.state = { status: "ready", catalog };
  }

  getState = (): CatalogState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  load = async (): Promise<void> => undefined;
  invalidate = (): void => undefined;
}

const CATALOG = catalogFixture([
  { modelKey: "image-model", modelType: "image", interaction: { id: "test-panel", version: 1 } }
]);

type CameraSpec = { nodeId: string; cameraId: string; bound?: string };

function worldCamera(camera: CameraSpec) {
  return {
    kind: "world-camera",
    version: "shared-world-v1",
    cameraId: camera.cameraId,
    settingsVersion: `${camera.cameraId}-v1`,
    position: { u: 0, v: 0, h: 1 },
    rotation: [0, 0, 0, 1],
    projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
    captureMode: { kind: "static" },
    aspect: { width: 16, height: 9 },
    ...(camera.bound ? { boundInstanceId: camera.bound } : {})
  };
}

/** Plain image node plus unrelated world-camera cards in the requested order. */
function canvasWithUnrelatedCameras(cameras: CameraSpec[], cameraFirst = false) {
  const image = { id: IMAGE_NODE_ID, type: "image", data: { prompt: "draw a cat" } };
  const cameraNodes = cameras.map(camera => ({
    id: camera.nodeId,
    type: "world-camera",
    data: { worldCamera: worldCamera(camera) } as never
  }));
  return canvasFixture({ nodes: cameraFirst ? [...cameraNodes, image] : [image, ...cameraNodes] });
}

function registryWithPanel(): { registry: ModelInteractionService; panel: () => ModelPanelProps | undefined } {
  const registry = new ModelInteractionService();
  let captured: ModelPanelProps | undefined;
  registry.register({
    id: "test-panel",
    version: 1,
    owner: "test",
    Panel: props => {
      captured = props;
      return createElement("output", null, props.draft.prompt);
    }
  });
  return { registry, panel: () => captured };
}

let root: Root | null = null;

async function mountHost(input: {
  captureCameraId?: string;
  submit: (value: SubmitInput) => Promise<{ ok: true; runId: string; jobId: string }>;
}) {
  const { registry, panel } = registryWithPanel();
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(ModelExecutionHost, {
      canvasId: "canvas-1",
      selectedNodeId: IMAGE_NODE_ID,
      session: {} as never,
      runClient: {} as never,
      writable: true,
      dialogs: new DialogService(),
      catalog: new StubCatalogService(CATALOG),
      registry,
      draftStore: createModelDraftStore(),
      submitCoordinator: { submit: input.submit, cancel: vi.fn(async () => ({ ok: true as const })) },
      ...(input.captureCameraId ? { captureCameraId: input.captureCameraId } : {})
    }));
  });
  const panelProps = panel();
  if (!panelProps) throw new Error("image panel did not render");
  return { panel: panelProps, container };
}

beforeEach(() => {
  nodeDraftStore.clearAll();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  nodeDraftStore.clearAll();
  document.body.innerHTML = "";
});

describe("T10 generation capture selection is explicit-only", () => {
  it("returns no selection unless the caller passes an explicit camera id", () => {
    expect(explicitWorldCaptureSelection(undefined)).toBeUndefined();
    expect(explicitWorldCaptureSelection("")).toBeUndefined();
    expect(explicitWorldCaptureSelection("camera-A")).toEqual({ cameraId: "camera-A" });
  });

  it("does not scan unrelated cameras or change media input for a plain image", async () => {
    const cameras: CameraSpec[] = [
      { nodeId: "camera-bound", cameraId: "camera-bound", bound: "instance-1" },
      { nodeId: "camera-world", cameraId: "camera-world" }
    ];
    for (const cameraFirst of [false, true]) {
      woohaa3CanvasStore.getState().hydrate(canvasWithUnrelatedCameras(cameras, cameraFirst));
      const submit = vi.fn(async (_input: SubmitInput) => ({ ok: true as const, runId: "run-1", jobId: "job-1" }));
      const { panel } = await mountHost({ submit });
      const parameters = { seed: 7, referenceImages: ["existing-reference"] };
      let outcome!: Awaited<ReturnType<ModelPanelProps["submit"]>>;
      await act(async () => {
        outcome = await panel.submit({ prompt: "draw a cat", parameters });
      });
      expect(outcome).toMatchObject({ ok: true });
      expect(submit).toHaveBeenCalledOnce();
      expect(submit.mock.calls[0]![0]).toMatchObject({
        nodeId: IMAGE_NODE_ID,
        prompt: "draw a cat",
        parameters
      });
      expect(submit.mock.calls[0]![0].worldCapture).toBeUndefined();
      await act(async () => {
        root?.unmount();
      });
      root = null;
      document.body.innerHTML = "";
    }
  });

  it("keeps the explicitly selected camera when another camera also exists", async () => {
    woohaa3CanvasStore.getState().hydrate(canvasWithUnrelatedCameras([
      { nodeId: "camera-a", cameraId: "camera-A" },
      { nodeId: "camera-b", cameraId: "camera-B", bound: "instance-2" }
    ]));
    const submit = vi.fn(async (_input: SubmitInput) => ({ ok: true as const, runId: "run-1", jobId: "job-1" }));
    const { panel } = await mountHost({ captureCameraId: "camera-A", submit });
    await act(async () => {
      await panel.submit({ prompt: "draw a cat", parameters: { seed: 3 } });
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]![0].worldCapture).toEqual({ cameraId: "camera-A" });
  });
});
