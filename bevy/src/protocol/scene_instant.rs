//! 画布瞬时投影 DTO：草稿、框选、悬停、拖动粘连、聚合拉线与模型聚焦/编辑
//! （change: refactor-bevy-rust-file-size 后续拆分；从 `scene` 拆出保持在文件体积上限内）。

use serde::Deserialize;

#[derive(Clone, Deserialize, PartialEq)]
pub(crate) struct Draft {
    pub(crate) source: String,
    pub(crate) side: String,
    pub(crate) x: f32,
    pub(crate) y: f32,
}

/// 框选选区矩形（change: fix-group-and-marquee-preview）。
///
/// 世界坐标轴对齐矩形；`width`/`height` 可为负（拖拽方向决定），渲染时归一化。
/// 只承载浏览器本地瞬时呈现态，不进入 ServerCanvas / Y.Doc。
#[derive(Clone, Deserialize, PartialEq)]
pub(crate) struct Marquee {
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) width: f32,
    pub(crate) height: f32,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SurfaceSize {
    pub(crate) width: f32,
    pub(crate) height: f32,
    pub(crate) pixel_ratio: f32,
    /// 右侧遮挡宽度（CSS 像素）。缺省为 0，表示内容区铺满表面。
    #[serde(default)]
    pub(crate) content_right: f32,
    #[serde(default)]
    pub(crate) content_rect: Option<FocusContentRect>,
    /// 表面相对窗口客户区左上角的偏移（CSS 像素）。桌面顶栏把画布往下推时非 0。
    /// 缺省为 0：表面从窗口原点铺开，与浏览器画布一致。
    #[serde(default)]
    pub(crate) origin_x: f32,
    #[serde(default)]
    pub(crate) origin_y: f32,
}

#[derive(Clone, Deserialize)]
pub(crate) struct FocusContentRect {
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) width: f32,
    pub(crate) height: f32,
}

/// 指针悬停瞬时态（change: add-node-endpoint-hover / add-edge-hover-delete）。
///
/// 只承载浏览器本地呈现态：指针下的节点（含端点侧）**或**连线 id；不进入 ServerCanvas / Y.Doc。
/// 两种形态共存于一个结构：`node_id` 存在即节点悬停（`edge_id` 为空）；`edge_id` 存在即连线悬停。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NodeHover {
    /// 指针下的节点 id；连线悬停时缺省。
    #[serde(default)]
    pub(crate) node_id: Option<String>,
    /// 指针落在某侧端点命中区时的端点侧（`"input"` / `"output"`）；否则缺省/`null`。
    #[serde(default)]
    pub(crate) port: Option<String>,
    /// 指针下的连线 id；节点悬停时缺省。
    #[serde(default)]
    pub(crate) edge_id: Option<String>,
}

/// 待提交连线（拖动粘连与聚合拉线预览共用）
/// （change: add-drag-touch-connections / add-multi-select-aggregate-connect）。
///
/// 只承载绘制虚线预览所需的最小身份：稳定 edge id 与有向端点对。
#[derive(Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DragAttachEdge {
    pub(crate) id: String,
    pub(crate) source: String,
    pub(crate) target: String,
}

/// 拖拽中的指针世界坐标（对象形态，与 contracts `{ x, y }` 一致）。
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub(crate) struct CursorPoint {
    pub(crate) x: f32,
    pub(crate) y: f32,
}

/// 多选聚合拉线瞬时投影（change: add-multi-select-aggregate-connect，design D5）。
///
/// 字段存在即表示应显示选区左右聚合把手；`direction` 表示正在拖拽的方向（缺省=仅显示把手）；
/// `cursor` 为拖拽中的指针世界坐标；`pending_edges` 为拖拽中命中的合法预览边。
/// 只承载浏览器本地呈现态，不进入 ServerCanvas / Y.Doc。
#[derive(Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AggregateConnect {
    /// 正在拖拽的方向（`"input"` / `"output"`）；仅显示把手时缺省/`null`。
    #[serde(default)]
    pub(crate) direction: Option<String>,
    /// 拖拽中的指针世界坐标（仅拖拽中存在）。
    #[serde(default)]
    pub(crate) cursor: Option<CursorPoint>,
    /// 拖拽中命中的待提交边预览。
    #[serde(default)]
    pub(crate) pending_edges: Vec<DragAttachEdge>,
}

