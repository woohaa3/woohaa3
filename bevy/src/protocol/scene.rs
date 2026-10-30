//! 画布快照：节点、边、选择、视口、草稿、画布尺寸与聚焦投影的 DTO 与整体校验
//! （change: refactor-bevy-rust-file-size，任务 2.1 / design D3）。

use serde::Deserialize;

use super::image_focus::ImageFocus;
use super::model::ModelReference;
use super::primitives::{
    ManagedItemGroup, MediaPlane, OwnershipLink, PreviewCard, RunFeedback,
};
use super::scene_instant::{
    AggregateConnect, AnimationPlayback, Draft, DragAttach, Marquee, ModelEditor,
    ModelFocus, NodeActions, NodeHover, SurfaceSize,
};
use super::theme::Theme;
use super::video_focus::VideoFocus;
use super::{CANVAS_RENDER_SCENE_VERSION, DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH};

#[derive(Clone, Deserialize)]
pub(crate) struct GraphNode {
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
    /// group 结构容器呈现（change: add-canvas-node-grouping）。缺失即普通节点卡片。
    #[serde(default)]
    pub(crate) group: Option<GroupPresentation>,
    #[serde(default)]
    pub(crate) model: Option<ModelReference>,
    /// 片场（composite-asset）纯模型呈现
    /// （change: 2026-10-08-make-film-set-model-only）。存在即表示该节点不绘制顶部卡片、
    /// 端口、关闭/历史/resize 控件与正文，只绘制场内内容与条件性范围虚线框，也不能连线。
    #[serde(default, rename = "compositeAsset")]
    pub(crate) composite_asset: Option<CompositeAssetPresentation>,
    /// 节点下方独立历史条（change: 2026-10-12-unify-generation-history-strip）。
    /// 缺失即不绘制（group / 复合资产 / 无记录）。
    #[serde(default, rename = "historyStrip")]
    pub(crate) history_strip: Option<HistoryStripPresentation>,
    /// 聚合节点运行遮罩（change: 2026-10-12-unify-generation-history-strip）。
    /// 缺失或 `active=false` 时不绘制。
    #[serde(default, rename = "aggregateRun")]
    pub(crate) aggregate_run: Option<AggregateRunPresentation>,
    /// 派生：由场景级 `preview_cards` 按 `nodeId` 关联的预览卡片原语（渲染/命中共用）。
    ///
    /// 不是 wire 字段：接受点从通用原语索引回来，保持查询/绘制只需节点即可取得同一份事实。
    #[serde(skip)]
    pub(crate) preview_card: Option<PreviewCard>,
    /// 派生：由场景级 `run_feedback` 按 `nodeId` 关联的运行反馈原语。
    #[serde(skip)]
    pub(crate) run_feedback: Option<RunFeedback>,
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

/// 聚合节点运行遮罩呈现（change: 2026-10-12-unify-generation-history-strip；
///  change: 2026-10-28-generic-extension-content-ownership 任务 4.3）。
///
/// 只保留通用布尔；阶段/文案来自场景级 `run_feedback` 原语（按 `nodeId` 关联）。
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AggregateRunPresentation {
    #[serde(default)]
    pub(crate) active: bool,
    #[serde(default, rename = "reduceMotion")]
    pub(crate) reduce_motion: bool,
}

/// 复合资产范围形状（change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D3 修订）。
///
/// `IsometricDiamond` 为复合资产类别默认（映射层对所有 composite-asset 一律下发），即与地面投影轴
/// 平行的平行四边形（地面宽深相等时为菱形）；可信 adapter 覆盖为 `rect` 时为轴对齐矩形。
/// Rust 只消费该声明；serde 缺省 `Rect` 仅为纯几何/测试兜底（真实生产者始终声明形状），
/// 未知值 serde 拒绝整帧，不静默降级为与前端视觉不一致的矩形。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum CompositeAssetScopeShape {
    #[default]
    Rect,
    IsometricDiamond,
}

/// 复合资产总览 primitive LOD 策略声明
/// （change: 2026-10-15-add-film-set-overview-lod，design D1）。
///
/// 可信 adapter 按严格身份声明 `overview-primitives-v1` 时，运行时按世界相机下的实际模型投影
/// 尺寸为该复合资产根选择整场图元细分。未声明即 World 用途保持 High。Rust 只消费该声明，不按
/// 业务 extensionId、nodeData 形状或历史类型推断；未知值 serde 拒绝整帧。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum CompositeAssetGeometryQuality {
    OverviewPrimitivesV1,
}

