//! 画布节点与派生实体的公共 ECS 组件
//! （change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs，design D1 / 任务 1.2）。
//!
//! 组件只承载**实体语义与实体局部状态**：稳定身份、布局、深度、选中/悬停/可见性、展示类型
//! 与 owner/role/slot/generation。它们不复制完整 `GraphNode` 协议 DTO；需要完整绘制输入的
//! system 仍按 id 从 `CurrentScene`（经 `NodeIndex`）读取唯一事实源。
//!
//! 约定：
//! - `CanvasNodeId` 是节点实体身份，跨快照按 id 复用，删除后同 id 重新出现会得到新实体；
//! - 派生子实体（标签、纹理 Sprite、group 面板、缩略图、focus 细节）通过 `ChildOf` 挂在
//!   节点实体下，节点实体 `despawn` 时随之回收；
//! - 组件里的 `Entity` 只是 owner 关系，不是第二份资产事实：资产、预算、LRU 与异步任务仍
//!   在 Resource 中。

use bevy::prelude::*;

/// 稳定节点身份：与协议 `nodeId` 相同，跨 accepted snapshot 复用实体。
#[derive(Component, Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct CanvasNodeId(pub String);

/// 节点当前布局（协议坐标，y 向下）。
#[derive(Component, Clone, Copy, Debug, PartialEq)]
pub(crate) struct CanvasLayout {
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) width: f32,
    pub(crate) height: f32,
}

impl CanvasLayout {
    pub(crate) fn from_node(node: &crate::protocol::GraphNode) -> Self {
        Self {
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
        }
    }

    /// 协议坐标中心。
    pub(crate) fn center(self) -> Vec2 {
        Vec2::new(self.x + self.width / 2., self.y + self.height / 2.)
    }

    /// 端口位置（与 `canvas_query::layout::port_for_bounds` 同一公式）。
    pub(crate) fn port(self, output: bool) -> Vec2 {
        crate::canvas_query::layout::port_for_bounds(
            self.x,
            self.y,
            self.width,
            self.height,
            output,
        )
    }
}

/// 文档发射序号与派生世界 z。生产者按它排序，保证与变更前的绘制顺序一致。
#[derive(Component, Clone, Copy, Debug, PartialEq)]
pub(crate) struct CanvasDepth {
    /// 投影顺序下标（聚焦投影下是过滤后的下标；同代快照内稳定）。
    pub(crate) index: usize,
    /// `draw_order::render_index` 派生槽位（ghost 固定在最低层）。
    pub(crate) render: usize,
    /// `draw_order::render_z` 派生值。
    pub(crate) z: f32,
}

/// 节点选中与运行/放置态。持久选中描边只由各展示类型自己的 producer system 消费。
#[derive(Component, Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct CanvasSelection {
    pub(crate) selected: bool,
    pub(crate) running: bool,
    pub(crate) drop_target: bool,
}

/// 节点指针悬停瞬时状态。
#[derive(Component, Clone, Debug, Default, PartialEq)]
pub(crate) struct CanvasHover {
    pub(crate) hovered: bool,
    pub(crate) port: Option<String>,
}

/// 节点呈现可见性（聚焦/隐藏投影）。隐藏节点仍保留实体身份，恢复时不需要重建。
#[derive(Component, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CanvasVisibility {
    pub(crate) hidden: bool,
}

/// 普通卡片展示能力（存在该组件即表示节点按普通卡片生产几何）。
#[derive(Component, Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct CardPresentation {
    pub(crate) resizable: bool,
    pub(crate) texture: bool,
    pub(crate) busy: bool,
    pub(crate) media_loading: bool,
    pub(crate) ghost: bool,
    pub(crate) model: bool,
    pub(crate) model_preview: bool,
    pub(crate) history: bool,
    pub(crate) shot_preview: bool,
}

/// group 容器展示能力。名称与协议 DTO 同名，但组件只保留生产几何需要的语义位。
#[derive(Component, Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct GroupPresentation {
    pub(crate) drop_target: bool,
    pub(crate) collapsed: bool,
    pub(crate) badge: bool,
    pub(crate) badge_scale: f32,
    pub(crate) member_count: u32,
    pub(crate) running: bool,
    pub(crate) resizable: bool,
}

/// 片场（composite-asset）纯模型展示能力。
#[derive(Component, Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct FilmSetPresentation {
    /// 是否携带复合面板缩略图（无面板时只画范围框）。
    pub(crate) panel: bool,
    pub(crate) has_model: bool,
    /// 地面菱形范围（与 `canvas_query::scope::is_diamond` 同一判定）。
    pub(crate) diamond: bool,
}

/// 未识别的第三方展示类型：节点仍被投影，只是没有内置 producer。
#[derive(Component, Clone, Debug, PartialEq, Eq)]
pub(crate) struct CustomPresentation {
    pub(crate) kind: String,
}