impl AggregateConnect {
    /// 边界级防御校验：方向枚举、有限指针坐标与预览边数量/身份。
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if let Some(direction) = &self.direction {
            if direction != "input" && direction != "output" {
                return Err("Invalid aggregate connect direction");
            }
        }
        if let Some(cursor) = self.cursor {
            if !cursor.x.is_finite() || !cursor.y.is_finite() {
                return Err("Invalid aggregate connect cursor");
            }
        }
        if self.pending_edges.len() > 1024 {
            return Err("Too many aggregate connect pending edges");
        }
        validate_pending_edges(&self.pending_edges)
    }
}

/// 单节点拖动粘连瞬时投影（change: add-drag-touch-connections，design D5）。
///
/// 字段存在即表示应显示底部操作条；`mode` 决定活动提示与触须侧；`contact_node_id`
/// 驱动接触反馈；`pending_edges` 绘制立即可见的虚线预览。只承载浏览器本地呈现态，
/// 不进入 ServerCanvas / Y.Doc。
#[derive(Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DragAttach {
    /// 当前被拖动的节点 id。
    pub(crate) node_id: String,
    /// 当前活动粘连方向（`"predecessor"` / `"successor"`）；未按住 Q/E 时为 `null`/缺省。
    #[serde(default)]
    pub(crate) mode: Option<String>,
    /// 当前触须接触到的合法目标节点 id；无接触时缺省。
    #[serde(default)]
    pub(crate) contact_node_id: Option<String>,
    /// 本次拖动已锁定的待提交边（按锁定顺序）。
    #[serde(default)]
    pub(crate) pending_edges: Vec<DragAttachEdge>,
}

impl DragAttach {
    /// 边界级防御校验：id 长度、模式枚举与待提交边合法性。
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.node_id.is_empty() || self.node_id.len() > 128 {
            return Err("Invalid drag attach node id");
        }
        if let Some(mode) = &self.mode {
            if mode != "predecessor" && mode != "successor" {
                return Err("Invalid drag attach mode");
            }
        }
        if let Some(contact) = &self.contact_node_id {
            if contact.is_empty() || contact.len() > 128 {
                return Err("Invalid drag attach contact id");
            }
        }
        if self.pending_edges.len() > 1024 {
            return Err("Too many drag attach pending edges");
        }
        validate_pending_edges(&self.pending_edges)
    }
}

/// 节点顶部操作横条的动作描述（change: 2026-10-13-add-node-to-film-set-shortcut）。
///
/// 横条由 Bevy 在画布内绘制、由 Rust interaction snapshot 命中；前端贡献层把动作与摘要作为
/// **纯数据**下发。只承载呈现与命中所需字段，不含命令副作用，不进入 ServerCanvas / Y.Doc。
#[derive(Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NodeAction {
    #[serde(default)]
    pub(crate) tone: String,
    #[serde(default)]
    pub(crate) icon: Option<String>,
    #[serde(default)]
    pub(crate) icon_only: bool,
    /// 稳定动作 ID；命中后回传，贡献据此派生。
    pub(crate) id: String,
    /// 可见文案（中文）。
    pub(crate) label: String,
    /// 是否可用；false 时弱化绘制，仍回传命中由贡献决定是否响应。
    #[serde(default)]
    pub(crate) enabled: bool,
    /// 是否为独立设置箭头（图片/视频转换）；箭头自身是独立命中矩形。
    #[serde(default)]
    pub(crate) menu: bool,
}

/// 节点顶部操作横条呈现：动作列表 + 可选模型名摘要。
#[derive(Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NodeActions {
    /// 从左到右排列的动作。
    pub(crate) actions: Vec<NodeAction>,
    /// 模型名摘要（可选，显示在动作右侧）。
    #[serde(default)]
    pub(crate) summary: Option<String>,
}

impl NodeActions {
    /// 边界级防御校验：动作数量、id/文案长度。
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.actions.len() > 16 {
            return Err("Too many node actions");
        }
        for action in &self.actions {
            if !matches!(action.tone.as_str(), "" | "primary" | "neutral")
                || action.icon.as_deref().is_some_and(|icon| {
                    !matches!(
                        icon,
                        "download"
                            | "edit"
                            | "arrange-horizontal"
                            | "arrange-vertical"
                            | "arrange-grid"
                            | "arrange-diagonal-up"
                            | "arrange-diagonal-down"
                            | "collapse-groups"
                            | "expand-groups"
                    )
                })
                || action.icon_only && action.icon.is_none()
            {
                return Err("Invalid node action presentation");
            }
            if action.id.is_empty() || action.id.len() > 128 || action.label.len() > 256 {
                return Err("Invalid node action");
            }
        }
        if let Some(summary) = &self.summary {
            if summary.len() > 512 {
                return Err("Invalid node action summary");
            }
        }
        Ok(())
    }
}

