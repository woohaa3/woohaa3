//! 等距网格布局规划：投影、间距档与按 viewport 规划线集合（纯函数，不依赖 ECS/协议）
//! （change: refactor-bevy-reusable-components，任务 4.1 / design D2）。
//!
//! 本模块只依赖 Bevy math 与标准库；不依赖 Canvas `Scene`、`Viewport`、主题资源或 render
//! layer 常量。宿主/adapter 负责把协议 viewport 转换为 [`IsometricGridView`]。

use std::f32::consts::PI;

use bevy::prelude::*;

/// 网格基准间距（世界单位；zoom = 1 时约等于 1 CSS 像素）。
pub const GRID_BASE_SPACING: f32 = 64.0;
/// 网格在屏幕上的间距下限。低于此值就升一档（×2），避免网格过密。
pub const GRID_MIN_SCREEN_SPACING: f32 = 48.0;
/// 每隔多少条线画一条主线。
pub const GRID_MAJOR_EVERY: i32 = 8;
/// 线宽（世界单位≈CSS 像素）。必须 ≥1：正交相机下小于一个像素的截面会被直接丢弃。
pub const GRID_LINE_WIDTH: f32 = 1.4;
/// 网格相对相机的深度。远在 3D 模型之后，避免遮挡；正交投影下深度不影响外观。
pub const GRID_DEPTH: f32 = -20000.0;
/// 正交 3D 相机的远裁剪面。必须覆盖 `GRID_DEPTH`，否则网格会被裁掉。
pub const MODEL_CAMERA_FAR: f32 = 100_000.0;

/// 画布通过缩放模型实现 zoom，模型可能跨过相机所在平面。
/// 正交投影允许负 near，保留相机两侧的几何，避免放大时被近裁剪面切开。
pub fn canvas_camera_projection() -> OrthographicProjection {
    OrthographicProjection {
        near: -MODEL_CAMERA_FAR,
        far: MODEL_CAMERA_FAR,
        ..OrthographicProjection::default_3d()
    }
}

/// 普通画布正交相机投影：`scale = 1 / zoom`（viewport pan/zoom 由相机承担；design D3）。
pub fn canvas_camera_projection_for_view(view: &IsometricGridView) -> OrthographicProjection {
    let mut projection = canvas_camera_projection();
    projection.scale = 1.0 / if view.zoom.is_finite() && view.zoom > 0.0 {
        view.zoom
    } else {
        1.0
    };
    projection
}

/// `cos(45°)`、`sin(45°)·sin(30°)`：等距投影把地面 `(x, z)` 映射到屏幕单位向量。
/// 保留字面量（而非 `FRAC_1_SQRT_2`）以与既有等距投影逐位一致。
#[allow(clippy::approx_constant)]
const AXIS_X: f32 = 0.707_106_78;
const AXIS_Y: f32 = 0.353_553_39;
/// 地面单位长度在屏幕上的长度 `hypot(AXIS_X, AXIS_Y)`。
pub const PROJECTION_SCALE: f32 = 0.790_569_4;

/// 地面单位向量在画布世界的 x 分量 `AXIS_X`（`canvas_query::scope` 展开地面矩形顶点用）。
pub const fn scope_axis_x() -> f32 {
    AXIS_X
}

/// 地面单位向量在画布世界的 y 分量 `AXIS_Y`（`canvas_query::scope` 展开地面矩形顶点用）。
pub const fn scope_axis_y() -> f32 {
    AXIS_Y
}

/// 与协议无关的视图平移/缩放（屏幕坐标）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IsometricGridView {
    pub x: f32,
    pub y: f32,
    pub zoom: f32,
}

impl Default for IsometricGridView {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
        }
    }
}

/// 画布正交相机的世界 z。1 世界单位 = 1 CSS 像素，相机放在屏幕中心这一深度。
pub const CANVAS_CAMERA_Z: f32 = 300.0;

/// 等距视角：把模型局部方向变到「屏幕对齐相机」的观察空间。
///
/// 相机本身用它的逆作为朝向（`canvas_camera_rotation`），模型保持竖直。
/// `view_rotation() * local_dir` 仍是该方向在屏幕上的投影，供朝向约定测试使用。
pub fn view_rotation() -> Quat {
    Quat::from_euler(EulerRot::XYZ, PI / 6.0, -PI / 4.0, 0.0)
}

