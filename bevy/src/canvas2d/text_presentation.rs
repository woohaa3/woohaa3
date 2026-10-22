//! 画布文字按投影缩放选择栅格分辨率
//! （change: 2026-10-22-improve-canvas-text-clarity，design D1–D5）。
//!
//! 逻辑字号与栅格表示分开：业务绘制只声明**逻辑字号**（世界单位）或**屏幕字号**，本模块按
//! 当前有效相机倍率与 renderer 实际接受的 DPR 选出有限栅格档位，写入 `TextFont.font_size`
//! （引擎再乘 DPR 得到物理字形字号）并用实体局部尺度反向抵消，使显示尺寸回到逻辑尺寸。
//!
//! 三类身份：
//! - [`LogicalText`]：实体上的逻辑元数据（字号、逻辑 bounds、模式、最近档位）。只由业务入口写，
//!   策略不从这里反推已放大的字体或 Transform。
//! - [`present`]：纯策略，输入逻辑元数据 + `(zoom, dpr)`，输出确定性呈现；同输入同输出，非法值
//!   返回 `None`（保留最近合法表示）。
//! - [`sync`]：每帧比较目标与现有组件，仅在有变化时写入，因此静止帧不产生文字重排。
//!
//! 世界文字档位为 `{1, 2, 4, 8, 12}`：升级立即生效，降档需低于下一较低档的 85%（滞回），
//! 单字形物理栅格上限 [`MAX_GLYPH_PX`]。固定屏幕文字（节点操作横条）始终使用逻辑屏幕字号，
//! 由 `1 / zoom` 的实体尺度抵消相机，不随缩放产生字号键。

use bevy::{prelude::*, text::TextBounds};

use crate::app::{CurrentScene, SurfaceState};

/// 世界文字可用栅格档位（相对逻辑字号的倍率）。升级立即生效，降档需穿过滞回区间。
pub(crate) const SCALE_STEPS: [f32; 5] = [1.0, 2.0, 4.0, 8.0, 12.0];

/// 单字形栅格字号上限（物理像素）。触及上限时按整数物理字号键压缩栅格细节，
/// 保持逻辑版面尺寸；不限制用户合法 zoom，也不改变字号或返回错误。
pub(crate) const MAX_GLYPH_PX: f32 = 256.0;

/// 降档滞回：当前倍率低于「下一较低档 × 该比例」时才降档，避免边界来回抖动。
const DOWNGRADE_RATIO: f32 = 0.85;

/// 可接受 DPR 上界（与协议 `surface.pixelRatio` 门禁一致）。超出按上界处理，不拒绝渲染。
pub(crate) const MAX_DPR: f32 = 4.0;

/// 文字缩放模式（design D1）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TextScaleMode {
    /// 随世界缩放：显示尺寸跟随相机 zoom，栅格按档位提升。
    World,
    /// 固定屏幕字号：显示尺寸恒为逻辑屏幕字号，实体尺度抵消相机 zoom。
    Screen,
}

/// 画布文字的逻辑排版基准（design D1）。仅由业务入口声明，不从已放大的字体/Transform 反推。
#[derive(Component, Clone, Copy, Debug)]
pub(crate) struct LogicalText {
    /// 逻辑字号（世界模式为世界单位，屏幕模式为屏幕像素）。
    pub(crate) size: f32,
    /// 逻辑 bounds（与 `size` 同一逻辑单位；`None` 表示无界）。截断仍由业务在逻辑尺寸决定。
    pub(crate) bounds: Option<Vec2>,
    pub(crate) mode: TextScaleMode,
    /// 最近应用的档位（仅世界模式参与滞回）。`None` 表示按当前倍率直接选档。
    applied_step: Option<f32>,
}

impl LogicalText {
    /// 世界缩放文字（节点标题/正文、组与片场标题、连线标签、运行状态）。
    pub(crate) fn world(size: f32, bounds: Option<Vec2>) -> Self {
        Self {
            size,
            bounds,
            mode: TextScaleMode::World,
            applied_step: None,
        }
    }

    /// 固定屏幕字号文字（节点操作横条）。
    pub(crate) fn screen(size: f32) -> Self {
        Self {
            size,
            bounds: None,
            mode: TextScaleMode::Screen,
            applied_step: None,
        }
    }

