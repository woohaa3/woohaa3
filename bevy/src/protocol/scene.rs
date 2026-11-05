//! 画布快照：节点、边、选择、视口、草稿、画布尺寸与聚焦投影的 DTO 与整体校验
//! （change: refactor-bevy-rust-file-size，任务 2.1 / design D3）。

use serde::Deserialize;

use super::image_focus::ImageFocus;
use super::model::ModelReference;
use super::scene_instant::{
    AggregateConnect, AnimationPlayback, Draft, DragAttach, Marquee, ModelEditor, ModelFocus,
    NodeActions, NodeHover, SurfaceSize,
};
use super::theme::Theme;
use super::video_focus::VideoFocus;
use super::{CANVAS_RENDER_SCENE_VERSION, DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH};

/// 节点画布外壳（Render Scene v38 `node.chrome`）。
///
/// `card` 是历史内容卡片；`frame` 是 2D 组的包围框（成员身份随字段下发）；`none`
/// 表示该节点只作为世界对象/选择身份存在，不得绘制内容卡片、端口或纹理。
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum NodeChrome {
    Card,
    Frame {
        #[serde(default, rename = "groupId")]
        group_id: String,
        #[serde(default, rename = "memberNodeIds")]
        member_node_ids: Vec<String>,
    },
    None,
}

impl Default for NodeChrome {
    fn default() -> Self {
        Self::Card
    }
}

impl NodeChrome {
    pub(crate) fn is_card(&self) -> bool {
        matches!(self, Self::Card)
    }

    pub(crate) fn is_none(&self) -> bool {
        matches!(self, Self::None)
    }

    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if let Self::Frame {
            group_id,
            member_node_ids,
        } = self
        {
            if group_id.is_empty() || group_id.len() > 256 {
                return Err("Invalid node chrome group id");
            }
            if member_node_ids.len() > 512
                || member_node_ids
                    .iter()
                    .any(|id| id.is_empty() || id.len() > 256)
            {
                return Err("Invalid node chrome members");
            }
        }
        Ok(())
    }
}

#[derive(Clone, Deserialize)]
pub(crate) struct GraphNode {
    #[serde(default, rename = "sharedWorldInstance", deserialize_with = "super::shared_world::deserialize_instance")]
    pub(crate) shared_world_instance: Option<super::shared_world::WorldInstance>,
    /// Shared-world camera pose/projection (Render Scene v39). The node keeps its card
    /// identity; the renderer draws and picks a frustum from this pose.
    #[serde(default, rename = "worldCamera", deserialize_with = "super::world_camera::deserialize_camera")]
    pub(crate) world_camera: Option<super::world_camera::WorldCamera>,
    /// 可选画布外壳；缺省 `card` 保持旧帧兼容。
    #[serde(default)]
    pub(crate) chrome: NodeChrome,
    #[serde(default, rename = "modelPreview")]
    pub(crate) model_preview: Option<ModelPreview>,
    pub(crate) id: String,
    #[serde(rename = "type")]
    pub(crate) kind: String,
    pub(crate) x: f32,
    pub(crate) y: f32,
    #[serde(default = "default_node_width")]
    pub(crate) width: f32,
    #[serde(default = "default_node_height")]
    pub(crate) height: f32,
    #[serde(default)]
    pub(crate) body: String,
    /// 作品主标题（change: 2026-10-09-improve-canvas-workflow，任务 2.2）。缺失回退空串，
    /// 渲染时再回退到 `card_label`/分类名，保证旧帧不空白。
    #[serde(default)]
    pub(crate) title: String,
    /// 次要类型标记（中文）。与主标题分列布局，先给历史/关闭控件留空间。
    #[serde(default, rename = "typeLabel")]
    pub(crate) type_label: String,
    #[serde(default)]
    pub(crate) progress: f32,
    /// 该运行开始的 Unix epoch 毫秒（change: 2026-10-31-unify-node-and-activity-progress）。
    ///
    /// 由运行状态投影从该 run 记录的 `createdAt` 派生，节点进度环据此按经过时间估算，因此与
    /// 活动面板共用同一个起点。缺失时退回本渲染器内「首次进入运行态」的本地时钟。
    #[serde(default, rename = "progressStartedAt")]
    pub(crate) progress_started_at: Option<f64>,
    #[serde(default)]
    pub(crate) busy: bool,
    #[serde(default, rename = "mediaLoading")]
    pub(crate) media_loading: bool,
    #[serde(default)]
    pub(crate) texture: bool,
    /// 是否绘制右下角 resize 抓手（仅单选节点，change: add-node-resize）。
    #[serde(default)]
    pub(crate) resizable: bool,
    /// 上传中的幽灵节点：只渲染、不可交互（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
    /// 2D interaction query 必须跳过它；映射层保证真实节点接管后同 id 的 ghost 不再下发。
    #[serde(default)]
    pub(crate) ghost: bool,
    /// 卡片分类名覆盖（自包含 3D 节点：`3D 模型`/`3D 片场`）。
    /// 缺失时回落到主题 palette 分类名（change: 2026-10-05-bind-model-animation-to-shots）。
    #[serde(default, rename = "cardLabel")]
    pub(crate) card_label: Option<String>,
    #[serde(default)]
    pub(crate) model: Option<ModelReference>,
    /// 节点下方独立历史条（change: 2026-10-12-unify-generation-history-strip）。
    /// 缺失即不绘制（group / 复合资产 / 无记录）。
    #[serde(default, rename = "historyStrip")]
    pub(crate) history_strip: Option<HistoryStripPresentation>,
}

