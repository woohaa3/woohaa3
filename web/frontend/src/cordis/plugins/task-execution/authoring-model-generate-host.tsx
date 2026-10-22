/** 3D authoring 的参考图装配：宿主拥有画布投影与连线命令，扩展只消费 renderer。 */
import { useState, type ComponentType } from "react";
import type { AuthoringGenerationProps } from "../../contract/authoring.js";
import { useService } from "../../react.js";
import { useCanvasStoreState } from "./use-task-state.js";
import { NodeExecutionReferences } from "./node-execution-references.js";
import { resolveReferenceItems } from "./reference-items.js";
import { computePickerCandidates } from "./node-panel-helpers.js";
import { addReference, removeReference } from "./model-execution-host-helpers.js";

export function AuthoringModelGenerateHost({ render: Component, ...props }: AuthoringGenerationProps & {
  render: ComponentType<AuthoringGenerationProps>;
}) {
  const session = useService("canvasSession");
  const state = useCanvasStoreState();
  const canvas = state.canvas?.id === props.canvasId ? state.canvas : null;
  const [pickerOpen, setPickerOpen] = useState(false);
  const items = canvas
    ? resolveReferenceItems({ canvas, nodeId: props.nodeId }).items.filter(item => item.mentionType === "input_image")
    : [];
  const candidates = computePickerCandidates(canvas, props.nodeId).filter(item => item.mediaKind === "image");
  const disabled = !props.writable || !canvas;
  return (
    <Component
      {...props}
      renderers={{
        ...props.renderers,
        references: () => (
          <NodeExecutionReferences
            items={items}
            candidates={candidates}
            presentation="compact"
            disabled={disabled}
            pickerOpen={pickerOpen}
            onPickerOpenChange={setPickerOpen}
            onConnect={source => !disabled && addReference(session, props.nodeId, source)}
            onDisconnect={item => { if (!disabled) removeReference(session, canvas, props.nodeId, item.sourceNodeId); }}
          />
        )
      }}
    />
  );
}
