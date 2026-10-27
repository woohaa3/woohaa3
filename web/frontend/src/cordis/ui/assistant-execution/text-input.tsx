import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type {
  AssistantTextCapabilities,
  CanvasTaskInputBinding,
} from "@woohaa3/contracts";
import { useService } from "../../react.js";
import { resolveReferenceItems } from "../../plugins/task-execution/reference-items.js";
import { computePickerCandidates } from "../../plugins/task-execution/node-panel-helpers.js";
import { NodeExecutionReferences } from "../../plugins/task-execution/node-execution-references.js";
import {
  addReference,
  removeReference,
} from "../../plugins/task-execution/model-execution-host-helpers.js";
import { LazyMentionEditor } from "../../plugins/task-execution/mention/lazy-mention-editor.js";

/** The shared Canvas reference picker/compiler projection, parameterized by actual assistant input support. */
export function AssistantTextInput(props: {
  nodeId: string;
  value: string;
  onChange(value: string): void;
  onSubmit(): void;
  disabled: boolean;
  capabilities?: AssistantTextCapabilities;
  onValidation(reason: string | null): void;
  showReferences?: boolean;
  showEditor?: boolean;
}) {
  const state = useService("canvasState");
  const session = useService("canvasSession");
  const canvas = useSyncExternalStore(
    state.subscribe,
    () => state.getWorkingCanvas() ?? state.getCanvas(),
    () => null,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const bindings = useMemo<CanvasTaskInputBinding[]>(
    () =>
      props.capabilities?.imageInput
        ? [
            {
              field: "images",
              semantic: "reference-image",
              valueFormat: "reference",
              roles: ["reference_image"],
              mediaKinds: ["image"],
              mediaTypes: [
                "image/png",
                "image/jpeg",
                "image/webp",
                "image/gif",
              ],
              maxItems: props.capabilities.maxImages,
            },
          ]
        : [],
    [props.capabilities?.imageInput, props.capabilities?.maxImages],
  );
  const references = useMemo(
    () =>
      canvas
        ? resolveReferenceItems({ canvas, nodeId: props.nodeId, bindings })
        : { items: [], blockingReasons: [] },
    [canvas, props.nodeId, bindings],
  );
  const reason = references.blockingReasons.join("；") || null;
  useEffect(() => {
    props.onValidation(reason);
  }, [reason, props.onValidation]);
  const candidates = references.items
    .filter((item) => item.status === "ready")
    .map((item) => ({
      slotId: item.slotId,
      type: item.mentionType,
      label: item.label,
    }));
  return (
    <>
      {props.showReferences !== false ? (
        <NodeExecutionReferences
          items={references.items}
          candidates={computePickerCandidates(canvas, props.nodeId, {
            bindings,
          })}
          presentation="compact"
          disabled={props.disabled}
          pickerOpen={pickerOpen}
          onPickerOpenChange={setPickerOpen}
          onConnect={(source) => addReference(session, props.nodeId, source)}
          onDisconnect={(item) =>
            removeReference(session, canvas, props.nodeId, item.sourceNodeId)
          }
        />
      ) : null}
      {props.showEditor !== false ? (
        <LazyMentionEditor
          value={props.value}
          onChange={props.onChange}
          onSubmit={props.onSubmit}
          candidates={candidates}
          disabled={props.disabled}
          placeholder="描述要生成的文字，输入 @ 引用素材…"
          ariaLabel="文本生成提示词"
          isMac={
            typeof navigator !== "undefined" && /Mac/.test(navigator.platform)
          }
          readOnly={props.disabled}
          blocked={Boolean(reason)}
        />
      ) : null}
    </>
  );
}

/** Reference picker displayed in the panel's upper-left reference row. */
export function AssistantTextReferences(props: {
  nodeId: string;
  disabled: boolean;
  capabilities?: AssistantTextCapabilities;
  onValidation(reason: string | null): void;
}) {
  return (
    <AssistantTextInput
      {...props}
      value=""
      onChange={() => undefined}
      onSubmit={() => undefined}
      showEditor={false}
    />
  );
}