    /// 业务复用实体时的逻辑值更新：只有真正变化才写入，避免无谓的变更标记。
    pub(crate) fn set(&mut self, size: f32, bounds: Option<Vec2>, mode: TextScaleMode) {
        if self.size != size || self.bounds != bounds || self.mode != mode {
            self.size = size;
            self.bounds = bounds;
            self.mode = mode;
        }
    }

    /// 逻辑值是否已经等于给定值。
    ///
    /// 生产者在逐帧路径（例如横条 overlay、运行进度）里用它在**写入前**比较：通过
    /// `Mut<LogicalText>` 解引用即触发变更标记，逐帧无谓写入会让策略系统每帧重扫全部文字。
    pub(crate) fn matches(&self, size: f32, bounds: Option<Vec2>, mode: TextScaleMode) -> bool {
        self.size == size && self.bounds == bounds && self.mode == mode
    }
}

/// 一次呈现的目标值（纯派生结果）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Presentation {
    /// 写入 `TextFont.font_size` 的逻辑字号；引擎再乘 DPR 栅格化。
    pub(crate) font_size: f32,
    /// 实体局部 x/y 尺度：把栅格字号换回逻辑显示尺寸。
    pub(crate) scale: f32,
    /// 换算后的栅格 bounds（`TextBounds` 与字号同单位）。
    pub(crate) bounds: Option<Vec2>,
    /// 本次采用的档位（屏幕模式恒为 1）。
    pub(crate) step: f32,
}

impl Presentation {
    /// 实际栅格键（物理像素整数）：引擎 `FontAtlasKey` 的字号即 `font_size × DPR`。
    ///
    /// 仅回归测试使用——有限档位 × 有限 DPR 决定字号键集合。
    #[cfg(test)]
    pub(crate) fn raster_key(&self, dpr: f32) -> u32 {
        (self.font_size * dpr).round().max(1.0) as u32
    }
}

/// 世界文字档位选择：不小于 `max(1, zoom)` 的最低档，超过末档使用末档。
///
/// `current` 为最近应用的档位：升级立即生效；降档只在倍率低于「下一较低档 × 85%」时发生。
/// 滞回比较用原始 zoom（而非 `max(1, zoom)`），否则最低档区间永远无法降档、缩小后仍保留
/// 高档位字形。
pub(crate) fn step_for(zoom: f32, current: Option<f32>) -> f32 {
    let desired = zoom.max(1.0);
    let lowest = SCALE_STEPS[0];
    let highest = SCALE_STEPS[SCALE_STEPS.len() - 1];
    let pick = |value: f32| {
        SCALE_STEPS
            .iter()
            .copied()
            .find(|step| *step >= value - 1.0e-4)
            .unwrap_or(highest)
    };
    let Some(current) = current.filter(|step| step.is_finite() && *step >= lowest) else {
        return pick(desired);
    };
    if zoom >= current - 1.0e-4 {
        // 升级或同档：直接取满足需求的最低档（不会低于当前档）。
        return pick(desired).max(current);
    }
    // 降档：必须越过下一较低档的滞回边界。
    let lower = SCALE_STEPS
        .iter()
        .copied()
        .filter(|step| *step < current - 1.0e-4)
        .fold(lowest, f32::max);
    if zoom < lower * DOWNGRADE_RATIO {
        pick(desired).min(lower)
    } else {
        current
    }
}

/// 纯呈现策略：非法 zoom/surface 或非法逻辑字号返回 `None`，调用方保留最近合法表示。
pub(crate) fn present(meta: &LogicalText, zoom: f32, dpr: f32) -> Option<Presentation> {
    if !meta.size.is_finite() || meta.size <= 0.0 {
        return None;
    }
    if !zoom.is_finite() || zoom <= 0.0 {
        return None;
    }
    if !dpr.is_finite() || dpr <= 0.0 {
        return None;
    }
    let dpr = dpr.min(MAX_DPR);
    let step = match meta.mode {
        TextScaleMode::World => step_for(zoom, meta.applied_step),
        TextScaleMode::Screen => 1.0,
    };
    // 期望字形栅格：世界文字按档位放大，屏幕文字固定逻辑字号（不随 zoom 变化）。
    let nominal = match meta.mode {
        TextScaleMode::World => meta.size * step,
        TextScaleMode::Screen => meta.size,
    };
    // 量化到整数物理字号键：档位 × DPR 组合有限 => 字形键有限。
    let physical = (nominal * dpr).round().clamp(1.0, MAX_GLYPH_PX);
    let font_size = physical / dpr;
    // 目标世界尺寸：世界文字保持逻辑字号，屏幕文字抵消相机 zoom。
    let world_size = match meta.mode {
        TextScaleMode::World => meta.size,
        TextScaleMode::Screen => meta.size / zoom,
    };
    let bounds = meta.bounds.map(|bounds| bounds * (font_size / meta.size));
    Some(Presentation {
        font_size,
        scale: world_size / font_size,
        bounds,
        step,
    })
}

