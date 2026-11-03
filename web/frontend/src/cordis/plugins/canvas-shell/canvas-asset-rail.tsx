/**
 * 画布左侧资源栏。
 *
 * 一条通高的侧边栏，贴住窗口左缘，条目为「图标在左、文字在右」的横向排列，
 * 尺寸与排版对齐四喜侧栏（`src/layouts/Sidebar.tsx`）。
 *
 * **只有「图片」条目有内容面板**（照参考稿：所有图片 / 收藏、搜索、按来源分组的网格）：
 * - 「Pinterest」是**动作条目**，不是面板：点一下弹出（或聚焦）桌面壳的独立 Pinterest 窗口
 *   （见 `desktop/pinterest-window.ts`）。它不进入选中态、不让画布多让一档。
 *   第一版是资源栏里 300 像素宽的子 webview，实测被挤成窄条、页面按窄屏断点排版没法用，才改成窗口。
 *   浏览器里没有桌面壳，点了不会有反应的窗口 —— 条目直接禁用并说明原因。
 * - 其余各项仍只表达选中态，点开不展示内容。数据源都还没有：产品库 = 嵌 Furnipedia 官网、
 *   Drive 没有授权通路；「图层」要等画布节点目录定稿
 *   （见四喜仓库 CLAUDE.md「技能是画布的模板」一条：`steps[].node` 引用的目录未定稿，不要编造 id）。
 * - **不要给其它条目顺手补面板**：它们的内容各自决定，不该在这一层先定死一种形状。
 *   图片面板之所以有，是因为参考稿里明确画了它、数据（`canvas.assets`）也现成。
 * - 图片面板的数据由 `imageSource` 注入（见 `image-library.ts`）；不传则「图片」条目退化为只有选中态。
 *
 * 它占住画布左缘，画布表面随之让出栏宽（含面板，见 CSS 末尾的 `:has()` 规则）。
 */
import { useState } from "react";
import type { ComponentType } from "react";
import { openPinterestWindow, pinterestWindowAvailable } from "../../../desktop/pinterest-window.js";
import { CanvasImagePanel } from "./canvas-image-panel.js";
import type { ImageLibrarySource } from "./image-library.js";
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
  /** 动作条目：点击执行动作（如弹出窗口），不进入选中态、不展开面板。 */
  action?: "open-pinterest-window";
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
  { id: "pinterest", label: "Pinterest", icon: PinterestSolidIcon, action: "open-pinterest-window" }
];

export function CanvasAssetRail({
  hidden = false,
  imageSource,
  currentCanvasId
}: {
  hidden?: boolean;
  /** 图片面板的数据源；不传则「图片」条目没有面板。 */
  imageSource?: ImageLibrarySource;
  /** 当前画布 id；面板的「画布」下拉靠它把当前画布标出来。 */
  currentCanvasId?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  // 同一时刻只有一个条目处于选中态；再点一次取消选中
  const [active, setActive] = useState<string | null>("layers");
  // 打开 Pinterest 窗口失败时要说出来：点了没反应比报错更难查
  const [failure, setFailure] = useState<string | null>(null);
  const windowAvailable = pinterestWindowAvailable();

  if (hidden) return null;

  // 收起栏时面板一起收起：64px 的窄栏旁边挂一块 300px 的面板没有意义
  const showImagePanel = Boolean(imageSource) && active === "images" && !collapsed;

  const runAction = (action: NonNullable<RailEntry["action"]>) => {
    if (action === "open-pinterest-window") {
      setFailure(null);
      openPinterestWindow().catch((error: unknown) => {
        setFailure(error instanceof Error ? error.message : String(error));
      });
    }
  };

  return (
    <>
    {/*
     * 一条通高的侧边栏，贴住窗口左缘 —— 与参考稿一致。
     * 面板（只有「图片」有）是它的**同级**元素而不是子元素：两者都是 `.app` 的直接子节点，
     * 画布让位的 `:has(> .canvas-asset-rail)` 规则因此不用改写，只需要多一档 `.has-panel`。
     */}
    <div
      className={`canvas-asset-rail${collapsed ? " is-collapsed" : ""}${showImagePanel ? " has-panel" : ""}`}
      data-testid="canvas-asset-rail"
    >
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
            const Icon = item.icon;
            const isAction = item.action !== undefined;
            // 动作条目没有「选中」这回事：点完窗口就弹出来了，栏里不该留一个高亮
            const selected = !isAction && active === item.id;
            // 浏览器里没有桌面壳：弹不出窗口，禁用并说明，而不是点了毫无反应
            const unavailable = item.action === "open-pinterest-window" && !windowAvailable;
            return (
              <button
                key={item.id}
                type="button"
                className={`canvas-asset-rail__item${selected ? " is-selected" : ""}`}
                onClick={() => {
                  if (item.action) {
                    runAction(item.action);
                    return;
                  }
                  setActive((current) => (current === item.id ? null : item.id));
                }}
                disabled={unavailable}
                // 动作条目不是开关，不能带 aria-pressed（读屏会念成「已按下 / 未按下」）
                aria-pressed={isAction ? undefined : selected}
                /*
                 * 必须显式给 aria-label：`SOON` 角标是按钮的子节点，光靠文本内容会读成
                 * 「DriveSOON」。角标是装饰，不该进可访问名称。
                 */
                aria-label={
                  item.soon
                    ? `${item.label}（尚未开放）`
                    : unavailable
                      ? `${item.label}（仅桌面端可用）`
                      : item.label
                }
                title={unavailable ? "仅桌面端可用" : collapsed ? item.label : undefined}
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
        {failure ? (
          <p className="canvas-asset-rail__failure" role="alert">
            {failure}
          </p>
        ) : null}
      </div>
    {showImagePanel && imageSource ? (
      <div className="canvas-asset-rail__panel" data-testid="canvas-asset-rail-panel">
        <CanvasImagePanel source={imageSource} currentCanvasId={currentCanvasId} />
      </div>
    ) : null}
    </>
  );
}