/// 画布正交相机朝向。45° 等距倾斜在 lookat 上，不烘焙进模型。
pub fn canvas_camera_rotation() -> Quat {
    view_rotation().inverse()
}

/// 固定画布坐标 `(cx, cy, depth)` → 世界：`R × (cx, -cy, depth)`，原点固定为世界零点。
///
/// 与 viewport/surface 无关：模型根锚点与 placement offset 使用这条固定嵌入
/// （change: make-shot-framing-zoom-invariant，design D2）。
pub fn canvas_point_to_world(cx: f32, cy: f32, depth: f32) -> Vec3 {
    canvas_camera_rotation() * Vec3::new(cx, -cy, depth)
}

/// 普通画布正交相机：屏幕中心、固定深度、等距朝向（zoom = 1 的 home）。
pub fn canvas_camera_transform(size: Vec2) -> Transform {
    canvas_camera_transform_for_view(size, &IsometricGridView::default())
}

/// 普通画布正交相机 transform：viewport pan/zoom 由相机处理（design D3）。
///
/// ```text
/// position = R × ((W/2 - tx)/z, -(H/2 - ty)/z, CANVAS_CAMERA_Z)
/// rotation = R，transform.scale = 1
/// ```
///
/// 正交缩放另行由 projection `scale = 1/z` 承担，因此前后移动不会叠加 zoom。
pub fn canvas_camera_transform_for_view(size: Vec2, view: &IsometricGridView) -> Transform {
    let zoom = if view.zoom.is_finite() && view.zoom > 0.0 {
        view.zoom
    } else {
        1.0
    };
    let rotation = canvas_camera_rotation();
    Transform {
        translation: rotation
            * Vec3::new(
                (size.x / 2.0 - view.x) / zoom,
                -(size.y / 2.0 - view.y) / zoom,
                CANVAS_CAMERA_Z,
            ),
        rotation,
        scale: Vec3::ONE,
    }
}

/// 世界点 → canvas CSS 坐标（y 向下），满足 `screen = canvas × zoom + pan`（design D3）。
pub fn screen_point_from_world(world: Vec3, view: &IsometricGridView) -> Vec2 {
    let zoom = if view.zoom.is_finite() && view.zoom > 0.0 {
        view.zoom
    } else {
        1.0
    };
    let q = view_rotation() * world;
    Vec2::new(view.x + zoom * q.x, view.y - zoom * q.y)
}

/// 屏幕 CSS 点（y 向下）→ 世界，固定观察深度（design D3/D5）。
pub fn screen_point_to_world(screen: Vec2, depth: f32, view: &IsometricGridView) -> Vec3 {
    let zoom = if view.zoom.is_finite() && view.zoom > 0.0 {
        view.zoom
    } else {
        1.0
    };
    canvas_camera_rotation()
        * Vec3::new(
            (screen.x - view.x) / zoom,
            -(screen.y - view.y) / zoom,
            depth,
        )
}

/// 把屏幕对齐坐标嵌进倾斜相机的世界，使正交投影与改朝向之前逐像素一致。
///
/// `screen` 的 x/y 是 Bevy 世界（y 向上）下的屏幕像素，z 是该点原来的深度。
pub fn embed_screen_point(screen: Vec3, surface: Vec2) -> Vec3 {
    let center = Vec3::new(surface.x * 0.5, surface.y * 0.5, CANVAS_CAMERA_Z);
    center + canvas_camera_rotation() * (screen - center)
}

/// [`embed_screen_point`] 在给定 viewport 下的逆投影（网格屏幕线段 → 世界顶点）。
///
/// `screen` 的 x/y 与 `view` 同为 CSS 坐标（y 向下），`depth` 为观察深度。
pub fn unproject_screen_point(screen: Vec2, depth: f32, view: &IsometricGridView) -> Vec3 {
    screen_point_to_world(screen, depth, view)
}

/// 画布世界 `(x, z)` → 屏幕坐标 `(y 向下)`。
fn ground_to_screen(view: &IsometricGridView, ground: Vec2) -> Vec2 {
    Vec2::new(
        view.x + view.zoom * AXIS_X * (ground.x - ground.y),
        view.y + view.zoom * AXIS_Y * (ground.x + ground.y),
    )
}

