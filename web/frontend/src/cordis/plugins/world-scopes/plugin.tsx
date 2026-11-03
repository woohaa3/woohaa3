import type { Context, Plugin } from "@deepseek-ai/cordis";
import { definePlugin } from "../../plugin.js";
import { installWorldScopeGestureControls } from "./gesture-controls.js";
import { ScopeContext } from "./presentation.js";

export const WORLD_SCOPES_PLUGIN_ID = "world-scopes";

// Existing tests and page wiring import the component from the plugin entry.
export { ScopeContext } from "./presentation.js";

export function worldScopesExtension(canvasId: string | undefined): Plugin.Function<void> {
  return definePlugin((ctx: Context) => {
    const remove = ctx.slots.register("canvas.overlay", {
      id: WORLD_SCOPES_PLUGIN_ID, owner: WORLD_SCOPES_PLUGIN_ID, priority: 25,
      render: () => <ScopeContext ctx={ctx} canvasId={canvasId} />
    });
    ctx.effect(() => remove, "world-scopes-overlay");
    // Scene-area gestures and 2D-group controls are an independent module owned by the
    // gestures package; this plugin only installs and disposes them with the page scope.
    const disposeGestures = installWorldScopeGestureControls(ctx, canvasId);
    ctx.effect(() => disposeGestures, "world-scope-gesture-controls");
  }, {
    name: WORLD_SCOPES_PLUGIN_ID,
    inject: ["slots", "canvasRemote", "canvasRuntime", "canvasSession", "canvasEdit"]
  });
}