/// 历史条圆点状态（change: 2026-10-12-unify-generation-history-strip）。
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryStripDot {
    #[serde(default)]
    pub(crate) selected: Option<bool>,
    #[serde(default)]
    pub(crate) hovered: bool,
    #[serde(default)]
    pub(crate) pressed: bool,
    #[serde(default)]
    pub(crate) unseen: bool,
    #[serde(default)]
    pub(crate) presentation_id: Option<String>,
    #[serde(default)]
    pub(crate) entry_id: Option<String>,
    #[serde(default)]
    pub(crate) operation_id: Option<String>,
    #[serde(default)]
    pub(crate) recoverable: Option<bool>,
    pub(crate) state: String,
    #[serde(default)]
    pub(crate) current: bool,
}

/// 节点下方独立历史条呈现（change: 2026-10-12-unify-generation-history-strip）。
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryStripPresentation {
    #[serde(default)]
    pub(crate) dots: Vec<HistoryStripDot>,
    #[serde(default)]
    pub(crate) truncated: u32,
}

impl HistoryStripPresentation {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.dots.len() > 64 {
            return Err("Too many history strip dots");
        }
        for dot in &self.dots {
            if !matches!(
                dot.state.as_str(),
                "succeeded"
                    | "failed"
                    | "running"
                    | "queued"
                    | "cancelled"
                    | "interrupted"
                    | "partial"
            ) {
                return Err("Invalid history strip dot state");
            }
        }
        Ok(())
    }
}

/// Browser-local orbit view; never a persisted model camera.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelPreview {
    pub(crate) azimuth: f32,
    pub(crate) elevation: f32,
    pub(crate) distance_scale: f32,
    #[serde(default)]
    pub(crate) target_offset: [f32; 3],
}

fn default_node_width() -> f32 {
    DEFAULT_NODE_WIDTH
}

fn default_node_height() -> f32 {
    DEFAULT_NODE_HEIGHT
}

#[derive(Clone, Deserialize)]
pub(crate) struct Edge {
    pub(crate) id: String,
    pub(crate) source: String,
    pub(crate) target: String,
    #[serde(default)]
    pub(crate) label: String,
}

#[derive(Clone, Default, Deserialize)]
pub(crate) struct Selection {
    pub(crate) nodes: Vec<String>,
    pub(crate) edge: Option<String>,
}

