/**
 * 画布左侧资源轨。
 *
 * 参考稿是一条窄的竖排轨道：顶部是品牌/工作区入口，下面四个分组入口（图层 / 产品 /
 * 项目商品 / 图片），再往下是外部来源（Drive、Pinterest，带 `SOON` 角标）。
 * 选中项用浅底方块 + 文字常显，未选中的只有图标 + 小字。
 *
 * **第一版只做壳与交互**（与产品侧确认过）：
 * - 「图层」是静态列表，不接画布节点。接真数据要等节点目录定稿
 *   （见 四喜仓库 CLAUDE.md「技能是画布的模板」一条：`steps[].node` 引用的目录未定稿，不要编造 id）；
 * - 其余各项点开是空态。数据源（产品库 = 嵌 Furnipedia 官网、素材库仍是占位、Drive / Pinterest
 *   没有授权通路）都还没有，做出来只会是四个点不动的按钮。
 *
 * 收起时只留图标列，画布区域右侧不变 —— 这条轨是 `position: absolute` 的浮层，
 * 不参与画布尺寸计算，与 `.canvas-control-panel` 同一策略。
 */
import { useState } from "react";
import type { ComponentType } from "react";
import {
  BackIcon,
  BoxIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileImageIcon,
  FolderPlusIcon,
  ImageIcon,
  LayersIcon
} from "@woohaa3/ui/icons";
import "./canvas-asset-rail.css";

type RailIcon = ComponentType<{ size?: number; className?: string }>;

type RailEntry = {
  id: string;
  label: string;
  icon: RailIcon;
  /** 还没接通的来源：显示 `SOON` 角标。 */
  soon?: boolean;
};

/**
 * 轨道条目。顺序即视觉顺序，与参考稿一致。
 *
 * 图标选择受 `@woohaa3/ui/icons` 的 allowlist 约束（不允许直接 import lucide-react）：
 * 图层 `LayersIcon`、产品 `BoxIcon`、项目商品 `FolderPlusIcon`、图片 `ImageIcon`；
 * Drive / Pinterest 没有等价图标，用 `FileImageIcon` / `MediaIcon` 占位并靠文字区分。
 */
const ENTRIES: readonly RailEntry[] = [
  { id: "layers", label: "图层", icon: LayersIcon },
  { id: "products", label: "产品", icon: BoxIcon },
  { id: "project-items", label: "项目商品", icon: FolderPlusIcon },
  { id: "images", label: "图片", icon: ImageIcon },
  { id: "drive", label: "Drive", icon: FileImageIcon, soon: true },
  { id: "pinterest", label: "Pinterest", icon: ImageIcon, soon: true }
];

export function CanvasAssetRail({ hidden = false }: { hidden?: boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  // 同一时刻只有一个条目处于选中态；再点一次取消选中
  const [active, setActive] = useState<string | null>("layers");

  if (hidden) return null;

  return (
    /*
     * 一条通高的侧边栏，贴住窗口左缘，只有图标列 —— 与参考稿一致。
     *
     * **不要加第二栏内容面板**：参考稿里没有，而且这是照抄的稿子，
     * 加一栏"更合理"的列表会变成另一个设计。选中项目前只表达选中态，
     * 各项的内容将来各自决定（图层 = 节点列表、产品 = 产品库…），
     * 不该在这一层先定死一种形状。
     */
    <div className={`canvas-asset-rail${collapsed ? " is-collapsed" : ""}`} data-testid="canvas-asset-rail">
        <div className="canvas-asset-rail__head">
          <button
            type="button"
            className="canvas-asset-rail__workspace"
            aria-label="切换工作区（未接入）"
            title="切换工作区（未接入）"
          >
            <LayersIcon size={16} />
            {!collapsed && <ChevronDownIcon size={12} />}
          </button>
          <button
            type="button"
            className="canvas-asset-rail__collapse"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? "展开资源轨" : "收起资源轨"}
            aria-expanded={!collapsed}
            title={collapsed ? "展开资源轨" : "收起资源轨"}
          >
            {/* 收起时箭头朝右（展开），展开时朝左（收起） —— 方向即动作 */}
            {collapsed ? <ChevronRightIcon size={14} /> : <BackIcon size={14} />}
          </button>
        </div>

        <nav className="canvas-asset-rail__items" aria-label="画布资源">
          {ENTRIES.map((item) => {
            const selected = active === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={`canvas-asset-rail__item${selected ? " is-selected" : ""}`}
                onClick={() => setActive((current) => (current === item.id ? null : item.id))}
                aria-pressed={selected}
                /*
                 * 必须显式给 aria-label：`SOON` 角标是按钮的子节点，光靠文本内容会读成
                 * 「DriveSOON」。角标是装饰，不该进可访问名称。
                 */
                aria-label={item.soon ? `${item.label}（尚未开放）` : item.label}
                title={collapsed ? item.label : undefined}
              >
                <span className="canvas-asset-rail__icon">
                  <Icon size={18} />
                  {item.soon && !collapsed && <span className="canvas-asset-rail__soon">SOON</span>}
                </span>
                {!collapsed && <span className="canvas-asset-rail__label">{item.label}</span>}
              </button>
            );
          })}
        </nav>
      </div>
  );
}
