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
import type { ComponentType, ReactNode } from "react";
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
  /** 还没接通的来源：显示 `SOON` 角标，点开只给说明，不做成静默失败的按钮。 */
  soon?: boolean;
  /** 内容面板标题下的说明。 */
  hint: string;
};

/**
 * 轨道条目。顺序即视觉顺序，与参考稿一致。
 *
 * 图标选择受 `@woohaa3/ui/icons` 的 allowlist 约束（不允许直接 import lucide-react）：
 * 图层 `LayersIcon`、产品 `BoxIcon`、项目商品 `FolderPlusIcon`、图片 `ImageIcon`；
 * Drive / Pinterest 没有等价图标，用 `FileImageIcon` / `MediaIcon` 占位并靠文字区分。
 */
const ENTRIES: readonly RailEntry[] = [
  { id: "layers", label: "图层", icon: LayersIcon, hint: "画布里正在编辑的内容会出现在这里。" },
  { id: "products", label: "产品", icon: BoxIcon, hint: "产品库尚未接入画布。" },
  { id: "project-items", label: "项目商品", icon: FolderPlusIcon, hint: "项目里的商品清单尚未接入画布。" },
  { id: "images", label: "图片", icon: ImageIcon, hint: "图片素材库尚未接入画布。" },
  { id: "drive", label: "Drive", icon: FileImageIcon, soon: true, hint: "Google Drive 导入尚未开放。" },
  { id: "pinterest", label: "Pinterest", icon: ImageIcon, soon: true, hint: "Pinterest 导入尚未开放。" }
];

type PanelKey = string;

/**
 * 「图层」占位列表。
 *
 * 明确写的是**示例**：不能让它看起来像画布里真实存在的三张卡 —— 用户会点它、在画布上找不到。
 * 接真节点时把这里换成读 `canvasState` 的节点列表，其余结构不用动。
 */
const LAYER_EXAMPLES = ["示例 · 客厅立面", "示例 · 沙发体块", "示例 · 材质参考"];

export function CanvasAssetRail({ hidden = false }: { hidden?: boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  const [active, setActive] = useState<PanelKey | null>("layers");

  if (hidden) return null;
  const entry = ENTRIES.find((item) => item.id === active) ?? null;

  return (
    /*
     * 轨道与内容面板是**两个独立的定位元素**，不嵌套：
     * 轨道只有 132px 宽（图标 + 名称，照参考稿），
     * 面板贴在它右侧展开 —— 挤在轨道里的话，中文会被压成一行两个字。
     */
    <>
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

      {/* 面板在轨道右侧展开；`left` 由 CSS 按轨道宽度偏移，收起时不渲染 */}
      {!collapsed && entry && <RailPanel entry={entry} />}
    </>
  );
}

/**
 * 选中条目的内容区。
 *
 * 全部是空态，但**说清楚为什么空**：接不上的写"尚未接入"，没开放的写"尚未开放"。
 * 一个演示列表会被当成真数据，所以图层那三条显式标了「示例」。
 */
function RailPanel({ entry }: { entry: RailEntry }): ReactNode {
  return (
    <section className="canvas-asset-rail__panel" aria-label={`${entry.label}内容`}>
      <h2 className="canvas-asset-rail__panel-title">{entry.label}</h2>
      {entry.id === "layers" ? (
        <>
          <p className="canvas-asset-rail__hint">{entry.hint}</p>
          <ul className="canvas-asset-rail__list">
            {LAYER_EXAMPLES.map((name) => (
              <li key={name} className="canvas-asset-rail__list-item">
                <LayersIcon size={14} />
                <span>{name}</span>
              </li>
            ))}
          </ul>
          <p className="canvas-asset-rail__note">以上为示例条目，画布节点接入后替换。</p>
        </>
      ) : (
        <p className="canvas-asset-rail__hint">{entry.hint}</p>
      )}
    </section>
  );
}