/// 待提交边共同校验：非空 id/端点、端点不相同。
fn validate_pending_edges(edges: &[DragAttachEdge]) -> Result<(), &'static str> {
    for edge in edges {
        if edge.id.is_empty()
            || edge.id.len() > 128
            || edge.source.is_empty()
            || edge.source.len() > 128
            || edge.target.is_empty()
            || edge.target.len() > 128
            || edge.source == edge.target
        {
            return Err("Invalid pending edge");
        }
    }
    Ok(())
}

/// 聚焦相机瞬时投影（change: add-model-focus-viewing，design D1/D2）。
///
/// 只承载稳定目标 id 与浏览器本地相机 pose；不进入 ServerCanvas / Y.Doc。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelFocus {
    /// schema 版本。
    #[serde(default)]
    pub(crate) version: String,
    /// 稳定 canonical 节点 id。
    pub(crate) node_id: String,
    /// 聚焦中心（Bevy 世界坐标）。
    pub(crate) target: [f32; 3],
    pub(crate) yaw: f32,
    pub(crate) pitch: f32,
    pub(crate) distance: f32,
    pub(crate) fov: f32,
    /// 目标包围球半径（查看指示用）。
    #[serde(default = "default_focus_radius")]
    pub(crate) radius: f32,
}

fn default_focus_radius() -> f32 {
    1.0
}

pub(crate) const MODEL_FOCUS_VERSION: &str = "woohaa-model-focus-v1";

impl ModelFocus {
    /// 边界级防御校验：版本、id、有限 pose、距离/FOV 范围。
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.version != MODEL_FOCUS_VERSION {
            return Err("Unknown model focus version");
        }
        if self.node_id.is_empty() || self.node_id.len() > 128 {
            return Err("Invalid model focus node id");
        }
        if ![
            self.target[0],
            self.target[1],
            self.target[2],
            self.yaw,
            self.pitch,
            self.distance,
            self.fov,
            self.radius,
        ]
        .iter()
        .all(|v| v.is_finite())
        {
            return Err("Invalid model focus camera");
        }
        // 与 Web `MODEL_FOCUS_MIN/MAX_DISTANCE` 一致。上限必须盖住画布放大后的取景距离，
        // 否则 orbit rig 会把相机钳回网格内部，近裁剪面切掉朝向镜头的部位。
        if !(0.4..=10_000_000.0).contains(&self.distance) {
            return Err("Invalid model focus distance");
        }
        if !(0.1..=3.0).contains(&self.fov) {
            return Err("Invalid model focus fov");
        }
        if !(0.0..=1e6).contains(&self.radius) {
            return Err("Invalid model focus radius");
        }
        Ok(())
    }
}

/// 模型编辑工具瞬时态（change: add-model-editor-gizmo-shot-capture，design D1/D3）。
///
/// 只承载浏览器本地编辑态：Bevy 只据此绘制可丢弃的 gizmo 与镜头 frustum，不持有
/// canonical selection、命令提交或镜头持久化所有权。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelEditor {
    /// schema 版本。
    #[serde(default)]
    pub(crate) version: String,
    /// 编辑目标 canonical 模型节点 id。
    pub(crate) node_id: String,
    /// 工具模式："model" | "camera"。
    pub(crate) tool_mode: String,
    #[serde(default)]
    pub(crate) grid: Option<EditorGrid>,
    #[serde(default)]
    pub(crate) feedback: Option<GizmoFeedback>,
    /// 显式镜头工具："orbit" | "distance" | "focus"
    /// （change: fix-model-focus-navigation-and-camera-parity，task 4.4）。
    #[serde(default)]
    pub(crate) camera_tool: Option<String>,
    /// 选中镜头 id（camera 模式）。
    #[serde(default)]
    pub(crate) camera_id: Option<String>,
    /// 聚焦模型 focus（世界坐标）。
    pub(crate) focus: [f32; 3],
    /// 模型包围球半径（gizmo 尺寸）。
    pub(crate) radius: f32,
    /// 选中镜头的派生正交相机（camera 模式）。
    #[serde(default)]
    pub(crate) shot: Option<ShotCamera>,
}

/// 选中镜头的派生透视相机（design D3；change: switch-shot-camera-to-perspective）。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShotCamera {
    pub(crate) position: [f32; 3],
    pub(crate) focus: [f32; 3],
    /// 透视垂直 FOV（弧度）。
    pub(crate) fov: f32,
    pub(crate) azimuth: f32,
    pub(crate) elevation: f32,
    pub(crate) distance: f32,
    /// 镜头画幅（change: fix-model-focus-navigation-and-camera-parity，design D8）。
    #[serde(default = "default_shot_aspect")]
    pub(crate) aspect: String,
}