/// 屏幕坐标 `(y 向下)` → 画布世界 `(x, z)`。
pub fn screen_to_ground(view: &IsometricGridView, screen: Vec2) -> Vec2 {
    let zoom = if view.zoom.is_finite() && view.zoom > 0.0 {
        view.zoom
    } else {
        1.0
    };
    let dx = (screen.x - view.x) / zoom;
    let dy = (screen.y - view.y) / zoom;
    Vec2::new(
        0.5 * (dx / AXIS_X + dy / AXIS_Y),
        0.5 * (dy / AXIS_Y - dx / AXIS_X),
    )
}

/// 按 zoom 选档后的**世界间距**：`GRID_BASE_SPACING * 2^k`，使屏幕间距落入
/// `[GRID_MIN_SCREEN_SPACING, 2 * GRID_MIN_SCREEN_SPACING)`。保持 2 的幂使不同档位的
/// 线在世界坐标中对齐，缩放时不会滑动。
pub fn spacing_for_zoom(zoom: f32) -> f32 {
    let zoom = if zoom.is_finite() && zoom > 0.0 {
        zoom
    } else {
        1.0
    };
    let mut spacing = GRID_BASE_SPACING;
    let mut screen = spacing * zoom * PROJECTION_SCALE;
    let mut guard = 0;
    while screen < GRID_MIN_SCREEN_SPACING && guard < 32 {
        spacing *= 2.0;
        screen *= 2.0;
        guard += 1;
    }
    while screen >= GRID_MIN_SCREEN_SPACING * 2.0 && guard < 64 {
        spacing *= 0.5;
        screen *= 0.5;
        guard += 1;
    }
    spacing
}

/// 一帧的网格线规划（屏幕坐标，`y` 向下）。
#[derive(Default)]
pub struct GridPlan {
    /// 次线线段 `(起点, 终点)`。
    pub minor: Vec<(Vec2, Vec2)>,
    /// 主线线段 `(起点, 终点)`。
    pub major: Vec<(Vec2, Vec2)>,
    /// 本帧使用的世界间距（供测试/诊断）。
    pub spacing: f32,
}

