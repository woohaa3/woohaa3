import type { FeaturePanelContext } from "../panel-context.js";
import { RetouchPanel } from "./panels.js";

/**
 * 修饰工具与仿制源（change: 2026-10-22-add-photocraft-retouch-workflows）。
 *
 * 只有一个「滤镜 → 修饰工具…」入口：新增的图案图章、历史记录画笔、移除走同一个修饰下拉，
 * 区域命令（修补/内容识别移动/红眼）与仿制源槽位在面板内部切换，因此不新增画布工具 id，
 * 也不改变共享工具列表与菜单分组。
 */
export const sections = [
  {
    id: "retouch",
    order: 11,
    placement: "advanced",
    menu: "窗口",
    label: "修饰工具…",
    menuOrder: 1,
    render: ({ locked, retouchTool, retouchSample, retouchAligned, setRetouchAligned, setMessage, controller, activateRetouchTool, armRetouchSample }: FeaturePanelContext) => (
      <div key="retouch" className="photo-editor__advanced-section" data-advanced-section="retouch">
        <RetouchPanel
          readonly={locked}
          tool={retouchTool}
          controller={controller}
          onSample={() => {
            // 取样必须先进入「下一次单击即取样」状态；只弹一句提示、不真的布防时，用户照做
            // 会落下一笔（并被内核以「需要采样点」拒绝），面板与提示互相矛盾。
            armRetouchSample?.();
            setMessage("单击画布选择采样点");
          }}
          samplePoint={retouchSample}
          aligned={retouchAligned}
          onAligned={setRetouchAligned}
          {...(activateRetouchTool ? { onTool: activateRetouchTool } : {})}
        />
      </div>
    )
  }
] as const;
