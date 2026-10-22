//! 卡片预览的运行时状态与装配辅助
//! （自 `sync.rs` 拆出；change: 2026-10-15-add-film-set-shooting-shot-previews，design D7）。
//!
//! 本文件承载卡片 rig/Sprite 的运行时状态、资源、层与身份派生辅助；ECS 系统在 [`super::sync`]。
//! 只做 ECS/资源装配，不含任何**判定**（尺寸/预算/串行在 [`super::policy`]，目标与采样身份在
//! [`super::plan`]，卡片几何在 `crate::canvas_query::shot_preview`）。
//!
//! 卡片**不自己分配** GPU Image：它复用 Shot Camera 的 `Offscreen` 预览，把 rig 上的
//! [`ShotPreviewOutput`] 里的 handle 挂到 2D Sprite 上，因此读取不触发任何 CPU 回读、像素桥或
//! 编码。尺寸档通过 `ShotCameraPreview.size` 下发，由 `shot_camera::runtime` 负责真实纹理的分配
//! 与释放。

use std::collections::HashMap;

use bevy::prelude::*;

use crate::{
    model3d,
    shot_camera::{
        preview_readiness::ShotPreviewReady, ShotCameraTarget, ShotCameraViewMask,
    },
};

use super::plan::{SampleIdentity, Target};
use super::policy;

/// 卡片各自占用的渲染层基数（与模型层 0、辅助层 1/2/7 分离，避免串画面）。
pub(crate) const PREVIEW_LAYER_BASE: usize = 40;
/// 卡片渲染层上限（与 Image/候选上限同量级，避免层号无界增长）。
pub(crate) const MAX_PREVIEW_LAYERS: usize = policy::MAX_IMAGES;

/// 卡片预览 rig 的稳定身份（不参与布局，仅供诊断/去重）。
#[derive(Component, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ShotPreviewRig {
    /// 卡片独占渲染层。
    pub(crate) layer: usize,
}

/// 一个可见卡片预览的运行时状态。
pub(crate) struct Card {
    pub(crate) rig: Entity,
    pub(crate) sprite: Entity,
    /// 归属片场 canonical 节点 id（卡片 rig 截图时 pin 该片场，避免画面被降档/回收）。
    pub(crate) owner: String,
    /// 当前分配的纹理尺寸档（下发给 `ShotCameraPreview.size`）。
    pub(crate) size: UVec2,
    pub(super) resize: policy::ResizeDebounce,
    /// 已发布画面保持强引用，新纹理就绪后才替换。
    pub(super) published: Option<(Handle<Image>, UVec2)>,
    pub(super) published_current: bool,
    pub(crate) layer: usize,
    /// 已下发的采样身份；`None` 表示尚未下发（新建卡片）。
    pub(crate) dispatched: Option<SampleIdentity>,
    /// 已下发身份对应的采样代数（迟到结果据此丢弃）。
    pub(crate) generation: u64,
    /// 当前代数是否已被渲染侧确认为稳定画面。
    pub(crate) confirmed: bool,
    /// 是否为唯一活动动态播放目标：每帧重新触发同一 rig 以推进播放时钟。
    pub(crate) live: bool,
    /// 最近一次实际下发采样请求的 tick。
    pub(crate) requested: u64,
    /// 最近一次确认发布的 tick（LRU 依据）。
    pub(crate) last_touched: u64,
    /// 进入等待队列的 tick（公平排空依据）。
    pub(crate) waiting_since: u64,
    pub(crate) visible: bool,
    /// 上一次实际写入的 sprite 状态（未变则跳过命令）。
    pub(crate) applied_sprite: Option<SpriteState>,
    /// 上一次实际写入的 rig pose/lens/target 状态（未变则跳过命令）。
    pub(crate) applied_rig: Option<RigState>,
}

impl Card {
    pub(super) fn retained_pixels(&self) -> u64 {
        self.size.x as u64 * self.size.y as u64
            + self.published.as_ref().filter(|_| !self.published_current)
                .map_or(0, |(_, size)| size.x as u64 * size.y as u64)
    }
}

/// 卡片 sprite 的可见状态；用于跳过重复命令。
#[derive(PartialEq)]
pub(crate) struct SpriteState {
    pub(crate) transform: Transform,
    pub(crate) size: Vec2,
    pub(crate) image: bevy::asset::AssetId<Image>,
    pub(crate) visible: bool,
}

/// 卡片 rig 的派生输入状态；用于跳过重复写入。
#[derive(PartialEq)]
pub(crate) struct RigState {
    pub(crate) pose: crate::shot_camera::ShotCameraPose,
    pub(crate) aspect: f32,
    pub(crate) center: Vec3,
    pub(crate) radius: f32,
    pub(crate) size: UVec2,
}