/// 范围地面矩形 DTO：投影中心 `(cx, cy)` 与沿地面 +x/+z 的半球面尺寸 `(hx, hz)`（世界坐标）
/// （change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D2/D4）。
///
/// Web 映射层从模型地面占地等比外扩固定边距派生；Rust `canvas_query::scope` 展开四顶点与抓手。
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScopeGroundDto {
    pub(crate) cx: f32,
    pub(crate) cy: f32,
    pub(crate) hx: f32,
    pub(crate) hz: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub(crate) enum CompositeAssetEmptyPlaceholder {
    #[serde(rename = "brand-plinth-v1")]
    BrandPlinthV1,
}

/// 复合资产呈现字段（change: 2026-10-08-make-film-set-model-only，design D1/D2；
///  change: 2026-10-12-align-film-set-scope-with-isometric-grid 增加通用形状声明与地面矩形）。
///
/// Web 映射层派生的范围基准矩形（世界坐标）：无可见内容时使用节点锚点附近的最小范围，
/// 有内容时使用内容投影 bounds 加统一边距。复合资产类别默认 `isometric-diamond`（映射层一律
/// 下发），Rust 由 `scope_ground`（模型地面占地等比外扩）派生与地面网格平行的平行四边形
/// （`canvas_query::scope`）；可信 adapter 覆盖为 `rect` 时基准矩形即范围框。Rust 只据此绘制/命中，
/// 不重新遍历 mesh。
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompositeAssetPresentation {
    #[serde(default)]
    pub(crate) empty_placeholder: Option<CompositeAssetEmptyPlaceholder>,
    #[serde(default)]
    pub(crate) panel: Option<super::CompositeContainerPanel>,
    #[serde(default)]
    pub(crate) root_placement: Option<super::ModelPlacement>,
    #[serde(default)]
    pub(crate) content_extent: Option<f32>,
    #[serde(default)]
    pub(crate) layout_aabb: Option<super::ModelAabbDto>,
    /// 范围形状声明；缺失即通用默认 `rect`。
    #[serde(default)]
    pub(crate) scope_shape: CompositeAssetScopeShape,
    /// 总览 primitive LOD 策略声明；缺失即 World 用途保持 High
    /// （change: 2026-10-15-add-film-set-overview-lod，design D1）。
    #[serde(default)]
    pub(crate) geometry_quality: Option<CompositeAssetGeometryQuality>,
    /// 范围地面矩形（`isometric-diamond` 时必需）：投影中心 + 沿地面 +x/+z 的半球面尺寸。
    #[serde(default)]
    pub(crate) scope_ground: Option<ScopeGroundDto>,
    /// 条件性范围虚线框的**基准矩形**（世界坐标）；菱形由它派生，不写回 AABB。
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) width: f32,
    pub(crate) height: f32,
    /// 场内媒体平面（图片/视频）；缺失即无媒体平面
    /// （change: 2026-10-08-make-film-set-model-only，design D5；
    ///  change: 2026-10-28-generic-extension-content-ownership 任务 4.3：通用 `mediaPlanes`）。
    #[serde(default, rename = "mediaPlanes")]
    pub(crate) media_planes: Vec<MediaPlane>,
    /// 稳定 itemId → 组合作用域根 id（change: 2026-10-09-add-film-set-object-motion-and-editing）。
    /// 供对象模式 picking 按 item 分组派生 AABB。
    #[serde(default, rename = "itemRoots")]
    pub(crate) item_roots: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub(crate) item_placements: std::collections::HashMap<String, super::ModelPlacement>,
}