/// 按当前 view 与画布尺寸规划网格线，保证覆盖整个画布。
pub fn plan_grid(view: &IsometricGridView, size: Vec2) -> GridPlan {
    let spacing = spacing_for_zoom(view.zoom);
    let corners = [
        Vec2::new(0.0, 0.0),
        Vec2::new(size.x, 0.0),
        Vec2::new(0.0, size.y),
        Vec2::new(size.x, size.y),
    ];
    let mut min = Vec2::splat(f32::INFINITY);
    let mut max = Vec2::splat(f32::NEG_INFINITY);
    for corner in corners {
        let ground = screen_to_ground(view, corner);
        min = min.min(ground);
        max = max.max(ground);
    }
    let margin = spacing;
    let mut plan = GridPlan {
        spacing,
        ..Default::default()
    };

    // 固定地面 z 的线（沿 x 方向延展）。
    let z_start = (min.y / spacing).floor() as i32 - 1;
    let z_end = (max.y / spacing).ceil() as i32 + 1;
    for index in z_start..=z_end {
        let z = index as f32 * spacing;
        let a = ground_to_screen(view, Vec2::new(min.x - margin, z));
        let b = ground_to_screen(view, Vec2::new(max.x + margin, z));
        if index % GRID_MAJOR_EVERY == 0 {
            plan.major.push((a, b));
        } else {
            plan.minor.push((a, b));
        }
    }

    // 固定地面 x 的线（沿 z 方向延展）。
    let x_start = (min.x / spacing).floor() as i32 - 1;
    let x_end = (max.x / spacing).ceil() as i32 + 1;
    for index in x_start..=x_end {
        let x = index as f32 * spacing;
        let a = ground_to_screen(view, Vec2::new(x, min.y - margin));
        let b = ground_to_screen(view, Vec2::new(x, max.y + margin));
        if index % GRID_MAJOR_EVERY == 0 {
            plan.major.push((a, b));
        } else {
            plan.minor.push((a, b));
        }
    }

    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(x: f32, y: f32, zoom: f32) -> IsometricGridView {
        IsometricGridView { x, y, zoom }
    }

    #[test]
    fn spacing_tiers_keep_screen_density_in_range() {
        for step in 0..60 {
            let zoom = 0.1 * 1.1_f32.powi(step);
            let spacing = spacing_for_zoom(zoom);
            let screen = spacing * zoom * PROJECTION_SCALE;
            assert!(screen >= GRID_MIN_SCREEN_SPACING - 1e-3);
            assert!(screen < GRID_MIN_SCREEN_SPACING * 2.0 + 1e-3);
        }
    }

    #[test]
    fn screen_to_ground_is_finite_for_invalid_zoom() {
        assert!(screen_to_ground(&view(0.0, 0.0, 0.0), Vec2::new(10.0, 10.0)).is_finite());
        assert!(screen_to_ground(&view(0.0, 0.0, f32::NAN), Vec2::new(10.0, 10.0)).is_finite());
    }

    #[test]
    fn embed_screen_point_keeps_orthographic_projection() {
        let surface = Vec2::new(1000.0, 800.0);
        let screen = Vec3::new(230.0, 361.0, 4.0);
        let world = embed_screen_point(screen, surface);
        let center = Vec3::new(surface.x * 0.5, surface.y * 0.5, CANVAS_CAMERA_Z);
        let view = view_rotation() * (world - center);
        assert!((view - (screen - center)).length() < 1e-3);
    }

    #[test]
    fn plan_line_counts_are_bounded() {
        let plan = plan_grid(&view(0.0, 0.0, 1.0), Vec2::new(1920.0, 1080.0));
        let total = plan.minor.len() + plan.major.len();
        assert!(total > 20 && total < 800, "unexpected line count {total}");
        assert!(!plan.major.is_empty());
    }

    #[test]
    fn canvas_point_roundtrips_without_viewport() {
        for (cx, cy, depth) in [(0.0, 0.0, 0.0), (230.0, 439.0, 12.0), (-50.0, 700.0, -3.0)] {
            let world = canvas_point_to_world(cx, cy, depth);
            let q = view_rotation() * world;
            assert!((q.x - cx).abs() < 1e-2);
            assert!((q.y + cy).abs() < 1e-2);
            assert!((q.z - depth).abs() < 1e-2);
        }
    }

    #[test]
    fn screen_mapping_satisfies_canvas_zoom_plus_pan() {
        // 任意 viewport 下，世界点投影 = viewport + zoom × 固定画布坐标（y 同号）。
        for vp in [
            view(0.0, 0.0, 1.0),
            view(137.0, -83.0, 0.5),
            view(-400.0, 250.0, 12.0),
        ] {
            for (cx, cy, depth) in [(123.0, 456.0, 7.0), (-9.0, -9.0, 0.0)] {
                let world = canvas_point_to_world(cx, cy, depth);
                let screen = screen_point_from_world(world, &vp);
                assert!((screen.x - (vp.x + vp.zoom * cx)).abs() < 1e-3);
                assert!((screen.y - (vp.y + vp.zoom * cy)).abs() < 1e-3);
                let back = screen_point_to_world(screen, depth, &vp);
                assert!((back - world).length() < 2e-3, "roundtrip {back:?} vs {world:?}");
            }
        }
    }

    #[test]
    fn camera_transform_matches_expected_viewport_mapping() {
        let size = Vec2::new(1000.0, 800.0);
        for vp in [view(0.0, 0.0, 1.0), view(40.0, -25.0, 2.0)] {
            let transform = canvas_camera_transform_for_view(size, &vp);
            let expected = canvas_camera_rotation()
                * Vec3::new(
                    (size.x / 2.0 - vp.x) / vp.zoom,
                    -(size.y / 2.0 - vp.y) / vp.zoom,
                    CANVAS_CAMERA_Z,
                );
            assert!((transform.translation - expected).length() < 1e-4);
            assert_eq!(transform.scale, Vec3::ONE);
            assert!(transform.rotation.abs_diff_eq(canvas_camera_rotation(), 1e-6));
        }
    }
}
