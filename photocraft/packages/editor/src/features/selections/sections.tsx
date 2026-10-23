import type { FeaturePanelContext } from "../panel-context.js";
import { SelectionModifyPanel, ColorRangePanel, RefineEdgePanel } from "./panels.js";
import {
  ColorGrowPanel,
  ColorRangeSamplesPanel,
  LayerMaskPanel,
  LineSelectionPanel,
  MagneticLassoPanel,
  NamedSelectionPanel,
  QuickMaskPanel,
  RefineEdgeWorkspace,
  SmartSelectPanel
} from "./workflow-panels.js";

/**
 * 选区与蒙版菜单分区。
 *
 * 分区 id 保持不变（`selection` / `colorRange` / `refine`）：共享外壳按 id 做菜单项与可见性
 * 过滤，新增 id 属于结构前置的装配改动，不在本域单方面扩表。U17–U24 的新入口因此组合进
 * 这三个既有分区，顺序就是实际操作顺序：建立 → 修补 → 取样 → 细化/蒙版。
 */
export const sections = [
  {
    id: "selection",
    order: 2,
    placement: "advanced",
    menu: "选择",
    label: "选区工具…",
    menuOrder: 0,
    render: ({ controller, locked, documentView, refreshPreview }: FeaturePanelContext) => {
      const hasSelection = documentView?.hasSelection ?? false;
      const canvas = { width: documentView?.width ?? 0, height: documentView?.height ?? 0 };
      return (
        <div key="selection" className="photo-editor__advanced-section" data-advanced-section="selection">
          <SelectionModifyPanel controller={controller} readonly={locked} hasSelection={hasSelection} onChanged={refreshPreview} />
          <LineSelectionPanel controller={controller} readonly={locked} canvas={canvas} onChanged={refreshPreview} />
          <MagneticLassoPanel controller={controller} readonly={locked} canvas={canvas} onChanged={refreshPreview} />
          <NamedSelectionPanel controller={controller} readonly={locked} hasSelection={hasSelection} onChanged={refreshPreview} />
          <ColorGrowPanel controller={controller} readonly={locked} hasSelection={hasSelection} onChanged={refreshPreview} />
          <SmartSelectPanel controller={controller} readonly={locked} onChanged={refreshPreview} />
          <QuickMaskPanel controller={controller} readonly={locked} onChanged={refreshPreview} />
        </div>
      );
    }
  },
  {
    id: "colorRange",
    order: 3,
    placement: "advanced",
    menu: "选择",
    label: "色彩范围…",
    menuOrder: 1,
    render: ({ controller, locked, colors, refreshPreview }: FeaturePanelContext) => (
      <div key="colorRange" className="photo-editor__advanced-section" data-advanced-section="colorRange">
        <ColorRangePanel controller={controller} readonly={locked} color={colors.foreground} onChanged={refreshPreview} />
        <ColorRangeSamplesPanel controller={controller} readonly={locked} onChanged={refreshPreview} />
      </div>
    )
  },
  {
    id: "refine",
    order: 4,
    placement: "advanced",
    menu: "选择",
    label: "选择并遮住与蒙版…",
    menuOrder: 2,
    render: ({ controller, locked, documentView, activeLayerId, refreshPreview }: FeaturePanelContext) => (
      <div key="refine" className="photo-editor__advanced-section" data-advanced-section="refine">
        <RefineEdgeWorkspace controller={controller} readonly={locked} hasSelection={documentView?.hasSelection ?? false} onChanged={refreshPreview} />
        <LayerMaskPanel controller={controller} readonly={locked} layer={activeLayerId} onChanged={refreshPreview} />
        {/* 既有的参数预编译面板保留：真实预览之外仍可直接核对编译后的参数。 */}
        <RefineEdgePanel controller={controller} readonly={locked} hasSelection={documentView?.hasSelection ?? false} />
      </div>
    )
  }
] as const;
