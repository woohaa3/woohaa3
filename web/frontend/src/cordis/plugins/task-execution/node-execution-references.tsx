/**
 * 执行面板的参考素材区（tile strip + panel-owned picker）
 * （change: 2026-09-28-align-execution-reference-and-expansion，task 2 / 3；
 *   从 `node-execution-panel.tsx` 拆出以维持文件体积守卫）。
 *
 * 纯视图 + 局部 transient 状态（picker 打开、active index、焦点恢复）；权威命令仍由宿主
 * 通过 `onConnect` / `onDisconnect` 提交。图片/视频的悬浮预览由 tile 自行 portal。
 *
 * 选择器生命周期（design D4）：panel unmount、presentation 变化、外部点击或 Escape 都会
 * 关闭并清理 picker；opener 可恢复时把焦点还给 add tile。命令被拒绝时保留 picker 并展示
 * 稳定原因（不提前增加 tile）。
 */
import { useEffect, useRef, useState } from "react";
import type { ReferenceItem } from "./reference-items.js";
import {
  ReferenceTileStrip,
  ReferencePickerContent,
  type ReferencePickerCandidate
} from "./reference-chips.js";
import type { ExecutionPanelPresentation } from "../../navigation/contracts.js";

export type NodeExecutionReferencesProps = {
  items: readonly ReferenceItem[];
  candidates: readonly ReferencePickerCandidate[];
  presentation: ExecutionPanelPresentation;
  disabled: boolean;
  /** picker 打开状态由宿主持有，用于 Escape 路由（design D7）。 */
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  /** 提交 edge 连接；返回是否被接受（拒绝时保留 picker）。 */
  onConnect: (sourceNodeId: string) => boolean;
  /**
   * 往模型声明的空槽位填素材；返回是否被接受。
   *
   * 与 `onConnect` 分开：填槽必须显式写入槽位角色，普通连接走角色推断。
   */
  onFillSlot?: (item: ReferenceItem, sourceNodeId: string) => boolean;
  /** 提交 edge 删除（权威命令由宿主完成）。 */
  onDisconnect: (item: ReferenceItem) => void;
};

export function NodeExecutionReferences({
  items,
  candidates,
  presentation,
  disabled,
  pickerOpen,
  onPickerOpenChange,
  onConnect,
  onFillSlot,
  onDisconnect
}: NodeExecutionReferencesProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /**
   * 正在填充的槽位。
   *
   * 打开 picker 的入口有两个（add tile 与空槽位 tile），选中候选后要走的命令不同。
   * 把这个意图存在本地：它只影响"这次选择落到哪"，不参与权威状态。
   */
  const [fillTarget, setFillTarget] = useState<ReferenceItem | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);

  // picker 候选变化或重新打开时：焦点落到第一个可用候选（design D4）。
  useEffect(() => {
    if (!pickerOpen) return;
    const firstEnabled = candidates.findIndex((candidate) => !candidate.disabled);
    setActiveIndex(firstEnabled < 0 ? 0 : firstEnabled);
  }, [pickerOpen, candidates]);

  // presentation 变化（compact↔expanded）时清理 picker（design D4）。
  useEffect(() => {
    onPickerOpenChange(false);
    // 故意只在 presentation 变化时触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentation]);

  // add tile 点击时打开 picker（Popover trigger 负责锚点与定位）。
  const openPicker = () => {
    setFillTarget(null);
    onPickerOpenChange(true);
  };

  // 空槽位点击：打开同一份 picker，但选中后要落进这个槽位。
  const openPickerForSlot = (item: ReferenceItem) => {
    setFillTarget(item);
    onPickerOpenChange(true);
  };

  const closePicker = () => {
    setFillTarget(null);
    onPickerOpenChange(false);
    addButtonRef.current?.focus();
  };

  return (
    <div
      ref={containerRef}
      className="ref-tile-strip-wrap"
      data-empty={items.length === 0 ? "true" : undefined}
    >
      <div
        ref={(node) => {
          if (node) addButtonRef.current = node.querySelector<HTMLButtonElement>("[data-role='add']");
        }}
      >
        <ReferenceTileStrip
          items={items}
          onRemove={onDisconnect}
          onAdd={openPicker}
          {...(onFillSlot ? { onFillSlot: openPickerForSlot } : {})}
          disabled={disabled}
          presentation={presentation}
          pickerOpen={pickerOpen}
          onPickerOpenChange={(next) => {
            if (next) onPickerOpenChange(true);
            else closePicker();
          }}
          picker={
            <ReferencePickerContent
              candidates={candidates}
              activeIndex={activeIndex}
              onActiveIndexChange={setActiveIndex}
              onPick={(nodeId) => {
                // 只有命令被接受才关闭 picker；拒绝时保留并展示稳定原因（design D4）。
                if (disabled) return;
                const accepted =
                  fillTarget !== null && onFillSlot !== undefined
                    ? onFillSlot(fillTarget, nodeId)
                    : onConnect(nodeId);
                if (accepted) { setError(null); closePicker(); }
                else setError("参考已变化或暂不可修改，请重新选择");
              }}
              onClose={closePicker}
            />
          }
        />
      </div>
      {error ? <p className="node-execution-dock__error">{error}</p> : null}
    </div>
  );
}
