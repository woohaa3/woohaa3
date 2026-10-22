import { useEffect } from "react";
import type { CanvasRuntimeService } from "../../contracts.js";

/** 面板打开后按需装载避让；关闭或换节点时取消尚未完成的装载与观察。 */
export function useDockReveal(runtime: CanvasRuntimeService, nodeId: string, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let dispose: (() => void) | undefined;
    void import("./dock-reveal.js").then(({ watchDockReveal }) => {
      if (active) dispose = watchDockReveal(runtime, nodeId);
    });
    return () => { active = false; dispose?.(); };
  }, [runtime, nodeId, enabled]);
}