fn default_shot_aspect() -> String {
    "16:9".to_owned()
}

pub(crate) use super::animation_playback::{AnimationPlayback, PlaybackCamera};

/// 受支持的镜头画幅集合（`W:H` 字面量）。
///
/// 与 Web `MODEL_CAMERA_ASPECTS` 同一集合：取景镜头与生图节点支持的画幅并集。Rust 侧只做
/// 边界级防御校验，权威列表仍在 Web contracts；这里用 `W:H` 形式解析而非硬编码比例，避免
/// 新增画幅时两处漂移。
pub(crate) const SUPPORTED_SHOT_ASPECTS: &[&str] = &[
    "16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9", "4:1", "1:4", "8:1",
    "1:8",
];

/// 校验画幅字面量是否在受支持集合内。
pub(crate) fn is_supported_shot_aspect(aspect: &str) -> bool {
    SUPPORTED_SHOT_ASPECTS.contains(&aspect)
}

/// 解析受支持的 `W:H` 画幅字面量 → 数值比例（宽 / 高）。
///
/// 非受支持或形式非法（缺分隔符、分量非正/非有限）时返回 `None`；调用方各自决定回退值。
pub(crate) fn parse_shot_aspect_ratio(aspect: &str) -> Option<f32> {
    if !is_supported_shot_aspect(aspect) {
        return None;
    }
    let (width, height) = aspect.split_once(':')?;
    let width: f32 = width.parse().ok()?;
    let height: f32 = height.parse().ok()?;
    if width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0 {
        Some(width / height)
    } else {
        None
    }
}

pub(crate) const MODEL_EDITOR_VERSION: &str = "woohaa-model-editor-v2";

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GizmoFeedback {
    pub(crate) hover: Option<String>,
    pub(crate) active: Option<String>,
    pub(crate) epoch: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EditorGrid {
    pub(crate) origin: [f32; 3],
    pub(crate) spacing: f32,
}

impl ModelEditor {
    /// 边界级防御校验：版本、id、工具模式、有限几何。
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.version != MODEL_EDITOR_VERSION {
            return Err("Unknown model editor version");
        }
        if self.node_id.is_empty() || self.node_id.len() > 128 {
            return Err("Invalid model editor node id");
        }
        if self.tool_mode != "model" && self.tool_mode != "camera" {
            return Err("Invalid model editor tool mode");
        }
        if self.grid.as_ref().is_some_and(|grid| {
            !grid.origin.iter().all(|v| v.is_finite())
                || !grid.spacing.is_finite()
                || grid.spacing <= 0.0
        }) {
            return Err("Invalid editor grid");
        }
        if let Some(feedback) = &self.feedback {
            for handle in [&feedback.hover, &feedback.active].into_iter().flatten() {
                if ![
                    "x",
                    "y",
                    "z",
                    "center",
                    "yaw-ring",
                    "scale",
                    "orbit-ring",
                    "elevation-ring",
                    "distance",
                    "shot-origin",
                ]
                .contains(&handle.as_str())
                {
                    return Err("Invalid gizmo feedback handle");
                }
            }
        }
        if let Some(tool) = &self.camera_tool {
            if tool != "orbit" && tool != "elevation" && tool != "distance" && tool != "focus" {
                return Err("Invalid model editor camera tool");
            }
        }
        if ![self.focus[0], self.focus[1], self.focus[2], self.radius]
            .iter()
            .all(|v| v.is_finite())
        {
            return Err("Invalid model editor geometry");
        }
        if let Some(camera_id) = &self.camera_id {
            if camera_id.is_empty() || camera_id.len() > 128 {
                return Err("Invalid model editor camera id");
            }
        }
        if let Some(shot) = &self.shot {
            shot.validate()?;
        }
        Ok(())
    }
}

impl ShotCamera {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if ![
            self.position[0],
            self.position[1],
            self.position[2],
            self.focus[0],
            self.focus[1],
            self.focus[2],
            self.fov,
            self.azimuth,
            self.elevation,
            self.distance,
        ]
        .iter()
        .all(|v| v.is_finite())
        {
            return Err("Invalid shot camera geometry");
        }
        if self.fov <= 0.0 || self.fov >= std::f32::consts::PI || self.distance <= 0.0 {
            return Err("Invalid shot camera size");
        }
        if !is_supported_shot_aspect(&self.aspect) {
            return Err("Invalid shot camera aspect");
        }
        Ok(())
    }
}
