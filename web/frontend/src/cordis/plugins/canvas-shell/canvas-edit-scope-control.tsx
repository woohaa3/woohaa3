import { useEffect, useState, useSyncExternalStore } from "react";
import { IconButton, SegmentedControl, Tooltip } from "@woohaa3/ui/primitives";
import { LayersIcon } from "@woohaa3/ui/icons";
import type { CanvasScopeMode } from "@woohaa3/contracts";
import { canvasEditScopeStore } from "../../services/canvas-edit-scope.js";
import { useService } from "../../react.js";
import "./canvas-edit-scope-control.css";

const options = [
  { value: "edit", label: "编辑" },
  { value: "locked", label: "锁定" },
  { value: "hidden", label: "隐藏" }
] as const;

function summary(value: ReturnType<typeof canvasEditScopeStore.getSnapshot>): string {
  if (value["2d"] === "edit" && value["3d"] === "edit") return "场景编辑";
  const label = (mode: CanvasScopeMode) => options.find(option => option.value === mode)?.label ?? mode;
  return `场景编辑 · 2D ${label(value["2d"])} · 3D ${label(value["3d"])}`;
}

export function CanvasEditScopeControl() {
  const canvasState = useService("canvasState");
  const runtime = useService("canvasRuntime");
  const navigation = useService("canvasNavigation");
  const value = useSyncExternalStore(canvasEditScopeStore.subscribe, canvasEditScopeStore.getSnapshot, canvasEditScopeStore.getSnapshot);
  const navigationSnapshot = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
  const [open, setOpen] = useState(false);
  const canvasId = canvasState.getWorkingCanvas()?.id ?? canvasState.getCanvas()?.id ?? null;
  useEffect(() => { canvasEditScopeStore.bindCanvas(canvasId); }, [canvasId]);

  // Focus workspaces own their editor controls; keep this local filter intact so
  // returning to the overview restores the user's previous scope immediately.
  if (navigationSnapshot.mode.type !== "overview") return null;

  const change = (category: "2d" | "3d", mode: string) => {
    canvasEditScopeStore.setMode(category, mode as CanvasScopeMode);
    runtime.controller()?.invalidate("edit-scope");
  };
  return (
    <div className="canvas-edit-scope-control">
      <Tooltip content={summary(value)}>
        <IconButton label={summary(value)} onClick={() => setOpen(current => !current)} data-active={open || summary(value) !== "场景编辑"}>
          <LayersIcon size={16} />
        </IconButton>
      </Tooltip>
      {open ? (
        <div className="canvas-edit-scope-control__popover" role="dialog" aria-label="场景编辑">
          <div className="canvas-edit-scope-control__row">
            <span>2D</span>
            <SegmentedControl label="2D 编辑状态" options={options} value={value["2d"]} onValueChange={mode => change("2d", mode)} />
          </div>
          <div className="canvas-edit-scope-control__row">
            <span>3D</span>
            <SegmentedControl label="3D 编辑状态" options={options} value={value["3d"]} onValueChange={mode => change("3d", mode)} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
