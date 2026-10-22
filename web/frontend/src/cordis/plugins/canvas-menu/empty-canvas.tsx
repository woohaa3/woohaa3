import { useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { Button } from "../../../shared/ui/Button.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { IMPORT_SERVICE, type ImportService } from "../service-keys.js";

const noopSubscribe = () => () => {};

/** First-run actions share the existing menu and import owners. */
export function EmptyCanvas({ ctx, writable, modalActive }: { ctx: Context; writable: boolean; modalActive?: boolean }) {
  const empty = useSyncExternalStore(woohaa3CanvasStore.subscribe,
    () => workingCanvasOf(woohaa3CanvasStore.getState())?.document.nodes.length === 0);
  const runtime = useSyncExternalStore(ctx.canvasRuntime.subscribe, ctx.canvasRuntime.getStatus);
  const session = useSyncExternalStore(ctx.canvasSession.subscribe, ctx.canvasSession.getStatus);
  const presentation = useSyncExternalStore(ctx.canvasNavigation.subscribe, ctx.canvasNavigation.getSnapshot);
  const importer = ctx.get(IMPORT_SERVICE) as ImportService | undefined;
  const uploading = useSyncExternalStore(importer?.subscribe ?? noopSubscribe, () => importer?.getState().uploading ?? false);
  if (!empty || runtime.phase !== "ready" || session.phase !== "ready" || !writable || modalActive
    || uploading || presentation.mode.type !== "overview" || presentation.menu || presentation.panel) return null;
  const center = () => {
    const bounds = document.querySelector("#bevy-canvas")?.getBoundingClientRect();
    const screen = bounds ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    return { screen, world: ctx.canvasRuntime.clientToWorld(screen) ?? { x: 0, y: 0 } };
  };
  return <section className="canvas-empty" aria-label="开始创作">
    <h1>从一件作品开始</h1>
    <p>新建作品，或导入图片、视频与音频。</p>
    <div className="canvas-empty__actions">
      <Button tone="primary" onClick={() => ctx.canvasNavigation.openMenu({ type: "canvas-context", nodeId: null, ...center() })}>新建作品</Button>
      {importer ? <Button onClick={() => importer.requestFile({ world: center().world })}>导入素材</Button> : null}
    </div>
  </section>;
}
