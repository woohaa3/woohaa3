//! 通用呈现原语 DTO（change: 2026-10-28-generic-extension-content-ownership 任务 4.3）。
//!
//! 渲染器只理解这里的原语：身份、几何、材质、变换、动画与状态。业务语义（片场镜头、炉体
//! 对象、NPC 生产条目等）由扩展 adapter 提前投影；扩展私有数据只能经版本化 `payload` 信封
//! 透传，Rust 不读取、不分支，也不因未知载荷拒绝整帧。

use serde::Deserialize;

use super::scene_instant::CursorPoint;

/// 受管条目组呈现 schema 版本（与 contracts `MANAGED_ITEM_GROUP_SCHEMA_VERSION` 一致）。
pub(crate) const MANAGED_ITEM_GROUP_SCHEMA_VERSION: &str = "woohaa-managed-item-group-v1";

/// 扩展呈现载荷信封（版本化、完全不透明）。
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtensionPayload {
    pub(crate) extension_id: String,
    pub(crate) schema_version: String,
    /// 扩展私有数据；Rust 不解读。
    #[serde(default)]
    pub(crate) data: Option<serde_json::Value>,
}

impl ExtensionPayload {
    /// 身份非空且有界；`data` 不参与校验（属扩展契约）。
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.extension_id.is_empty()
            || self.extension_id.len() > 200
            || self.schema_version.is_empty()
            || self.schema_version.len() > 128
        {
            return Err("Invalid extension payload envelope");
        }
        Ok(())
    }
}

/// 预览卡片零点封面相机（世界包围球上的观察姿态）。
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CardCoverCamera {
    pub(crate) azimuth: f32,
    pub(crate) elevation: f32,
    pub(crate) distance: f32,
    #[serde(default)]
    pub(crate) focus_offset: [f32; 3],
}

impl CardCoverCamera {
    /// 有限输入、正距离与合法仰角；错误整体拒绝，不部分降级。
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if ![self.azimuth, self.elevation, self.distance]
            .iter()
            .chain(self.focus_offset.iter())
            .all(|value| value.is_finite())
            || self.distance <= 0.0
            || self.elevation.abs() >= std::f32::consts::FRAC_PI_2
        {
            return Err("Invalid preview cover camera");
        }
        Ok(())
    }

    /// 零点相机状态（与 `AnimationPlayback::initial_camera_state` 同构）。
    pub(crate) fn camera_state(&self) -> crate::motion::InitialCameraState {
        crate::motion::camera_state_from_arrays(
            self.azimuth,
            self.elevation,
            self.distance,
            self.focus_offset,
        )
    }
}

/// 预览卡片原语：一张卡片节点的通用呈现（不含任何业务字段）。
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewCard {
    /// 卡片节点自身 canonical id（同帧至多一张）。
    pub(crate) node_id: String,
    /// 归属 owner 节点 id。
    #[serde(rename = "ownerNodeId")]
    pub(crate) owner_node_id: String,
    /// owner 内稳定实体 id。
    #[serde(rename = "entityId")]
    pub(crate) entity_id: String,
    /// 仅影响呈现；离屏捕获目标仍可用。
    #[serde(default)]
    pub(crate) hidden: bool,
    #[serde(default)]
    pub(crate) title: String,
    /// 次要类型标记（中文）；空串即不绘制。
    #[serde(default, rename = "typeLabel")]
    pub(crate) type_label: String,
    /// 是否动态（可播放）内容；静态卡片不绘制播放控件。
    #[serde(default)]
    pub(crate) animated: bool,
    /// 画幅（宽/高数值）。
    pub(crate) aspect: f32,
    /// 时间线时长（秒）；静态为 0。
    #[serde(default)]
    pub(crate) duration: f32,
    #[serde(default)]
    pub(crate) backdrop: Option<String>,
    /// 零点封面相机。
    #[serde(rename = "coverCamera")]
    pub(crate) cover_camera: CardCoverCamera,
    /// 准备中/就绪/待更新/失败。
    pub(crate) state: String,
    /// 本地播放进度 0..1；仅动态活动卡片携带（不参与 canonical）。
    #[serde(default)]
    pub(crate) progress: Option<f32>,
    /// 是否正在本地播放（仅动态）。
    #[serde(default)]
    pub(crate) playing: Option<bool>,
    /// 可理解诊断（`stale`/`error` 时）。
    #[serde(default)]
    pub(crate) diagnostic: Option<String>,
    #[serde(default)]
    pub(crate) payload: Option<ExtensionPayload>,
}