/// 标签角色。同一 owner 下按 role + slot 复用实体，不再用 `HashMap<String, Entity>`。
#[derive(Component, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum CanvasLabelRole {
    /// 普通卡片文字（owner 为卡片节点实体）。
    Card,
    /// 卡片上方外侧的名称与尺寸行（仅选中/悬停时）。
    CardMeta,
    /// group 标题、片场标题与面板文字（owner 为容器节点实体）。
    Container,
    /// 连线标签（owner 为边批次实体）。
    Edge,
    /// 拖动粘连操作条文字（owner 为拖动节点）。
    Attach,
    /// 运行进度百分比（owner 为运行节点）。
    Running,
    /// 节点顶部操作横条文字（owner 为节点）。
    NodeAction,
}

/// 标签实体归属：owner 由 `ChildOf` 表达，这里只记录角色与槽位。
#[derive(Component, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CanvasLabel {
    pub(crate) role: CanvasLabelRole,
    pub(crate) slot: u16,
}

/// 节点纹理 Sprite 归属。`TextureStore` 仍按内容身份共享 `Image`。
#[derive(Component, Clone, Debug, PartialEq, Eq)]
pub(crate) struct CanvasTextureSprite {
    pub(crate) owner: Entity,
    /// 节点稳定 id（owner 实体回收后仍可按内容引用释放共享 Image）。
    pub(crate) node_id: String,
    /// 内容身份（后端下发时提供）；`None` 表示无共享内容键。
    pub(crate) content_id: Option<String>,
    /// 贴图原始像素尺寸。Sprite 每帧跟随节点几何重算尺寸时需要它，
    /// 而像素尺寸只在贴图批次里出现一次，所以随 Sprite 一起记住。
    pub(crate) texture_px: [u32; 2],
}

/// group 3D 气泡尾巴/连续底面的 owner（节点实体）。
#[derive(Component, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct GroupSurfaceOwner {
    pub(crate) owner: Entity,
}

/// 复合面板缩略图归属与槽位。
#[derive(Component, Clone, Debug, PartialEq, Eq)]
pub(crate) struct CompositePanelThumbnail {
    pub(crate) owner: Entity,
    pub(crate) image_id: String,
    pub(crate) slot: u16,
}

/// focus 细节区域的种类（基础分片或替换分片）。
#[derive(Component, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FocusDetailKind {
    Base,
    Detail,
}

/// 图片/视频聚焦细节分片：owner + 源矩形 + 上传代数。
#[derive(Component, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FocusDetailRegion {
    pub(crate) owner: Entity,
    pub(crate) rect: [u32; 4],
    pub(crate) generation: u64,
    pub(crate) kind: FocusDetailKind,
}

/// 拍摄镜头预览 Sprite 归属（采样策略与发布图像状态仍在 Resource）。
#[derive(Component, Clone, Debug, PartialEq, Eq)]
pub(crate) struct ShotPreviewSprite {
    pub(crate) node_id: String,
    pub(crate) owner: Entity,
}

/// 片场拍摄镜头小相机标记身份。
#[derive(Component, Clone, Debug, PartialEq, Eq)]
pub(crate) struct FilmSetCameraMarker {
    pub(crate) preview_node_id: String,
    pub(crate) owner_node_id: String,
}

/// 模型根实例 owner：每个由根创建/复用的实体都携带根实体身份。
#[derive(Component, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ModelOwner {
    pub(crate) root: Entity,
}

/// 模型稳定部件标记（`partId` 与所属根）。
#[derive(Component, Clone, Debug, PartialEq, Eq)]
pub(crate) struct ModelPart {
    pub(crate) owner: Entity,
    pub(crate) part_id: String,
}

/// 模型合批块标记：多个行为部件共享的批次实体。
#[derive(Component, Clone, Debug, PartialEq, Eq)]
pub(crate) struct ModelBatch {
    pub(crate) owner: Entity,
    pub(crate) batch_id: String,
}

/// 透明度动作创建的专属材质实例。
///
/// 组件只保存**实体局部**状态（实例句柄、原共享材质、静态透明度、是否隐藏）；共享材质表、
/// 实例回收与质量替换仍由 `ModelVisuals` / `Assets<StandardMaterial>` 管理
/// （change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs，5.3）。
#[derive(Component, Clone, Debug, PartialEq)]
pub(crate) struct OpacityMaterialInstance {
    /// 克隆出来的专属实例。
    pub(crate) instance: Handle<StandardMaterial>,
    /// 原共享材质（透明度回到 1 时写回）。
    pub(crate) original: Handle<StandardMaterial>,
    /// 原材质自身的静态透明度（blend 材质取它的 alpha，opaque 为 1）。
    pub(crate) static_alpha: f32,
    /// 当前是否因透明度 0 而隐藏。
    pub(crate) hidden: bool,
}