impl CompositeAssetPresentation {
    /// 范围几何必须有限且非负尺寸；媒体平面几何必须有限、正尺寸。
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if let Some(panel) = &self.panel {
            panel.validate()?;
        }
        if ![self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            || self.width < 0.0
            || self.height < 0.0
        {
            return Err("Invalid film set bounds");
        }
        if self.layout_aabb.is_some_and(|bounds| {
            (0..3).any(|i| {
                !bounds.min[i].is_finite()
                    || !bounds.max[i].is_finite()
                    || bounds.min[i] > bounds.max[i]
            })
        }) {
            return Err("Invalid film set layout bounds");
        }
        if self.item_placements.len() > 256
            || self.item_placements.iter().any(|(id, p)| {
                id.is_empty()
                    || ![p.offset.x, p.offset.y, p.offset.z, p.scale, p.yaw]
                        .iter()
                        .all(|v| v.is_finite())
                    || p.scale <= 0.0
            })
        {
            return Err("Invalid film set item placement");
        }
        for plane in &self.media_planes {
            plane.validate()?;
        }
        if self.media_planes.len() > 256 {
            return Err("Too many media planes");
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

/// group 容器的呈现字段（change: add-canvas-node-grouping，design D2）。
///
/// 位置与尺寸已由 Web 映射层投影为绝对画布几何；Rust 只据此绘制低 z 的虚线容器、
/// 标题与成员计数，不持有 parentId 或相对坐标，也不需要感知成员关系。
#[derive(Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GroupPresentation {
    #[serde(default)]
    pub(crate) collapsed: bool,
    #[serde(default = "default_badge_scale")]
    pub(crate) badge_scale: f32,
    #[serde(default)]
    pub(crate) badge_resizable: bool,
    /// 组容器是否绘制节点顶部操作横条；普通组与片场组都声明，旧场景缺省保持无横条。
    #[serde(default)]
    pub(crate) action_bar: bool,
    #[serde(default)]
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) member_count: u32,
    /// 递归叶子成员中具备输出能力的数量；>0 时才显示聚合输出端点。
    #[serde(default)]
    pub(crate) output_capable_leaf_count: u32,
    #[serde(default)]
    pub(crate) run_status: Option<GroupRunStatus>,
    #[serde(default)]
    pub(crate) model_bounds: Option<GroupModelBounds>,
    /// 总览 primitive LOD 策略声明；缺失即 group 徽标保持 High。
    ///
    /// 片场迁移为 group 后，可信 adapter 的声明经 group 呈现进入运行时；Rust 只消费该声明，
    /// 不按业务 extensionId、nodeData 形状或历史类型推断。
    #[serde(default, rename = "geometryQuality")]
    pub(crate) geometry_quality: Option<CompositeAssetGeometryQuality>,
    /// Render-only emphasis while a node is being released into this group.
    #[serde(default, rename = "dropTarget")]
    pub(crate) drop_target: bool,
}

fn default_badge_scale() -> f32 {
    1.
}

#[derive(Clone, Deserialize, PartialEq)]
pub(crate) struct GroupModelBounds {
    pub(crate) aabb: super::ModelAabbDto,
    pub(crate) extent: f32,
}

#[derive(Clone, Deserialize, PartialEq)]
pub(crate) struct GroupRunStatus {
    pub(crate) label: String,
    pub(crate) state: String,
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
    /// 画布快照协议版本；必须与 `CANVAS_RENDER_SCENE_VERSION` 一致，否则拒绝整帧
    /// （change: optimize-model-scene-snapshot-hot-path）。
    #[serde(default)]
    pub(crate) version: String,
    pub(crate) nodes: Vec<GraphNode>,
    #[serde(default, rename = "modelFocusContext")]
    pub(crate) model_focus_context: Vec<FocusContextNode>,
    pub(crate) edges: Vec<Edge>,
    /// 受管条目组原语（change: 2026-10-28-generic-extension-content-ownership 任务 4.3）。
    #[serde(default, rename = "managedItemGroups")]
    pub(crate) managed_item_groups: Vec<ManagedItemGroup>,
    /// 预览卡片原语（任务 4.3）：同一 `nodeId` 至多一项。
    #[serde(default, rename = "previewCards")]
    pub(crate) preview_cards: Vec<PreviewCard>,
    /// 归属线原语（任务 4.3）：派生呈现，独立于普通 `edges` 拓扑。
    #[serde(default, rename = "ownershipLinks")]
    pub(crate) ownership_links: Vec<OwnershipLink>,
    /// 运行反馈原语（任务 4.3）：按 `nodeId` 关联到 owner 节点。
    #[serde(default, rename = "runFeedback")]
    pub(crate) run_feedback: Vec<RunFeedback>,
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
pub(crate) struct FocusContextNode {
    pub(crate) node_id: String,
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) width: f32,
    pub(crate) height: f32,
}

impl Scene {
    /// 边界级防御校验；错误文案与重构前 `set_scene` 保持一致。
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        self.validate_version()?;
        self.theme.validate()?;
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
            if node.resizable
                && (self.selection.nodes.len() != 1 || self.selection.nodes[0] != node.id)
            {
                return Err("Invalid resize projection");
            }
            if node
                .group
                .as_ref()
                .is_some_and(|g| !g.badge_scale.is_finite() || g.badge_scale < 0.5)
            {
                return Err("Invalid group badge scale");
            }
            if let Some(bounds) = node.group.as_ref().and_then(|g| g.model_bounds.as_ref()) {
                if node.model.is_none()
                    || !bounds.extent.is_finite()
                    || bounds.extent <= 0.
                    || (0..3).any(|i| {
                        !bounds.aabb.min[i].is_finite()
                            || !bounds.aabb.max[i].is_finite()
                            || bounds.aabb.min[i] > bounds.aabb.max[i]
                    })
                {
                    return Err("Invalid group model bounds");
                }
            }
            if node
                .aggregate_run
                .as_ref()
                .is_some_and(|run| !run.active && node.run_feedback.is_none())
            {
                // `active=false` 与派生反馈互斥；反馈存在时由场景级原语驱动。
            }
            if let Some(view) = &node.model_preview {
                if ![view.azimuth, view.elevation, view.distance_scale]
                    .iter()
                    .chain(view.target_offset.iter())
                    .all(|v| v.is_finite())
                    || view.elevation.abs() >= std::f32::consts::FRAC_PI_2
                    || view.distance_scale <= 0.
                    || node.group.is_some()
                    || node.composite_asset.is_some()
                {
                    return Err("Invalid model preview");
                }
            }
            if let Some(film_set) = &node.composite_asset {
                film_set.validate()?;
            }
            if let Some(strip) = &node.history_strip {
                strip.validate()?;
            }
            if let Some(feedback) = &node.run_feedback {
                feedback.validate()?;
            }
        }
        if self.managed_item_groups.len() > 4096 {
            return Err("Too many managed item groups");
        }
        let mut group_owners = std::collections::HashSet::new();
        for group in &self.managed_item_groups {
            if !group_owners.insert(&group.owner_node_id) {
                return Err("Invalid managed item group");
            }
            group.validate(&self.nodes)?;
        }
        if self.preview_cards.len() > 4096 {
            return Err("Too many preview cards");
        }
        let mut card_nodes = std::collections::HashSet::new();
        for card in &self.preview_cards {
            card.validate()?;
            if !card_nodes.insert(&card.node_id)
                || !self.nodes.iter().any(|node| node.id == card.node_id)
                || !self.nodes.iter().any(|node| node.id == card.owner_node_id)
            {
                return Err("Invalid preview card node");
            }
        }
        if self.ownership_links.len() > 4096 {
            return Err("Too many ownership links");
        }
        let mut link_ids = std::collections::HashSet::new();
        for link in &self.ownership_links {
            link.validate()?;
            if !link_ids.insert(&link.id)
                || !self.nodes.iter().any(|node| node.id == link.owner_node_id)
                || link.target_node_ids.is_empty()
                || link
                    .target_node_ids
                    .iter()
                    .any(|id| !self.nodes.iter().any(|node| &node.id == id) || id == &link.owner_node_id)
            {
                return Err("Invalid ownership link node");
            }
        }
        if self.run_feedback.len() > 4096 {
            return Err("Too many run feedback entries");
        }
        let mut feedback_nodes = std::collections::HashSet::new();
        for feedback in &self.run_feedback {
            feedback.validate()?;
            if !feedback_nodes.insert(&feedback.node_id)
                || !self.nodes.iter().any(|node| node.id == feedback.node_id)
            {
                return Err("Invalid run feedback node");
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

    /// 把场景级通用原语按 `nodeId` 关联到节点派生字段。
    ///
    /// 只在接受点调用一次；渲染/命中随后只读节点即可取得同一份事实，避免各系统各查一遍。
    pub(crate) fn index_primitives(&mut self) {
        let cards: std::collections::HashMap<&str, &PreviewCard> = self
            .preview_cards
            .iter()
            .map(|card| (card.node_id.as_str(), card))
            .collect();
        let feedback: std::collections::HashMap<&str, &RunFeedback> = self
            .run_feedback
            .iter()
            .map(|entry| (entry.node_id.as_str(), entry))
            .collect();
        for node in &mut self.nodes {
            node.preview_card = cards.get(node.id.as_str()).map(|card| (*card).clone());
            node.run_feedback = feedback.get(node.id.as_str()).map(|entry| (*entry).clone());
        }
    }

    /// 协议版本必须一致：旧 Frontend/WASM 组合按版本拒绝，不静默降级为缺模型画面。
    fn validate_version(&self) -> Result<(), &'static str> {
        if self.version != CANVAS_RENDER_SCENE_VERSION {
            return Err("Unsupported canvas render scene version");
        }
        Ok(())
    }
}