#[derive(Clone, Deserialize)]
pub(crate) struct Viewport {
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) zoom: f32,
}

impl std::fmt::Debug for Viewport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Viewport {{ x: {}, y: {}, zoom: {} }}",
            self.x, self.y, self.zoom
        )
    }
}

impl Default for Viewport {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
        }
    }
}

/// Bevy 渲染的唯一输入快照（最新覆盖旧值）。
#[derive(Clone, Default, Deserialize)]
pub(crate) struct Scene {
    /// Live assistant execution, never canonical or derived from history selection.
    #[serde(default, rename = "executingScopes")]
    pub(crate) executing_scopes: Vec<String>,
    #[serde(default, rename = "worldCameraEdit")]
    pub(crate) world_camera_edit: Option<WorldCameraEdit>,
    #[serde(default, rename = "sceneAreas")]
    pub(crate) scene_areas: Vec<SceneArea>,
    /// 画布快照协议版本；必须与 `CANVAS_RENDER_SCENE_VERSION` 一致，否则拒绝整帧
    /// （change: optimize-model-scene-snapshot-hot-path）。
    #[serde(default)]
    pub(crate) version: String,
    /// 文档身份（画布 id，v33 起由客户端必传）。
    ///
    /// `revision` 是**单个文档**的版本号，跨画布没有可比性：投影的单调保护必须按身份重置，
    /// 否则切到 revision 更小的画布时整帧都会被判「代数倒退」而丢弃
    /// （change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs 的投影保护）。
    ///
    /// 缺失或为空表示来源未提供身份：此时维持进程内单调语义（旧客户端/测试）。
    #[serde(default, rename = "canvasId")]
    pub(crate) canvas_id: String,
    pub(crate) nodes: Vec<GraphNode>,
    #[serde(default, rename = "modelFocusContext")]
    pub(crate) model_focus_context: Vec<FocusContextNode>,
    pub(crate) edges: Vec<Edge>,
    #[serde(default)]
    pub(crate) selection: Selection,
    #[serde(default)]
    pub(crate) viewport: Viewport,
    #[serde(default)]
    pub(crate) draft: Option<Draft>,
    /// 框选选区矩形（change: fix-group-and-marquee-preview）。缺失即无框选。
    #[serde(default)]
    pub(crate) marquee: Option<Marquee>,
    #[serde(default)]
    pub(crate) surface: Option<SurfaceSize>,
    #[serde(default)]
    pub(crate) revision: u32,
    /// 当前主题（change: unify-application-theme-tokens）。
    ///
    /// change: 2026-10-07-remove-residual-compatibility —— 必填；缺失/非法由接受点拒绝，
    /// 不再回退 generated 默认（默认 preset 仍由 canonical token source 供明确初始化/测试使用）。
    pub(crate) theme: Theme,
    /// 模型聚焦瞬时投影（change: add-model-focus-viewing）。缺失即普通正交画布。
    #[serde(default, rename = "modelFocus")]
    pub(crate) model_focus: Option<ModelFocus>,
    /// 图片聚焦瞬时投影
    /// （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，design D2）。
    /// 缺失即普通画布；携带时只渲染聚焦图片内容，隐藏其它节点/边/标签。
    #[serde(default, rename = "imageFocus")]
    pub(crate) image_focus: Option<ImageFocus>,
    /// 视频聚焦瞬时投影
    /// （change: 2026-10-10-add-video-node-focus-workspace，design D2）。
    /// 缺失即普通画布；携带时只渲染聚焦视频内容，隐藏其它节点/边/标签。与 `image_focus` 互斥。
    #[serde(default, rename = "videoFocus")]
    pub(crate) video_focus: Option<VideoFocus>,
    /// 模型编辑 gizmo/镜头工具瞬时态
    /// （change: add-model-editor-gizmo-shot-capture）。缺失即不绘制编辑 gizmo。
    #[serde(default, rename = "modelEditor")]
    pub(crate) model_editor: Option<ModelEditor>,
    /// 节点端点 / 连线悬停瞬时态
    /// （change: add-node-endpoint-hover / add-edge-hover-delete）。
    /// 缺失即所有端点静止不绘制、所有连线不显示删除按钮。
    #[serde(default)]
    pub(crate) hover: Option<NodeHover>,
    /// 单节点拖动中的 Q/E 触碰粘连瞬时投影
    /// （change: add-drag-touch-connections）。缺失即不绘制操作条。
    #[serde(default, rename = "dragAttach")]
    pub(crate) drag_attach: Option<DragAttach>,
    /// 多选聚合拉线瞬时投影
    /// （change: add-multi-select-aggregate-connect）。缺失即不绘制聚合把手。
    #[serde(default, rename = "aggregateConnect")]
    pub(crate) aggregate_connect: Option<AggregateConnect>,
    /// 活动动画节点的播放瞬时投影
    /// （change: 2026-10-05-bind-model-animation-to-shots）。缺失即无活动动画节点。
    #[serde(default, rename = "animationPlayback")]
    pub(crate) animation_playback: Option<AnimationPlayback>,
    /// 公共聚焦过渡进度瞬时更新
    /// （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D6/D7）。
    ///
    /// 携带时 Rust 三维聚焦相机按该公共进度求值（不再独立计时）；缺失则回退既有内部计时。
    /// 与 full scene 同帧接受：更小 runtime generation 的进度在同步系统内被丢弃。
    #[serde(default, rename = "focusTransition")]
    pub(crate) focus_transition: Option<super::focus_transition::FocusTransitionProgress>,
    /// 每节点的顶部操作横条描述，按节点 id keyed
    /// （change: 2026-10-13-add-node-to-film-set-shortcut）。
    ///
    /// 横条由 Bevy 绘制、Rust 命中，因此内容必须随 scene 下发。缺失或某节点缺失即不绘制该节点
    /// 横条；动作世界矩形由 `canvas_query::layout::node_action_toolbar` 与 contracts 同一公式派生。
    #[serde(default, rename = "nodeActions")]
    pub(crate) node_actions: std::collections::HashMap<String, NodeActions>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SceneArea {
    pub(crate) node_id: String,
    /// Display name resolved by the web scene builder (explicit title or “导演区 N”).
    #[serde(default)]
    pub(crate) title: String,
    pub(crate) bounds: SceneAreaBounds,
    #[serde(default)]
    pub(crate) playback: Option<SceneAreaPlayback>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct SceneAreaPlayback {
    pub(crate) time: f32,
    pub(crate) duration: f32,
    pub(crate) playing: bool,
    pub(crate) r#loop: bool,
}

#[derive(Clone, Deserialize)]
pub(crate) struct SceneAreaBounds { pub(crate) min: SceneAreaPoint, pub(crate) max: SceneAreaPoint }

#[derive(Clone, Deserialize)]
pub(crate) struct SceneAreaPoint { pub(crate) u: f64, pub(crate) v: f64 }

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FocusContextNode {
    pub(crate) node_id: String,
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) width: f32,
    pub(crate) height: f32,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct WorldCameraEdit {
    pub(crate) node_id: String,
    pub(crate) camera: super::WorldCamera,
    #[serde(default = "default_camera_editor_helpers")]
    pub(crate) show_helpers: bool,
}

fn default_camera_editor_helpers() -> bool { true }

impl Scene {
    /// 边界级防御校验；错误文案与重构前 `set_scene` 保持一致。
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        self.validate_version()?;
        self.theme.validate()?;
        if let Some(edit) = &self.world_camera_edit {
            edit.camera.validate()?;
            if self.model_focus.is_some() || self.image_focus.is_some() || self.video_focus.is_some()
                || !self.nodes.iter().any(|node| node.id == edit.node_id
                    && node.world_camera.as_ref().is_some_and(|camera| camera.camera_id == edit.camera.camera_id))
            {
                return Err("Invalid world camera editor");
            }
        }
        let mut context_ids = std::collections::HashSet::new();
        for entry in &self.model_focus_context {
            if self
                .model_focus
                .as_ref()
                .is_none_or(|f| f.node_id == entry.node_id)
                || !self.nodes.iter().any(|n| n.id == entry.node_id)
                || !context_ids.insert(&entry.node_id)
                || ![entry.x, entry.y, entry.width, entry.height]
                    .iter()
                    .all(|v| v.is_finite())
                || entry.width <= 0.
                || entry.height <= 0.
            {
                return Err("Invalid model focus context");
            }
        }
        for node in &self.nodes {
            if let Some(instance) = &node.shared_world_instance { instance.validate()?; }
            if let Some(camera) = &node.world_camera { camera.validate()?; }
            node.chrome.validate()?;
            if node
                .progress_started_at
                .is_some_and(|started| !started.is_finite() || started < 0.0)
            {
                return Err("Invalid node progress start");
            }
            if node.resizable
                && (self.selection.nodes.len() != 1 || self.selection.nodes[0] != node.id)
            {
                return Err("Invalid resize projection");
            }
            if let Some(view) = &node.model_preview {
                if ![view.azimuth, view.elevation, view.distance_scale]
                    .iter()
                    .chain(view.target_offset.iter())
                    .all(|v| v.is_finite())
                    || view.elevation.abs() >= std::f32::consts::FRAC_PI_2
                    || view.distance_scale <= 0.
                {
                    return Err("Invalid model preview");
                }
            }
            if let Some(strip) = &node.history_strip {
                strip.validate()?;
            }
        }
        // 缩放区间必须与 contracts 的 `WOOHAA3_CANVAS_MIN_ZOOM` / `WOOHAA3_CANVAS_MAX_ZOOM`
        // 一致（0.1–12）；由 `render-scene.test.ts` 断言两边相同。此前这里是 0.2–2.0，
        // 导致捏合超过 2 倍时 set_scene 抛错并终止帧循环（change: fix-viewport-zoom-range）。
        if !self.viewport.zoom.is_finite() || !(0.1..=12.0).contains(&self.viewport.zoom) {
            return Err("Invalid viewport zoom");
        }
        if let Some(surface) = &self.surface {
            if ![surface.width, surface.height, surface.pixel_ratio]
                .iter()
                .all(|v| v.is_finite())
                || !(1.0..=16384.0).contains(&surface.width)
                || !(1.0..=16384.0).contains(&surface.height)
                || !(0.1..=4.0).contains(&surface.pixel_ratio)
            {
                return Err("Invalid canvas size");
            }
        }
        if let Some(rect) = self
            .surface
            .as_ref()
            .and_then(|surface| surface.content_rect.as_ref())
        {
            if ![rect.x, rect.y, rect.width, rect.height]
                .iter()
                .all(|v| v.is_finite())
                || rect.x < 0.0
                || rect.y < 0.0
                || rect.width <= 0.0
                || rect.height <= 0.0
            {
                return Err("Invalid focus content rect");
            }
        }
        if let Some(focus) = &self.model_focus {
            focus.validate()?;
        }
        if let Some(focus) = &self.image_focus {
            focus.validate()?;
        }
        if let Some(focus) = &self.video_focus {
            focus.validate()?;
        }
        if let Some(editor) = &self.model_editor {
            editor.validate()?;
        }
        if let Some(progress) = &self.focus_transition {
            progress.validate()?;
        }
        if let Some(attach) = &self.drag_attach {
            attach.validate()?;
        }
        if let Some(aggregate) = &self.aggregate_connect {
            aggregate.validate()?;
        }
        for actions in self.node_actions.values() {
            actions.validate()?;
        }
        Ok(())
    }

    /// 协议版本必须一致：旧 Frontend/WASM 组合按版本拒绝，不静默降级为缺模型画面。
    fn validate_version(&self) -> Result<(), &'static str> {
        if self.version != CANVAS_RENDER_SCENE_VERSION {
            return Err("Unsupported canvas render scene version");
        }
        Ok(())
    }
}
