import type { FeaturePanelContext } from "../panel-context.js";
import { TimelinePanel } from "./panels.js";

/**
 * 时间轴入口。
 *
 * `placement: "advanced"`：由共享高级区域渲染（与调色、滤镜、视图辅助一致），因此面板在
 * 「属性 → 高级…」里即可操作，不需要改共享外壳。
 *
 * `menu: "窗口"`：落位「窗口 ▸ 时间轴」菜单项。共享 `photo-editor-chrome.tsx` 的「窗口」菜单
 * 会把 `featureMenuSections("窗口")` 合并进显示项与文档清单之后，因此这里只声明菜单名，
 * 不自己拼菜单项；面板本身不依赖菜单（高级区域始终可进入）。
 */
export const sections = [
  {
    id: "timeline",
    order: 12,
    placement: "advanced",
    menu: "窗口",
    label: "时间轴…",
    menuOrder: 0,
    render: ({ controller, locked, refreshPreview }: FeaturePanelContext) => (
      <div key="timeline" className="photo-editor__advanced-section" data-advanced-section="timeline">
        <TimelinePanel controller={controller} readonly={locked} onChanged={refreshPreview} />
      </div>
    )
  }
] as const;
