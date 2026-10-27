import { useSyncExternalStore } from "react";
import { AuthoringGenerateHost } from "../../host.js";
import { useService } from "../../react.js";
import { ExecutionPanelSurface } from "./execution-panel-surface.js";
import type { CanvasRuntimeService } from "../../contracts.js";
import type { ExecutionPanelPresentation } from "../../navigation/contracts.js";
import type { PanelPresentationIntent } from "./node-panel-directives.js";

/** Text uses the shared assistant surface, retaining the same node anchor/expanded host. */
export function TextExecutionHost(props: {
  canvasId: string;
  nodeId: string;
  writable: boolean;
  runtime?: CanvasRuntimeService;
  presentation: ExecutionPanelPresentation;
  onPresentationIntent(intent: PanelPresentationIntent): void;
}) {
  const state = useService("canvasState");
  const canvas = useSyncExternalStore(
    state.subscribe,
    () => state.getWorkingCanvas() ?? state.getCanvas(),
    () => null,
  );
  const node = canvas?.document.nodes.find((node) => node.id === props.nodeId);
  if (!node || node.type !== "text") return null;
  return (
    <ExecutionPanelSurface
      nodeId={props.nodeId}
      presentation={props.presentation}
      runtime={props.runtime}
    >
      <AuthoringGenerateHost
        canvasId={props.canvasId}
        nodeId={props.nodeId}
        mode="text"
        presentation={props.presentation === "expanded" ? "expanded" : "dock"}
        writable={props.writable}
        requestPresentation={props.onPresentationIntent}
      />
    </ExecutionPanelSurface>
  );
}