impl PreviewCard {
    /// 边界级防御校验：身份非空、状态枚举、有限画幅/时长/进度与合法相机。
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.node_id.is_empty()
            || self.node_id.len() > 256
            || self.owner_node_id.is_empty()
            || self.owner_node_id.len() > 256
            || self.entity_id.is_empty()
            || self.entity_id.len() > 256
        {
            return Err("Invalid preview card ownership");
        }
        if !matches!(
            self.state.as_str(),
            "preparing" | "ready" | "stale" | "error"
        ) {
            return Err("Invalid preview card state");
        }
        if self.title.len() > 512 || self.type_label.len() > 128 {
            return Err("Invalid preview card text");
        }
        if !self.aspect.is_finite()
            || self.aspect <= 0.0
            || !self.duration.is_finite()
            || self.duration < 0.0
        {
            return Err("Invalid preview card framing");
        }
        if self
            .progress
            .is_some_and(|progress| !progress.is_finite() || !(0.0..=1.0).contains(&progress))
        {
            return Err("Invalid preview card progress");
        }
        if self
            .diagnostic
            .as_ref()
            .is_some_and(|text| text.len() > 1024)
        {
            return Err("Invalid preview card diagnostic");
        }
        if self
            .backdrop
            .as_ref()
            .is_some_and(|value| value.len() > 128)
        {
            return Err("Invalid preview card backdrop");
        }
        self.cover_camera.validate()?;
        if let Some(payload) = &self.payload {
            payload.validate()?;
        }
        Ok(())
    }
}

/// 归属线原语：owner → 目标节点的**派生呈现**（不是可编辑边）。
///
/// 起点二选一：`start` 为宿主已投影的画布 2D 点，`anchor` 为模型局部 3D 锚点；同时存在时优先
/// `start`。目标可按 `targetItemIds` 精确指向 owner 内的受管条目，缺失即取目标节点底部中心。
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnershipLink {
    pub(crate) id: String,
    #[serde(rename = "ownerNodeId")]
    pub(crate) owner_node_id: String,
    #[serde(default)]
    pub(crate) start: Option<CursorPoint>,
    #[serde(default)]
    pub(crate) anchor: Option<[f32; 3]>,
    #[serde(default, rename = "targetNodeIds")]
    pub(crate) target_node_ids: Vec<String>,
    #[serde(default, rename = "targetItemIds")]
    pub(crate) target_item_ids: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub(crate) payload: Option<ExtensionPayload>,
}

impl OwnershipLink {
    /// 身份非空、目标有界、起点至少一个且有限。
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.id.is_empty()
            || self.id.len() > 512
            || self.owner_node_id.is_empty()
            || self.owner_node_id.len() > 256
            || self.target_node_ids.len() > 4096
            || self.start.is_none() && self.anchor.is_none()
            || self
                .target_node_ids
                .iter()
                .any(|id| id.is_empty() || id.len() > 1024)
            || self.target_item_ids.len() > self.target_node_ids.len()
            || self.target_item_ids.iter().any(|(target, item)| {
                !self.target_node_ids.contains(target) || item.is_empty() || item.len() > 1024
            })
        {
            return Err("Invalid ownership link");
        }
        if let Some(start) = &self.start {
            if !start.x.is_finite() || !start.y.is_finite() {
                return Err("Invalid ownership link start");
            }
        }
        if self
            .anchor
            .is_some_and(|anchor| !anchor.iter().all(|value| value.is_finite()))
        {
            return Err("Invalid ownership link anchor");
        }
        if let Some(payload) = &self.payload {
            payload.validate()?;
        }
        Ok(())
    }
}