/// 实际工作计数（累积；只服务诊断，不代表 GPU 时间或帧率）。
#[derive(Default, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewWork {
    /// 实际确认发布的采样数。
    pub(crate) samples: u64,
    /// 旧身份未确认即被新身份取代的次数（迟到结果丢弃）。
    pub(crate) superseded: u64,
    /// 等待资源就绪的帧数（诊断）。
    pub(crate) waiting: u64,
    /// 因预算淘汰的缓存 Image 数。
    pub(crate) evictions: u64,
    /// 采样任务被取消（目标切换/删除/屏外）的次数。
    pub(crate) cancels: u64,
    /// 未变化时跳过的 rig 写入次数。
    pub(crate) rig_skips: u64,
}

/// 全部卡片预览的运行时状态与诊断。
#[derive(Resource, Default)]
pub(crate) struct ShotPreviewCards {
    pub(crate) cards: HashMap<String, Card>,
    /// 当前占用采样槽的活动目标（唯一动态时钟优先）。
    pub(crate) active: Option<String>,
    /// 已下发的 owner → `(模型表示身份, 卡片层并集)`（去重重复写层）。
    ///
    /// 缓存必须连同**表示身份**记录：根重建（内容/批处理/聚焦策略变化）会重建根实体，新实体只带
    /// 主画布层，因此重建后必须重新并入卡片层，否则卡片相机再也看不到所属片场——采样画面变空白
    /// 并被当作新代确认发布，卡片永久变灰。失效规则与 `model_preview::apply_preview_layer` 一致
    /// （design D7）。
    pub(crate) applied_layers: HashMap<String, (String, Vec<usize>)>,
    /// 上一次写入方向光的卡片层并集（未变则跳过世界查询）。
    pub(crate) applied_light_layers: Vec<usize>,
    pub(crate) next_generation: u64,
    pub(crate) tick: u64,
    pub(crate) work: PreviewWork,
}

impl ShotPreviewCards {
    /// 是否有排队/等待/进行中的预览工作（静止降频据此判定需要连续帧）。
    ///
    /// **活动卡片**（唯一动态播放目标）每帧都需要新画面；**待确认**卡片（尚未下发或已下发但
    /// 渲染侧未确认）也需要连续帧直到确认。两者都归零后静止画布才停帧。
    pub(crate) fn has_pending(&self) -> bool {
        self.active.is_some()
            || self
                .cards
                .values()
                .any(|card| card.visible && (card.live || !card.confirmed || card.resize.pending))
    }

    /// 当前目标与过渡旧图的 Image 数（不重复计算同一张图）。
    pub(crate) fn image_count(&self) -> usize {
        self.cards.len() + self.cards.values()
            .filter(|card| card.published.is_some() && !card.published_current).count()
    }

    /// 实际工作计数快照（诊断；不代表 GPU 时间）。
    pub(crate) fn work(&self) -> PreviewWork {
        self.work
    }

    /// 已保留的总像素（诊断与预算）。
    pub(crate) fn retained_pixels(&self) -> u64 {
        self.cards
            .values()
            .map(Card::retained_pixels)
            .sum()
    }

    /// 已确认稳定的卡片数（诊断）。
    pub(crate) fn confirmed_count(&self) -> u64 {
        self.cards.values().filter(|card| card.confirmed).count() as u64
    }
}

/// 卡片预览插件：注册资源（不新增像素通道，复用 Shot Camera Offscreen）。
pub(crate) struct ShotNodePreviewPlugin;

impl Plugin for ShotNodePreviewPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<ShotPreviewCards>();
    }
}

/// 卡片渲染层：固定基数 + 卡片序号；超出上限回绕（复用层，不无界增长）。
pub(crate) fn layer_for(index: usize) -> usize {
    PREVIEW_LAYER_BASE + index % MAX_PREVIEW_LAYERS
}

/// 卡片相机可见层：**只**看该卡片独占层。
///
/// 模型根与媒体平面会被追加该层，因此卡片能看见所属片场的内容；网格（层 0）、gizmo 与片场
/// 小相机（层 1/2/7）都不进入卡片画面。
pub(crate) fn card_camera_layers(layer: usize) -> ShotCameraViewMask {
    ShotCameraViewMask(bevy::camera::visibility::RenderLayers::layer(layer))
}

/// 卡片预览采样身份：源内容 + 尺寸档 + 播放会话。
pub(crate) fn identity_of(target: &Target, size: UVec2) -> SampleIdentity {
    SampleIdentity {
        content: target.content.clone(),
        size: [size.x, size.y],
        playback: target.generation,
    }
}

/// 目标包围球 → `shot_camera` 目标组件（退化半径兜底，空片场也画得出）。
pub(crate) fn target_component_of(target: &Target) -> ShotCameraTarget {
    let mut component = ShotCameraTarget::default();
    component.set_center_radius(target.bounds.center, target.bounds.radius.max(1e-4));
    component
}

/// rig 派生输入状态（用于跳过未变化的写入）。
pub(crate) fn rig_state_of(target: &Target, size: UVec2) -> RigState {
    RigState {
        pose: target.pose,
        aspect: target.aspect,
        center: target.bounds.center,
        radius: target.bounds.radius.max(1e-4),
        size,
    }
}

/// 取一个新的采样代数。
pub(crate) fn take_generation(cards: &mut ShotPreviewCards) -> u64 {
    cards.next_generation = cards.next_generation.wrapping_add(1);
    cards.next_generation
}

