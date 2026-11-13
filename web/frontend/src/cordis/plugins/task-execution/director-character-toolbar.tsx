import { useRef, useState } from "react";
import { Button } from "@woohaa3/ui/primitives";
import { Popover } from "@woohaa3/ui";
import { ChevronDownIcon } from "@woohaa3/ui/icons";
import { DEFAULT_SOMA_BODY_SELECTION, somaBodyPresetId, type SomaBodySelection, type SomaBodyPresetId, type DirectorCapsulePreset } from "@woohaa3/contracts";
import { modelSceneStore } from "../model-scene/model-scene-store.js";
import { useOptionalService } from "../../react.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { createDirectorCharacter, type DirectorCharacterKind } from "./director-character-create.js";
import "./director-character-toolbar.css";

// Page-lifetime preference, shared when switching director areas; never persisted to the canvas.
let lastSuccessfulSelection = DEFAULT_SOMA_BODY_SELECTION;
export function DirectorCharacterToolbar(props: { canvasId: string; nodeId: string; areaId: string; writable: boolean }) {
  const remote = useOptionalService("canvasRemote");
  const edit = useOptionalService("canvasEdit");
  const session = useOptionalService("canvasSession");
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [capsuleOpen, setCapsuleOpen] = useState(false);
  const [capsulePreset, setCapsulePreset] = useState<DirectorCapsulePreset | undefined>();
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<SomaBodySelection>(() => ({ ...lastSuccessfulSelection }));
  const [error, setError] = useState<string | null>(null);
  const [capsuleError, setCapsuleError] = useState<string | null>(null);
  const unavailable = !props.writable || !remote || !edit || !session;
  const create = async (kind: DirectorCharacterKind, bodyPreset?: SomaBodyPresetId, capsulePreset?: DirectorCapsulePreset) => {
    if (running.current || unavailable) return;
    const frozenSelection = { ...selection };
    running.current = true; setBusy(true);
    if (kind === "humanoid") setError(null); else setCapsuleError(null);
    try {
      await createDirectorCharacter({ ...props, kind, bodyPreset, capsulePreset, remote, edit, resources: modelSceneStore.snapshot(),
        writable: () => props.writable && session.isWritable(),
        getCanvas: () => woohaa3CanvasStore.getState().canvas });
      if (kind === "humanoid") { lastSuccessfulSelection = frozenSelection; setOpen(false); } else setCapsuleOpen(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "角色创建失败";
      if (kind === "humanoid") setError(message); else setCapsuleError(message);
    } finally { running.current = false; setBusy(false); }
  };
  const row = <K extends keyof SomaBodySelection>(label: string, key: K, options: ReadonlyArray<readonly [SomaBodySelection[K], string]>) =>
    <div className="director-body-picker__row">
      <span>{label}</span>
      <div className="director-body-picker__choices">
        {options.map(([value, text]) => <Button key={String(value)} size="sm" tone={(key === "age" ? selection.age ?? "adult" : selection[key]) === value ? "primary" : "neutral"}
          disabled={busy} onClick={() => setSelection(current => ({ ...current, [key]: value }))}>{text}</Button>)}
      </div>
    </div>;
  return <>
    <div className="director-character-toolbar">
      <span className="director-character-toolbar__label">快速添加</span>
      <Popover open={capsuleOpen} onOpenChange={setCapsuleOpen} align="start" side="top" className="director-body-picker" trigger={
        <Button size="sm" disabled={unavailable}>胶囊人 <ChevronDownIcon size={12} /></Button>
      }>
        <div className="director-body-picker__row"><span>身高</span><div className="director-body-picker__choices">
          <Button size="sm" tone={!capsulePreset ? "primary" : "neutral"} disabled={busy} onClick={() => setCapsulePreset(undefined)}>标准</Button>
          <Button size="sm" tone={capsulePreset ? "primary" : "neutral"} disabled={busy} onClick={() => setCapsulePreset("two-heads")}>2头身</Button>
        </div></div>
        {capsuleError ? <p className="node-execution-dock__error">{capsuleError}</p> : null}
        <div className="director-body-picker__footer"><Button size="sm" tone="primary" disabled={unavailable || busy} onClick={() => void create("capsule", undefined, capsulePreset)}>{busy ? "创建中…" : "创建"}</Button></div>
      </Popover>
      <Popover open={open} onOpenChange={next => { setOpen(next); if (next && !running.current && !error) setSelection({ ...lastSuccessfulSelection }); }}
        align="start" side="top" className="director-body-picker" trigger={
          <Button size="sm" disabled={unavailable}>骨架人 <ChevronDownIcon size={12} /></Button>
        }>
        {row("年龄", "age", [["adult", "成人"], ["baby", "婴儿"], ["child", "儿童"], ["teen", "少年"]])}
        {selection.age !== "baby" && row("性别", "sex", [["male", "男"], ["female", "女"]])}
        {(!selection.age || selection.age === "adult") && <>
          {row("头身比", "heads", [[7, "7"], [8, "8"], [9, "9"], [10, "10"]])}
          {row("体型", "build", [["slim", "瘦"], ["fat", "胖"]])}
        </>}
        {error ? <p className="node-execution-dock__error">{error}</p> : null}
        <div className="director-body-picker__footer">
          <Button size="sm" tone="primary" disabled={unavailable || busy} onClick={() => void create("humanoid", somaBodyPresetId(selection))}>{busy ? "创建中…" : "创建"}</Button>
        </div>
      </Popover>
    </div>
  </>;
}
