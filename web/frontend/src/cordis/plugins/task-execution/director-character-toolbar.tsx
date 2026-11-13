import { useRef, useState } from "react";
import { Button } from "@woohaa3/ui/primitives";
import { modelSceneStore } from "../model-scene/model-scene-store.js";
import { useOptionalService } from "../../react.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { createDirectorCharacter, type DirectorCharacterKind } from "./director-character-create.js";

export function DirectorCharacterToolbar(props: { canvasId: string; nodeId: string; areaId: string; writable: boolean }) {
  const remote = useOptionalService("canvasRemote");
  const edit = useOptionalService("canvasEdit");
  const session = useOptionalService("canvasSession");
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async (kind: DirectorCharacterKind) => {
    if (running.current || !props.writable || !remote || !edit || !session) return;
    running.current = true; setBusy(true); setError(null);
    try {
      await createDirectorCharacter({ ...props, kind, remote, edit, resources: modelSceneStore.snapshot(),
        writable: () => props.writable && session.isWritable(),
        getCanvas: () => woohaa3CanvasStore.getState().canvas });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "角色创建失败"); }
    finally { running.current = false; setBusy(false); }
  };
  return <>
    <div className="director-character-toolbar" style={{ display: "flex", gap: 6, paddingBottom: 8 }}>
      <Button size="sm" style={{ whiteSpace: "nowrap", paddingInline: 12, flexShrink: 0 }} disabled={!props.writable || busy || !remote || !edit || !session} onClick={() => void create("capsule")}>胶囊人</Button>
      <Button size="sm" style={{ whiteSpace: "nowrap", paddingInline: 12, flexShrink: 0 }} disabled={!props.writable || busy || !remote || !edit || !session} onClick={() => void create("humanoid")}>普通人</Button>
    </div>
    {error ? <p className="node-execution-dock__error">{error}</p> : null}
  </>;
}
