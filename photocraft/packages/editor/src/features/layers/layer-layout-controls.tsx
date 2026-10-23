import { useEffect, useState } from "react";
import type { PhotocraftCommand } from "@woohaa3/photocraft-protocol";
import { Button, IconButton } from "../../ui/Button.js";
import { DropdownMenu } from "../../ui/Menu.js";
import {
  AlignLeftIcon, AlignCenterXIcon, AlignRightIcon, AlignTopIcon,
  AlignCenterYIcon, AlignBottomIcon, ChevronDownIcon
} from "../../ui/icons.js";

const ALIGN = [
  ["leftEdges", "左对齐", AlignLeftIcon],
  ["horizontalCenters", "水平居中", AlignCenterXIcon],
  ["rightEdges", "右对齐", AlignRightIcon],
  ["topEdges", "顶端对齐", AlignTopIcon],
  ["verticalCenters", "垂直居中", AlignCenterYIcon],
  ["bottomEdges", "底端对齐", AlignBottomIcon]
] as const;
const DISTRIBUTE = [
  ["horizontally", "水平等间距"], ["vertically", "垂直等间距"],
  ["leftEdges", "左边缘分布"], ["horizontalCenters", "水平中心分布"], ["rightEdges", "右边缘分布"],
  ["topEdges", "顶边缘分布"], ["verticalCenters", "垂直中心分布"], ["bottomEdges", "底边缘分布"]
] as const;
type Target = "auto" | "layers" | "canvas" | "selection";

/** 只保存对齐参照偏好；所选集合和各命令的可用状态由内核提供。 */
export function LayerLayoutControls({ commands, readonly, hasSelection, onCommand }: {
  commands: ReadonlyMap<string, PhotocraftCommand>;
  readonly: boolean;
  hasSelection: boolean;
  onCommand: (id: string, params?: unknown) => void;
}) {
  const [target, setTarget] = useState<Target>("auto");
  useEffect(() => { if (!hasSelection) setTarget(current => current === "selection" ? "auto" : current); }, [hasSelection]);
  const effectiveTarget = target === "selection" && !hasSelection ? "auto" : target;
  const allowed = (id: string) => commands.get(id)?.allowed === true;
  const enabled = (id: string) => !readonly && allowed(id) && commands.get(id)?.enabled === true;
  const align = ALIGN.filter(([kind]) => allowed(`layer.align.${kind}`));
  const distribute = DISTRIBUTE.filter(([kind]) => allowed(`layer.distribute.${kind}`));
  if (align.length === 0 && distribute.length === 0) return null;
  const canAlign = align.some(([kind]) => enabled(`layer.align.${kind}`));
  return <div className="photo-editor__layer-layout">
    {align.length > 0 ? <label className="photo-editor__align-target" title="自动：单层对齐选区或画布，多层对齐所选图层">对齐到
      <select title="对齐参照" value={effectiveTarget} disabled={!canAlign}
        onChange={event => setTarget(event.currentTarget.value as Target)}>
        <option value="auto">自动</option>
        <option value="layers">所选图层</option>
        <option value="canvas">画布</option>
        <option value="selection" disabled={!hasSelection}>选区</option>
      </select>
    </label> : null}
    <div className="photo-editor__align-actions">
      {align.map(([kind, label, Icon]) => {
        const id = `layer.align.${kind}`;
        return <IconButton key={id} size="sm" label={label} title={commands.get(id)?.disabledReason || label}
          disabled={!enabled(id)} onClick={() => { if (enabled(id)) onCommand(id, { to: effectiveTarget }); }}><Icon size={15} /></IconButton>;
      })}
      {distribute.length > 0 ? <DropdownMenu label="分布图层" align="end"
        trigger={<Button size="sm" tone="ghost" disabled={!distribute.some(([kind]) => enabled(`layer.distribute.${kind}`))}
          title="至少选择三个有内容的图层">分布<ChevronDownIcon size={12} /></Button>}
        items={distribute.map(([kind, label], index) => {
          const id = `layer.distribute.${kind}`;
          return { id, label, separatorBefore: index === 2, disabled: !enabled(id),
            onSelect: () => { if (enabled(id)) onCommand(id); } };
        })} /> : null}
    </div>
  </div>;
}
