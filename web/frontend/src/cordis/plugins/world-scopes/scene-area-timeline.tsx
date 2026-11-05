import type { Context } from "@deepseek-ai/cordis";
import { SceneAreaProgress } from "./scene-area-progress.js";

/** Player visuals live beside the nameplate in Bevy's depth-tested ground scene. */
export function SceneAreaTimeline({ ctx }: { ctx: Context; canvasId: string | undefined }) {
  return <SceneAreaProgress runtime={ctx.canvasRuntime} />;
}