/// 运行反馈原语：owner 节点的一次活动运行（阶段/文案码为通用码）。
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunFeedback {
    pub(crate) node_id: String,
    #[serde(default)]
    pub(crate) active: bool,
    pub(crate) phase: String,
    #[serde(rename = "labelCode")]
    pub(crate) label_code: String,
    /// 不透明运行身份：只用于换任务时重启动效，不解析业务语义。
    #[serde(default, rename = "operationKey")]
    pub(crate) operation_key: Option<String>,
    #[serde(default)]
    pub(crate) source: Option<String>,
    #[serde(default, rename = "reduceMotion")]
    pub(crate) reduce_motion: bool,
    #[serde(default)]
    pub(crate) progress: Option<f32>,
    #[serde(default)]
    pub(crate) diagnostic: Option<String>,
    #[serde(default)]
    pub(crate) payload: Option<ExtensionPayload>,
}

impl RunFeedback {
    /// 关联节点非空、阶段/文案码非空且有界、进度在 0..1。
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.node_id.is_empty()
            || self.node_id.len() > 256
            || self.phase.is_empty()
            || self.phase.len() > 64
            || self.label_code.is_empty()
            || self.label_code.len() > 64
            || self
                .operation_key
                .as_ref()
                .is_some_and(|value| value.len() > 256)
            || self
                .source
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 64)
            || self
                .diagnostic
                .as_ref()
                .is_some_and(|text| text.len() > 1024)
            || self
                .progress
                .is_some_and(|progress| !progress.is_finite() || !(0.0..=1.0).contains(&progress))
        {
            return Err("Invalid run feedback");
        }
        if let Some(payload) = &self.payload {
            payload.validate()?;
        }
        Ok(())
    }
}

/// 媒体平面原语（复合资产范围内的图片/视频平面）。
///
/// 世界坐标由映射层派生；Rust 只据此放置真实平面并复用纹理通道。`id` 全局唯一
/// （`nodeId::itemId`），是纹理上传键。
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaPlane {
    #[serde(default)]
    pub(crate) item_id: String,
    #[serde(default = "default_unit")]
    pub(crate) unit: f32,
    /// 全局唯一平面 id（`nodeId::itemId`）。
    pub(crate) id: String,
    /// `image` / `video`（语义，渲染一致）。
    pub(crate) kind: String,
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) z: f32,
    /// 平面世界尺寸（已含固有宽高比与局部缩放）。
    pub(crate) width: f32,
    pub(crate) height: f32,
    /// 绕世界 Y 轴角度（弧度）。
    #[serde(default)]
    pub(crate) yaw: f32,
    /// 是否已上传纹理（供渲染器决定是否等待）。
    #[serde(default = "default_true")]
    pub(crate) has_texture: bool,
}

fn default_unit() -> f32 {
    1.0
}

fn default_true() -> bool {
    true
}

impl MediaPlane {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.id.is_empty()
            || (self.kind != "image" && self.kind != "video")
            || ![self.x, self.y, self.z, self.width, self.height, self.yaw]
                .iter()
                .all(|value| value.is_finite())
            || self.width <= 0.0
            || self.height <= 0.0
        {
            return Err("Invalid media plane");
        }
        Ok(())
    }
}

/// 受管条目组原语：owner 声明其条目（模型/图片/视频）的材质、变换与可见性。
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedItemGroup {
    pub(crate) schema_version: String,
    #[serde(rename = "ownerNodeId")]
    pub(crate) owner_node_id: String,
    /// 组徽标原点（画布坐标）。
    pub(crate) origin: CursorPoint,
    #[serde(default, rename = "ownerTransform")]
    pub(crate) owner_transform: Option<ManagedItemTransform>,
    #[serde(default)]
    pub(crate) items: Vec<ManagedItemGroupItem>,
    #[serde(default)]
    pub(crate) ground: Option<ManagedItemGround>,
    #[serde(default, rename = "activeItemId")]
    pub(crate) active_item_id: Option<String>,
}

