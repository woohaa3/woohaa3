/**
 * `plugin.test.tsx` 的测试夹具（从该文件原样移出，行为不变）。
 *
 * 移出的原因只是 file-budget：`plugin.test.tsx` 曾越过 800 物理行上限，而夹具占了
 * 前一百多行。夹具与用例分离后，读用例不必先翻过一整套 runtime 装配。
 *
 * 生产代码不引用本文件。
 */
import type { Context } from "@deepseek-ai/cordis";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { CompositeAssetRegistry } from "../../../extension-api/composite-assets.js";
import { startFrontendRuntime, type FrontendRuntime } from "../../kernel.js";
import { nodeHistoryExtension, NODE_HISTORY_PLUGIN_ID } from "./plugin.js";
import type { NodeHistoryClient } from "./controller.js";
import { SlotRegistry } from "../../slots.js";
import { InputScopeService } from "../../services/input-scopes.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { DialogService } from "../../services/dialogs/service.js";
import { CanvasNavigationStore } from "../../navigation/store.js";

export type FocusCall = { kind: "enter" | "exit" | "override" | "content"; payload: unknown };

export function fakeCanvasRuntime(focusCalls: FocusCall[]) {
  let focusedNodeId: string | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    modelFocusProjection: () => (focusedNodeId ? { nodeId: focusedNodeId } : null),
    subscribeModelFocus: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    enterModelFocusForNode: () => true,
    setContentRect: (input: unknown) => focusCalls.push({ kind: "content", payload: input }),
    setModelSceneOverride: (input: unknown) => focusCalls.push({ kind: "override", payload: input }),
    setModelSceneOverrideForNode: () => undefined,
    /** 测试钩子：模拟 Escape / 清除选择导致的聚焦退出。 */
    __exitFocus: () => {
      focusedNodeId = null;
      emit();
    },
    /** 测试钩子：模拟进入聚焦。 */
    __enterFocus: (nodeId: string) => {
      focusedNodeId = nodeId;
      emit();
    }
  };
}

export async function makeHarness(input: {
  canvas: ReturnType<typeof createEmptyWoohaa3ServerCanvas>;
  client?: NodeHistoryClient;
  writable?: boolean;
  includeRuntime?: boolean;
  imageEdit?: unknown;
  canvasRemote?: Record<string, unknown>;
}): Promise<{
  runtime: FrontendRuntime;
  slots: SlotRegistry;
  dialogs: DialogService;
  navigation: CanvasNavigationStore;
  focusCalls: FocusCall[];
  fakeRuntime: ReturnType<typeof fakeCanvasRuntime> | null;
}> {
  const slots = new SlotRegistry();
  const inputScopes = new InputScopeService();
  const dialogs = new DialogService();
  const navigation = new CanvasNavigationStore({
    openDialog: (request) => {
      const result = dialogs.open({ dialogId: request.dialogId, payload: request.payload });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    }
  });
  const focusCalls: FocusCall[] = [];
  const fakeRuntime = (input.includeRuntime ?? true) ? fakeCanvasRuntime(focusCalls) : null;
  const instance = await startFrontendRuntime({
    installPlatform: (ctx: Context) => {
      ctx.provide("compositeAssets" as never, new CompositeAssetRegistry() as never);
      ctx.provide("canvasState" as never, { getCanvas: () => woohaa3CanvasStore.getState().canvas, getWorkingCanvas: () => woohaa3CanvasStore.getState().canvas, subscribe: woohaa3CanvasStore.subscribe } as never);
      ctx.provide("slots" as never, slots as never);
      ctx.provide("inputScopes" as never, inputScopes as never);
      ctx.provide("dialogs" as never, dialogs as never);
      ctx.provide("canvasNavigation" as never, navigation as never);
      ctx.provide("taskCatalog" as never, { getState: () => ({ status: "loading" }), subscribe: () => () => undefined } as never);
      ctx.provide("canvasSession" as never, { isWritable: () => input.writable ?? true } as never);
      ctx.provide("canvasRemote" as never, (input.canvasRemote ?? {}) as never);
      if (input.imageEdit !== undefined) ctx.provide("imageEdit" as never, input.imageEdit as never);
      if (fakeRuntime) {
        ctx.provide("canvasRuntime" as never, fakeRuntime as never);
      }
      woohaa3CanvasStore.getState().applyRemoteCanvas(input.canvas as never);
    },
    plugins: [
      {
        id: NODE_HISTORY_PLUGIN_ID,
        required: false,
        plugin: nodeHistoryExtension(input.client ? { client: input.client } : {})
      }
    ]
  });
  return { runtime: instance, slots, dialogs, navigation, focusCalls, fakeRuntime };
}

export function textCanvas() {
  const base = createEmptyWoohaa3ServerCanvas("woohaa3-default-canvas", "2026-09-27T00:00:00.000Z");
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [{ id: "n1", type: "text", position: { x: 0, y: 0 } }] },
    nodeData: { n1: { title: "T" } }
  };
}

/** 图片节点画布：历史预览要落到这个节点（A3 回归）。 */
export function imageCanvas() {
  const base = createEmptyWoohaa3ServerCanvas("woohaa3-default-canvas", "2026-09-27T00:00:00.000Z");
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [{ id: "n1", type: "image", position: { x: 0, y: 0 } }] },
    nodeData: { n1: { title: "海报", outputAssetId: "asset-output", taskStatus: "successed" } },
    assets: [{ id: "asset-output", title: "图片", mediaKind: "image", source: "uploaded", status: "ready", createdAt: "2026-09-27T00:00:00.000Z", metadata: { storageKey: "generation-outputs/current.png", checksum: "a".repeat(64), contentType: "image/png", size: 10 } }]
  } as never;
}

/** 模型节点（`generate`）画布，用于验证聚焦关联行为。 */
export function modelCanvas() {
  const base = createEmptyWoohaa3ServerCanvas("woohaa3-default-canvas", "2026-09-27T00:00:00.000Z");
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [{ id: "m1", type: "model3d", position: { x: 0, y: 0 } }] },
    nodeData: { m1: { title: "M" } }
  };
}