/// 当前有效相机倍率：与实际二维相机一致（含图片/视频聚焦取景），不是只读 overview zoom。
fn effective_zoom(scene: &CurrentScene) -> f32 {
    super::image_focus::camera_view(&scene.0)
        .map(|(_, _, zoom)| zoom)
        .unwrap_or(scene.0.viewport.zoom)
}

/// 上一帧已应用的有效相机倍率与 DPR。
///
/// 纯平移、静止帧与同档缩放都命中同一 `(zoom, dpr)`，因此可以整体跳过遍历；只有档位相关量
/// 或任一文字的逻辑元数据变化时才重新派生（change: 2026-10-22-improve-canvas-text-clarity，
/// design D4）。
#[derive(Resource)]
pub(crate) struct PresentationCache {
    zoom: f32,
    dpr: f32,
}

impl Default for PresentationCache {
    fn default() -> Self {
        // NaN 保证首帧必然不等于任何合法输入，从而执行一次完整派生。
        Self {
            zoom: f32::NAN,
            dpr: f32::NAN,
        }
    }
}

/// 每帧把逻辑文字元数据解析成栅格表示（design D4：位于全部标签生产者与 deferred 应用之后、
/// Bevy 文字布局之前）。
///
/// 只有 `(zoom, dpr)` 变化或某条文字逻辑元数据变化时才遍历；写入前逐字段比较，
/// 因此静止帧既不重排文字也不产生组件变更。
pub(crate) fn sync(
    scene: Res<CurrentScene>,
    surface: Res<SurfaceState>,
    mut cache: ResMut<PresentationCache>,
    mut params: ParamSet<(
        Query<(), (Changed<LogicalText>, Without<Sprite>)>,
        Query<
            (
                &mut LogicalText,
                &mut TextFont,
                &mut Transform,
                &mut TextBounds,
            ),
            Without<Sprite>,
        >,
    )>,
) {
    let zoom = effective_zoom(&scene);
    let dpr = surface.pixel_ratio;
    let camera_changed =
        cache.zoom.to_bits() != zoom.to_bits() || cache.dpr.to_bits() != dpr.to_bits();
    if !camera_changed && params.p0().is_empty() {
        return;
    }
    if zoom.is_finite() && zoom > 0.0 && dpr.is_finite() && dpr > 0.0 {
        cache.zoom = zoom;
        cache.dpr = dpr;
    }
    for (mut meta, mut font, mut transform, mut bounds) in &mut params.p1() {
        let Some(target) = present(&meta, zoom, dpr) else {
            // 非法 zoom/DPR：保留最近合法表示，不取倒数、不写组件。
            continue;
        };
        if meta.mode == TextScaleMode::World && meta.applied_step != Some(target.step) {
            meta.applied_step = Some(target.step);
        }
        let font_size = FontSize::Px(target.font_size);
        if font.font_size != font_size {
            font.font_size = font_size;
        }
        let scale = Vec3::new(target.scale, target.scale, 1.0);
        if transform.scale != scale {
            transform.scale = scale;
        }
        // 行高保持既有语义：画布文字不设置显式 `LineHeight`（默认 `RelativeToFont(1.2)`），
        // 它随字号等比变化，再被实体尺度换回原逻辑行距。显式绝对行高若将来引入，须同样乘以
        // `font_size / size`（design D1）。
        let next = target
            .bounds
            .map(|bounds| (Some(bounds.x), Some(bounds.y)))
            .unwrap_or((None, None));
        // `TextBounds` 未实现 `PartialEq`：按字段比较，避免静止帧无谓地标记文字为已变更。
        if bounds.width != next.0 || bounds.height != next.1 {
            bounds.width = next.0;
            bounds.height = next.1;
        }
    }
}

#[cfg(test)]
mod layout_tests;
#[cfg(test)]
mod tests;
