/**
 * 画布左侧资源栏。
 *
 * 一条通高的侧边栏，贴住窗口左缘，条目为「图标在左、文字在右」的横向排列，
 * 尺寸与排版对齐四喜侧栏（`src/layouts/Sidebar.tsx`）。
 *
 * **第一版只做壳与交互**（与产品侧确认过）：
 * - 各项只表达选中态，点开不展示内容。数据源都还没有：产品库 = 嵌 Furnipedia 官网、
 *   素材库仍是占位、Drive / Pinterest 没有授权通路；「图层」要等画布节点目录定稿
 *   （见四喜仓库 CLAUDE.md「技能是画布的模板」一条：`steps[].node` 引用的目录未定稿，不要编造 id）。
 * - 因此**不要在这里补「内容面板」**：参考稿没有那一栏，各项内容将来各自决定，
 *   不该在这一层先定死一种形状。
 *
 * 它占住画布左缘，画布表面随之让出栏宽（见 CSS 末尾的 `:has()` 规则）。
 */
import { useState } from "react";
import type { ComponentType } from "react";
import {
  CubeSolidIcon,
  FolderPlusSolidIcon,
  GoogleDriveSolidIcon,
  ImageSolidIcon,
  LayerGroupSolidIcon,
  PinterestSolidIcon,
  SidebarIcon
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
 * **图标必须是实心的**：四喜的图标来自 Font Awesome 6 Solid（`src/components/icons.tsx`），
 * 宿主默认的 Lucide 是线条。线条与实心并排一眼就能看出不是一套 —— 只调字号与颜色没用，
 * 图形语言本身不同。所以这里一律用 `*SolidIcon`（路径为构建期从 FA 取的常量，
 * 运行时不依赖 FA 包）。Drive / Pinterest 用的是 FA 的品牌图标。
 */
const ENTRIES: readonly RailEntry[] = [
  { id: "layers", label: "图层", icon: LayerGroupSolidIcon },
  { id: "products", label: "产品", icon: CubeSolidIcon },
  { id: "project-items", label: "项目商品", icon: FolderPlusSolidIcon },
  { id: "images", label: "图片", icon: ImageSolidIcon },
  { id: "drive", label: "Drive", icon: GoogleDriveSolidIcon, soon: true },
  { id: "pinterest", label: "Pinterest", icon: PinterestSolidIcon, soon: true }
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
          {/*
            照参考稿：一个圆角方块，里面是侧栏图标（矩形 + 左侧竖线）。
            不用左右箭头 —— 参考稿要的是「这就是一条侧栏」的形状，不是方向指示。
          */}
          <button
            type="button"
            className="canvas-asset-rail__collapse"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? "展开资源轨" : "收起资源轨"}
            aria-expanded={!collapsed}
            title={collapsed ? "展开资源轨" : "收起资源轨"}
          >
            <SidebarIcon size={16} />
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
                  {/* 16 与四喜菜单图标同尺寸，也与 `.__icon` 的 16×16 盒子一致。
                      传 18 会溢出盒子（实心 SVG 被裁或有视觉偏移）。 */}
                  <Icon size={16} />
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