impl ManagedItemGroup {
    /// 组级几何/变换/条目校验；未知 schema 版本拒绝整帧。
    pub(crate) fn validate(&self, nodes: &[super::GraphNode]) -> Result<(), &'static str> {
        if self.schema_version != MANAGED_ITEM_GROUP_SCHEMA_VERSION
            || self.owner_node_id.is_empty()
            || !self.origin.x.is_finite()
            || !self.origin.y.is_finite()
            || !nodes
                .iter()
                .any(|node| node.id == self.owner_node_id && node.kind == "group")
            || self.items.len() > 1024
        {
            return Err("Invalid managed item group");
        }
        let mut item_ids = std::collections::HashSet::new();
        for item in &self.items {
            if item.item_id.is_empty()
                || item.source_node_id.is_empty()
                || !item_ids.insert(&item.item_id)
                || !matches!(item.kind.as_str(), "model3d" | "image" | "video")
                || item.content_key.is_empty()
                || item.content_key.len() > 2048
                || item
                    .resource_key
                    .as_ref()
                    .is_some_and(|value| value.is_empty() || value.len() > 512)
                || item
                    .signature
                    .as_ref()
                    .is_some_and(|value| value.is_empty() || value.len() > 512)
                || ![
                    item.transform.x,
                    item.transform.y,
                    item.transform.z,
                    item.transform.yaw,
                    item.transform.scale,
                ]
                .iter()
                .all(|value| value.is_finite())
                || item.transform.scale <= 0.0
                || !item.aspect_ratio.is_finite()
                || item.aspect_ratio <= 0.0
                || item
                    .diagnostic
                    .as_ref()
                    .is_some_and(|message| message.len() > 1024)
            {
                return Err("Invalid managed item group item");
            }
        }
        if let Some(transform) = &self.owner_transform {
            transform.validate()?;
        }
        if let Some(ground) = &self.ground {
            if let Some(transform) = &ground.transform {
                transform.validate()?;
            }
            if !ground.width.is_finite()
                || !ground.depth.is_finite()
                || ground.width <= 0.0
                || ground.depth <= 0.0
                || ground
                    .color
                    .as_ref()
                    .is_some_and(|value| value.len() > 128)
            {
                return Err("Invalid managed item ground");
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedItemGroupItem {
    #[serde(rename = "itemId")]
    pub(crate) item_id: String,
    #[serde(rename = "sourceNodeId")]
    pub(crate) source_node_id: String,
    pub(crate) kind: String,
    #[serde(rename = "contentKey")]
    pub(crate) content_key: String,
    #[serde(default, rename = "resourceKey")]
    pub(crate) resource_key: Option<String>,
    #[serde(default)]
    pub(crate) signature: Option<String>,
    pub(crate) transform: ManagedItemTransform,
    #[serde(default = "default_true")]
    pub(crate) visible: bool,
    #[serde(default)]
    pub(crate) diagnostic: Option<String>,
    #[serde(default = "default_unit", rename = "aspectRatio")]
    pub(crate) aspect_ratio: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedItemTransform {
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) z: f32,
    pub(crate) yaw: f32,
    pub(crate) scale: f32,
}

impl ManagedItemTransform {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if ![self.x, self.y, self.z, self.yaw, self.scale]
            .iter()
            .all(|value| value.is_finite())
            || self.scale <= 0.0
        {
            return Err("Invalid managed item transform");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedItemGround {
    #[serde(default)]
    pub(crate) transform: Option<ManagedItemTransform>,
    pub(crate) width: f32,
    pub(crate) depth: f32,
    #[serde(default)]
    pub(crate) color: Option<String>,
}