/// 只在 owner 层并集**或模型表示身份**变化时写回模型根与媒体平面层。
pub(crate) fn apply_owner_layers(
    commands: &mut Commands,
    cards: &mut ShotPreviewCards,
    models: &model3d::ModelVisuals,
    media: &mut model3d::film_set_media::FilmSetMediaVisuals,
    desired: &HashMap<String, Vec<usize>>,
) {
    let mut next: HashMap<String, (String, Vec<usize>)> = HashMap::new();
    for (owner, layers) in desired {
        let mut sorted = layers.clone();
        sorted.sort_unstable();
        sorted.dedup();
        // 根重建后旧缓存不作数：表示身份变化即重写（与 `model_preview` 同一失效规则，design D7）。
        let identity = models.quality_identity(owner);
        if policy::owner_layers_stale(cards.applied_layers.get(owner), &identity, &sorted) {
            model3d::apply_preview_layers(models, media, commands, owner, &sorted);
        }
        next.insert(owner.clone(), (identity, sorted));
    }
    cards.applied_layers = next;
}

/// 让场景方向光同时覆盖全部卡片层，使卡片相机也能被照亮
/// （change: 2026-10-15-add-film-set-shooting-shot-previews，design D7）。
///
/// 卡片相机只看自己那一层，而场景 `DirectionalLight` 只在主画布层与截图层：Bevy
/// `prepare_lights` 按「灯光层 ∩ 视图层」过滤，因此卡片视图拿不到方向光。环境光是全局资源，
/// 卡片画面不会全黑，但模型会失去方向光而显得扁平。这里沿用 `model_preview` 的同一做法，把
/// **全部**卡片层并入每盏方向光的层。
///
/// 与 `model_preview` 各自独立写层，因此本函数**合并**而非覆盖现有层；卡片层并集未变时整段跳过，
/// 不产生每帧世界查询与 archetype 变更。
pub(crate) fn apply_light_layers(commands: &mut Commands, cards: &mut ShotPreviewCards) {
    let mut layers: Vec<usize> = cards.cards.values().map(|card| card.layer).collect();
    layers.sort_unstable();
    layers.dedup();
    if layers.is_empty() || layers == cards.applied_light_layers {
        return;
    }
    cards.applied_light_layers = layers.clone();
    commands.queue(move |world: &mut World| {
        use bevy::camera::visibility::RenderLayers;
        let mut query = world.query_filtered::<Entity, With<DirectionalLight>>();
        let entities: Vec<Entity> = query.iter(world).collect();
        for entity in entities {
            let existing = world.get::<RenderLayers>(entity).cloned().unwrap_or_default();
            let merged = layers.iter().fold(existing, |merged, layer| merged.with(*layer));
            world.entity_mut(entity).insert(merged);
        }
    });
}

/// 移除一张卡片：回收 rig、sprite，并取消就绪记录。
///
/// Offscreen Image 由 `shot_camera::runtime` 作为 rig 子资源释放，此处不重复释放。
pub(crate) fn remove_card(
    commands: &mut Commands,
    cards: &mut ShotPreviewCards,
    ready: &ShotPreviewReady,
    id: &str,
) {
    let Some(card) = cards.cards.remove(id) else {
        return;
    };
    ready.cancel(card.rig);
    commands.entity(card.rig).try_despawn();
    commands.entity(card.sprite).try_despawn();
    if cards.active.as_deref() == Some(id) {
        cards.active = None;
    }
    cards.work.cancels += 1;
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn preview_layers_stay_finite_and_inside_engine_capacity() {
        let mut seen = HashSet::new();
        for index in 0..policy::MAX_IMAGES * 2 {
            let layer = layer_for(index);
            assert!(layer >= PREVIEW_LAYER_BASE);
            seen.insert(layer);
        }
        assert!(seen.len() <= MAX_PREVIEW_LAYERS);
    }

    #[test]
    fn card_camera_sees_only_its_own_layer() {
        let mask = card_camera_layers(PREVIEW_LAYER_BASE);
        let layers: Vec<usize> = mask.0.iter().collect();
        assert_eq!(layers, vec![PREVIEW_LAYER_BASE]);
        // 网格/辅助层（0、1、2、7）都不在卡片相机可见集合内，避免卡片里出现网格或 gizmo。
        for excluded in [0usize, 1, 2, 7] {
            assert!(!layers.contains(&excluded));
        }
    }

    #[test]
    fn generations_are_monotonic_and_wrapping() {
        let mut cards = ShotPreviewCards::default();
        let first = take_generation(&mut cards);
        let second = take_generation(&mut cards);
        assert_eq!(second, first + 1);
        cards.next_generation = u64::MAX;
        assert_eq!(take_generation(&mut cards), 0, "回绕不 panic");
    }

    #[test]
    fn idle_state_reports_no_pending_work() {
        let cards = ShotPreviewCards::default();
        assert!(!cards.has_pending());
        assert_eq!(cards.image_count(), 0);
        assert_eq!(cards.retained_pixels(), 0);
        assert_eq!(cards.confirmed_count(), 0);
    }
}
