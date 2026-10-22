//! drag-touch probe 与查询结果 DTO
//! （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，design D2/D3）。
//!
//! 这些是 2D interaction query 的跨边界小型结果；只含稳定语义 identity，不含命令、
//! 规范场景或 Yjs 数据。

use serde::Serialize;

/// 点命中结果：稳定语义 identity，不含命令副作用（与 TS 旧 `HitTarget` 同构）。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum PointHit {
    AggregateHandle {
        direction: String,
    },
    Node {
        node_id: String,
    },
    History {
        node_id: String,
    },
    ModelPreview {
        node_id: String,
    },
    /// 片场范围命中（纯模型片场，change: 2026-10-08-make-film-set-model-only）。
    FilmScope {
        node_id: String,
    },
    /// 拍摄镜头预览卡片**内容区**命中
    /// （change: 2026-10-15-add-film-set-shooting-shot-previews，design D6）。
    ///
    /// 只有内容区建立拍摄播放资格；标题区、卡片边框、归属线与相机标记保持普通 `Node`
    /// 命中（或被其它控件的命中优先消费），不得作为开播入口。归属（filmSetNodeId/clipId）
    /// 是权威 nodeData，由宿主从当前画布读取，命中只表达「指针落在该卡片内容区」。
    ShotPreview {
        node_id: String,
    },
    Port {
        node_id: String,
        side: String,
    },
    /// resize 抓手命中；可携带抓手方向 `n/ne/e/se/s/sw/w/nw`（复合资产 8 抓手）。
    Resize {
        node_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        handle: Option<String>,
    },
    Edge {
        edge_id: String,
    },
    EdgeDelete {
        edge_id: String,
    },
    /// 顶部操作横条动作命中（change: 2026-10-13-add-node-to-film-set-shortcut）。
    ///
    /// `menu` 为真表示命中该动作的独立设置箭头；否则为动作本体。`action_id` 由贡献层派发。
    NodeAction {
        node_id: String,
        action_id: String,
        #[serde(default)]
        menu: bool,
    },
}

/// drag-touch probe 候选：稳定节点 identity 与连接能力，供 JS 过滤后决定待提交边。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeCandidate {
    pub(crate) node_id: String,
    /// 相对拖动节点的方向：`"prev"`（落在左侧）/ `"next"`（落在右侧）。
    pub(crate) direction: String,
    /// 该节点是否可作为连线目标（非 group、非 ghost）。
    pub(crate) connectable: bool,
}

/// 点查询结果包络；`available=false` 时 `reason` 为稳定 `unavailable` / `stale`。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PointQueryResult {
    pub(crate) available: bool,
    pub(crate) reason: Option<String>,
    pub(crate) generation: u32,
    pub(crate) hit: Option<PointHit>,
}

/// 框选查询结果。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MarqueeQueryResult {
    pub(crate) available: bool,
    pub(crate) reason: Option<String>,
    pub(crate) generation: u32,
    pub(crate) node_ids: Vec<String>,
}

/// probe 查询结果。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeQueryResult {
    pub(crate) available: bool,
    pub(crate) reason: Option<String>,
    pub(crate) generation: u32,
    pub(crate) candidates: Vec<ProbeCandidate>,
}

/// 通用 drop target 查询结果：只返回最上层**实际**节点的 identity，不做业务过滤
/// （change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D5）。
///
/// `available=true` 且 `target_node_id=None` 表示查询成功但该点无节点（继续普通移动）；
/// `available=false` 表示查询不可用/过期，调用方 MUST NOT 回退 TS 矩形几何或提交移动。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DropTargetQueryResult {
    pub(crate) available: bool,
    pub(crate) reason: Option<String>,
    pub(crate) generation: u32,
    pub(crate) target_node_id: Option<String>,
}

/// 单个复合资产范围几何读取条目：nodeId、形状与派生顶点/AABB/基准矩形。
///
/// 只承载拖动提示所需轻量几何，不返回 SceneIR、mesh 或完整 scene JSON
/// （change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D5）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScopeGeometryEntry {
    pub(crate) node_id: String,
    /// `rect` / `isometric-diamond`。
    pub(crate) shape: String,
    /// 闭合多边形顶点 `[x, y]`（rect 为四角，地面矩形为 top/right/bottom/left）。
    pub(crate) vertices: [[f32; 2]; 4],
    /// 8 抓手中心 `[x, y]`：`n, ne, e, se, s, sw, w, nw`。
    pub(crate) handles: [[f32; 2]; 8],
    pub(crate) aabb: [f32; 4],
    /// 内容适配基准矩形 `[x, y, width, height]`。
    pub(crate) base: [f32; 4],
}

/// 复合资产范围几何查询结果（拖动提示消费）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScopeGeometryQueryResult {
    pub(crate) available: bool,
    pub(crate) reason: Option<String>,
    pub(crate) generation: u32,
    pub(crate) scopes: Vec<ScopeGeometryEntry>,
}
