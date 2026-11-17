//! Shot camera preview 配置、输出与预算类型
//! （change: add-reusable-bevy-shot-camera，任务 2.2/2.3 / design D3）。

use bevy::prelude::*;

use super::components::PreviewUpdatePolicy;
use super::constants::{
    DEFAULT_MAX_PREVIEW_PIXELS_PER_FRAME, DEFAULT_MAX_PREVIEW_UPDATES_PER_FRAME,
    MAX_PREVIEW_DIMENSION,
};

/// preview 输出目标。
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PreviewTarget {
    /// 离屏 GPU Image（公开 `ShotPreviewOutput`；供 Bevy UI/材质/宿主预览桥）。
    Offscreen,
    /// 主窗口 viewport。矩形由调用方给出；未指定时使用角落布局。不暴露 Image。
    Window,
}

/// 调用方 viewport 的解析结果（CSS 像素 x/y/width/height）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CallerViewport {
    /// 调用方未指定矩形：窗口目标使用角落布局。
    Unspecified,
    /// 宽高均为有限正数。
    Valid(Vec4),
    /// 非有限或非正宽高：主视图必须禁用，不得沿用上一次矩形。
    Invalid,
}

/// 把 CSS 矩形按 pixel ratio 换成物理 viewport 的位置与尺寸（尚未按窗口裁剪）。
pub fn viewport_from_css(rect: Vec4, pixel_ratio: f32) -> (UVec2, UVec2) {
    let ratio = if pixel_ratio.is_finite() && pixel_ratio > 0.0 {
        pixel_ratio
    } else {
        1.0
    };
    let position = UVec2::new(
        (rect.x * ratio).round().max(0.0) as u32,
        (rect.y * ratio).round().max(0.0) as u32,
    );
    let size = UVec2::new(
        (rect.z * ratio).round().max(1.0) as u32,
        (rect.w * ratio).round().max(1.0) as u32,
    );
    (position, size)
}

/// 解析调用方 viewport。`None` 表示沿用角落布局。
pub fn resolve_caller_viewport(rect: Option<Vec4>) -> CallerViewport {
    match rect {
        None => CallerViewport::Unspecified,
        Some(rect)
            if rect.x.is_finite()
                && rect.y.is_finite()
                && rect.z.is_finite()
                && rect.w.is_finite()
                && rect.z > 0.0
                && rect.w > 0.0 =>
        {
            CallerViewport::Valid(rect)
        }
        Some(_) => CallerViewport::Invalid,
    }
}

/// 生产 viewfinder 的角落布局（CSS 像素 x/y/width/height）。
///
/// 与既有 `shot_preview::preview_rect` 逐位一致：紧凑屏居中靠上，宽屏右下角。
#[allow(clippy::manual_clamp)]
pub fn preview_viewport_rect(surface: Vec2, aspect: f32) -> bevy::math::Vec4 {
    use bevy::math::Vec4;
    // 与产品既有 `modelFocusFrame()` 布局逐位一致（含 max→min 次序）。
    let compact = surface.x <= 700.0;
    let max_width = if compact {
        (surface.x - 36.0).max(160.0)
    } else {
        (surface.x * 0.31).max(220.0).min(360.0)
    };
    let max_height = if compact {
        (surface.y * 0.24).max(120.0)
    } else {
        220.0
    };
    let mut width = max_width;
    let mut height = width / aspect;
    if height > max_height {
        height = max_height;
        width = height * aspect;
    }
    let x = if compact {
        (surface.x - width) / 2.0
    } else {
        28.0
    };
    let y = if compact {
        82.0
    } else {
        surface.y - height - 28.0
    };
    Vec4::new(x, y, width, height)
}

/// preview 相机 clear color（宿主可设为主题色）。
#[derive(Resource, Clone, Copy, Debug)]
pub struct ShotPreviewClearColor(pub Color);

impl Default for ShotPreviewClearColor {
    fn default() -> Self {
        Self(Color::srgb_u8(248, 250, 249))
    }
}

/// window-target preview 相机的 viewport 规格（由 adapter 每帧写入）。
#[derive(Resource, Clone, Copy, Debug, Default)]
pub struct ShotPreviewViewport {
    /// CSS 画布尺寸。
    pub surface: Vec2,
    /// 设备像素比。
    pub pixel_ratio: f32,
    /// 调用方 CSS 矩形（x, y, width, height）。`None` 使用角落布局。
    pub rect: Option<Vec4>,
    /// 为 true 时窗口主视图保持禁用（进入/退出过渡尚未结束）。
    pub hold: bool,
}

/// preview 配置。
#[derive(Component, Clone, Copy, Debug)]
pub struct ShotCameraPreview {
    pub size: UVec2,
    pub policy: PreviewUpdatePolicy,
    pub active: bool,
    pub target: PreviewTarget,
    /// Per-rig clear color, shared by preview and capture; None follows the host theme.
    pub clear_color: Option<Color>,
}

impl Default for ShotCameraPreview {
    fn default() -> Self {
        Self {
            size: UVec2::new(640, 360),
            policy: PreviewUpdatePolicy::OnDirty,
            active: true,
            target: PreviewTarget::Offscreen,
            clear_color: None,
        }
    }
}

impl ShotCameraPreview {
    /// 构造并 clamp 到单边上限的 preview 配置。
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            size: UVec2::new(
                width.clamp(1, MAX_PREVIEW_DIMENSION),
                height.clamp(1, MAX_PREVIEW_DIMENSION),
            ),
            ..Default::default()
        }
    }

    pub fn with_policy(mut self, policy: PreviewUpdatePolicy) -> Self {
        self.policy = policy;
        self
    }

    pub fn with_target(mut self, target: PreviewTarget) -> Self {
        self.target = target;
        self
    }

    pub fn with_clear_color(mut self, color: Option<Color>) -> Self {
        self.clear_color = color;
        self
    }
}

/// preview 输出：持久 GPU `Handle<Image>` 与当前 generation。
///
/// 调用方可直接把 handle 用于 Bevy UI / 材质；读取不触发 GPU→CPU 同步。
#[derive(Component, Clone, Debug)]
pub struct ShotPreviewOutput {
    pub image: Handle<Image>,
    pub size: UVec2,
    pub generation: u64,
}

/// preview 更新预算。
#[derive(Resource, Clone, Copy, Debug)]
pub struct ShotPreviewBudget {
    pub max_updates_per_frame: usize,
    pub max_pixels_per_frame: u64,
}

impl Default for ShotPreviewBudget {
    fn default() -> Self {
        Self {
            max_updates_per_frame: DEFAULT_MAX_PREVIEW_UPDATES_PER_FRAME,
            max_pixels_per_frame: DEFAULT_MAX_PREVIEW_PIXELS_PER_FRAME,
        }
    }
}

/// 在预算内挑选本帧要推进的 dirty rig（FIFO，超额保持 dirty）。
pub fn plan_preview_updates(
    dirty: &[(Entity, u32, u32)],
    budget: &ShotPreviewBudget,
) -> Vec<Entity> {
    let mut selected = Vec::new();
    let mut pixels: u64 = 0;
    for (entity, width, height) in dirty {
        if selected.len() >= budget.max_updates_per_frame {
            break;
        }
        let cost = (*width as u64) * (*height as u64);
        if !selected.is_empty() && pixels + cost > budget.max_pixels_per_frame {
            continue;
        }
        pixels += cost;
        selected.push(*entity);
    }
    selected
}
