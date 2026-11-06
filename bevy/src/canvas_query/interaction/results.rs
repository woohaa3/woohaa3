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
    SceneAreaPlayback {
        node_id: String,
        control: String,
        track: [f32; 4],
    },
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
    /// 多选横条动作命中（change: canvas-grouping-redesign）。
    ///
    /// 仅当 ≥2 节点被选中且 scene 携带 `selectionActions` 时存在。`action_id` 由贡献层派发。
    SelectionAction {
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
