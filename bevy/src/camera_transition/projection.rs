//! Continuous orthographic/perspective transition, normalized at the framing pivot.
//! Both endpoints use the actual camera pose; changing focus never teleports the model.
//!
//! 过渡混合仅在 wasm 画布运行时消费；native-renderer 不启用聚焦过渡。
#![cfg_attr(not(feature = "canvas-core"), allow(dead_code))]
use bevy::camera::{CameraProjection, SubCameraView};
use bevy::math::Vec3A;
use bevy::prelude::*;

/// 进入/退出聚焦的连续投影与姿态过渡。
///
/// 投影是两端 clip 矩阵在**锚点归一化**后的线性混合：锚点（模型聚焦中心）处两者的
/// 「每世界单位 NDC」相等，因此缩放沿过渡线性、端点为真实相机矩阵。
///
/// 但**姿态平移不能独立插值**：世界平移 lerp 与投影混合各自进行时，二者不构成同一
/// 相机沿锚点屏幕直线的移动，锚点在中途会先向外鼓出再收回——表现为模型「先放大、
/// 再从视口外飞入」（design D7/D11 的连续交接要求）。因此这里保存两端姿态与锚点屏幕
/// 位置，逐帧**反解**相机平移，使锚点沿两端屏幕坐标的直线单调移动。
#[derive(Clone, Debug)]
pub(crate) struct FocusProjectionBlend {
    pub(crate) from: Projection,
    pub(crate) to: Projection,
    pub(crate) progress: f32,
    pub(crate) from_normalization: f32,
    pub(crate) to_normalization: f32,
    /// 世界锚点（模型聚焦中心）；决定相机平移的屏幕直线约束。
    pivot: Vec3,
    from_pose: Transform,
    to_pose: Transform,
    /// 锚点在两端各自取景下的屏幕 NDC。
    from_ndc: Vec2,
    to_ndc: Vec2,
    /// 锚点在两端各自视图空间的深度（沿相机前向的 z）。
    from_depth: f32,
    to_depth: f32,
}

impl FocusProjectionBlend {
    pub(crate) fn normalization(projection: &Projection, pose: &Transform, pivot: Vec3) -> f32 {
        if matches!(projection, Projection::Perspective(_)) {
            (pose.rotation.inverse() * (pivot - pose.translation))
                .z
                .abs()
                .max(0.001)
        } else {
            1.0
        }
    }

    /// 从两端投影/姿态与锚点建立一次过渡；预计算屏幕直线约束所需的端点数据。
    pub(crate) fn new(
        from: Projection,
        to: Projection,
        from_pose: Transform,
        to_pose: Transform,
        pivot: Vec3,
    ) -> Self {
        let from_normalization = Self::normalization(&from, &from_pose, pivot);
        let to_normalization = Self::normalization(&to, &to_pose, pivot);
        let from_ndc = project_pivot_ndc(&from, &from_pose, pivot, from_normalization);
        let to_ndc = project_pivot_ndc(&to, &to_pose, pivot, to_normalization);
        Self {
            from,
            to,
            progress: 0.0,
            from_normalization,
            to_normalization,
            pivot,
            from_pose,
            to_pose,
            from_ndc,
            to_ndc,
            from_depth: pivot_depth(&from_pose, pivot),
            to_depth: pivot_depth(&to_pose, pivot),
        }
    }

    fn blend(&self, from: Mat4, to: Mat4, progress: f32) -> Mat4 {
        from * ((1.0 - progress) / self.from_normalization)
            + to * (progress / self.to_normalization)
    }

    /// 按进度求值相机姿态：旋转 slerp，平移由锚点屏幕直线反解。
    ///
    /// 端点处逐位还原 `from_pose`/`to_pose`（锚点分别落在 `from_ndc`/`to_ndc`），中途锚点
    /// 沿两端屏幕坐标直线移动，不再横向鼓包。
    pub(crate) fn pose_at(&self, progress: f32) -> Transform {
        let t = progress.clamp(0.0, 1.0);
        // 端点逐位返回真实姿态，避免反解舍入漂移。
        if t <= 0.0 {
            return self.from_pose;
        }
        if t >= 1.0 {
            return self.to_pose;
        }
        let rotation = self.from_pose.rotation.slerp(self.to_pose.rotation, t);
        let m = self.blend(
            self.from.get_clip_from_view(),
            self.to.get_clip_from_view(),
            t,
        );
        let ndc = self.from_ndc.lerp(self.to_ndc, t);
        let lz = self.from_depth + (self.to_depth - self.from_depth) * t;
        let lateral = solve_view_lateral(m, lz, ndc);
        let view_pivot = Vec3::new(lateral.x, lateral.y, lz);
        Transform {
            translation: self.pivot - rotation * view_pivot,
            rotation,
            scale: Vec3::ONE,
        }
    }
}

/// 锚点在给定投影/姿态/归一化下的屏幕 NDC（xy）。
fn project_pivot_ndc(
    projection: &Projection,
    pose: &Transform,
    pivot: Vec3,
    normalization: f32,
) -> Vec2 {
    let clip = projection.get_clip_from_view() / normalization;
    let view = pose.to_matrix().inverse();
    let p = clip * view * pivot.extend(1.0);
    if p.w.abs() > 1e-6 {
        Vec2::new(p.x / p.w, p.y / p.w)
    } else {
        Vec2::ZERO
    }
}

/// 锚点在姿态视图空间的深度（沿相机前向的 z）。
fn pivot_depth(pose: &Transform, pivot: Vec3) -> f32 {
    (pose.rotation.inverse() * (pivot - pose.translation)).z
}

/// 反解视图空间平移的 `x`/`y`，使锚点在混合投影 `m`、深度 `lz` 下落到屏幕 `ndc`。
///
/// 由 `ndc.x = (r0·L)/(r3·L)`、`ndc.y = (r1·L)/(r3·L)`（`L=(lx,ly,lz,1)`）得到两个关于
/// `lx,ly` 的线性方程；行列式退化（投影在该深度近似奇异）时回落到视图中心。
fn solve_view_lateral(m: Mat4, lz: f32, ndc: Vec2) -> Vec2 {
    let rx = m.row(0);
    let ry = m.row(1);
    let rw = m.row(3);
    let (nx, ny) = (ndc.x, ndc.y);
    let a1 = rx.x - nx * rw.x;
    let b1 = rx.y - nx * rw.y;
    let c1 = nx * (rw.z * lz + rw.w) - (rx.z * lz + rx.w);
    let a2 = ry.x - ny * rw.x;
    let b2 = ry.y - ny * rw.y;
    let c2 = ny * (rw.z * lz + rw.w) - (ry.z * lz + ry.w);
    let det = a1 * b2 - a2 * b1;
    if det.abs() <= 1e-9 {
        return Vec2::ZERO;
    }
    Vec2::new((c1 * b2 - c2 * b1) / det, (a1 * c2 - a2 * c1) / det)
}

impl CameraProjection for FocusProjectionBlend {
    fn get_clip_from_view(&self) -> Mat4 {
        self.blend(
            self.from.get_clip_from_view(),
            self.to.get_clip_from_view(),
            self.progress,
        )
    }
    fn get_clip_from_view_for_sub(&self, view: &SubCameraView) -> Mat4 {
        self.blend(
            self.from.get_clip_from_view_for_sub(view),
            self.to.get_clip_from_view_for_sub(view),
            self.progress,
        )
    }
    fn update(&mut self, width: f32, height: f32) {
        self.from.update(width, height);
        self.to.update(width, height);
    }
    fn far(&self) -> f32 {
        self.from.far().max(self.to.far())
    }
    fn get_frustum_corners(&self, z_near: f32, z_far: f32) -> [Vec3A; 8] {
        let m = self.get_clip_from_view();
        let corner = |x: f32, y: f32, z: f32| {
            let z = -z;
            let w = m.z_axis.w * z + m.w_axis.w;
            Vec3A::new(
                (x * w - m.z_axis.x * z - m.w_axis.x) / m.x_axis.x,
                (y * w - m.z_axis.y * z - m.w_axis.y) / m.y_axis.y,
                z,
            )
        };
        [
            corner(1.0, -1.0, z_near),
            corner(1.0, 1.0, z_near),
            corner(-1.0, 1.0, z_near),
            corner(-1.0, -1.0, z_near),
            corner(1.0, -1.0, z_far),
            corner(1.0, 1.0, z_far),
            corner(-1.0, 1.0, z_far),
            corner(-1.0, -1.0, z_far),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::camera::ScalingMode;

    /// 真实“模型聚焦进入”端点（drawing 采集自 dev 画布），已验证旧实现中途 NDC 鼓包。
    fn entered_focus_blend() -> FocusProjectionBlend {
        let rotation = Quat::from_xyzw(-0.239118, 0.369644, 0.099046, 0.892399);
        let from_pose = Transform {
            translation: Vec3::new(839.8231, -477.9171, 22.0724),
            rotation,
            scale: Vec3::ONE,
        };
        let to_pose = Transform {
            translation: Vec3::new(1110.3652, -364.6503, -340.9514),
            rotation,
            scale: Vec3::ONE,
        };
        let pivot = Vec3::new(943.3801, -500.993, -507.9365);
        let mut from = Projection::Orthographic(OrthographicProjection {
            scaling_mode: ScalingMode::Fixed {
                width: 2232.9724,
                height: 1395.6078,
            },
            near: 0.0,
            far: 200000.0,
            ..OrthographicProjection::default_3d()
        });
        from.update(1440.0, 900.0);
        let mut to = Projection::Perspective(PerspectiveProjection {
            fov: 0.8726646,
            near: 0.05,
            far: 200000.0,
            ..default()
        });
        to.update(1440.0, 900.0);
        FocusProjectionBlend::new(from, to, from_pose, to_pose, pivot)
    }

    fn ndc_of(blend: &FocusProjectionBlend, pose: &Transform) -> Vec2 {
        let m = blend.get_clip_from_view();
        let p = m * pose.to_matrix().inverse() * blend.pivot.extend(1.0);
        Vec2::new(p.x / p.w, p.y / p.w)
    }

    #[test]
    fn endpoints_restore_poses_exactly() {
        let blend = entered_focus_blend();
        let start = blend.pose_at(0.0);
        let end = blend.pose_at(1.0);
        assert!(
            start
                .translation
                .abs_diff_eq(blend.from_pose.translation, 1e-3),
            "{:?}",
            start.translation
        );
        assert!(start.rotation.abs_diff_eq(blend.from_pose.rotation, 1e-5));
        assert!(
            end.translation.abs_diff_eq(blend.to_pose.translation, 1e-3),
            "{:?}",
            end.translation
        );
        assert!(end.rotation.abs_diff_eq(blend.to_pose.rotation, 1e-5));
    }

    #[test]
    fn pivot_path_is_monotone_on_screen() {
        // 旧实现锚点 NDC x 先越过 from 值（0.401→峰值~0.66）再回到 0；修正后应单调。
        let blend = entered_focus_blend();
        let from_x = blend.from_ndc.x;
        let mut previous = from_x;
        for step in 1..=20 {
            let mut frame = blend.clone();
            frame.progress = step as f32 / 20.0;
            let ndc = ndc_of(&frame, &frame.pose_at(frame.progress));
            // 单调下降（from_ndc.x > to_ndc.x），且不越界到 from 之外。
            assert!(
                ndc.x <= previous + 1e-4,
                "step {step}: {} > {previous}（鼓包）",
                ndc.x
            );
            assert!(
                ndc.x <= from_x + 1e-4,
                "step {step}: {} 越过起点 {}（向外鼓出）",
                ndc.x,
                from_x
            );
            previous = ndc.x;
        }
    }

    #[test]
    fn apparent_scale_is_monotone_and_matches_endpoints() {
        // 逐帧「每世界单位 NDC」应沿过渡单调放大，端点等于真实相机缩放。
        let blend = entered_focus_blend();
        let scale = |progress: f32| {
            let mut frame = blend.clone();
            frame.progress = progress;
            let pose = frame.pose_at(progress);
            let m = frame.get_clip_from_view();
            let view = pose.to_matrix().inverse();
            let project = |p: Vec3| {
                let q = m * view * p.extend(1.0);
                q.truncate() / q.w
            };
            let at = project(blend.pivot);
            let off = project(blend.pivot + blend.from_pose.rotation * Vec3::new(10.0, 0.0, 0.0));
            ((off.x - at.x) / 10.0).abs()
        };
        let start = scale(0.0);
        let end = scale(1.0);
        assert!(end > start, "聚焦应放大：{start} -> {end}");
        let mut previous = start;
        for step in 1..=20 {
            let current = scale(step as f32 / 20.0);
            assert!(
                current >= previous - 1e-6,
                "step {step}: 缩放回退 {current} < {previous}"
            );
            previous = current;
        }
    }

    #[test]
    fn rotating_endpoints_stay_finite() {
        let mut blend = entered_focus_blend();
        blend.to_pose.rotation = Quat::from_euler(EulerRot::YXZ, 1.2, -0.3, 0.4);
        for step in 0..=20 {
            let progress = step as f32 / 20.0;
            let pose = blend.pose_at(progress);
            assert!(pose.translation.is_finite() && pose.rotation.is_finite());
        }
    }

    #[test]
    fn endpoints_preserve_screen_coordinates_and_midpoint_is_finite() {
        let mut from = Projection::Orthographic(OrthographicProjection::default_3d());
        let mut to = Projection::Perspective(PerspectiveProjection::default());
        from.update(1200.0, 800.0);
        to.update(1200.0, 800.0);
        let pose = Transform::IDENTITY;
        let mut blend =
            FocusProjectionBlend::new(from, to, pose, pose, Vec3::new(40.0, 25.0, -500.0));
        let point = Vec3::new(40.0, 25.0, -500.0);
        blend.progress = 0.0;
        assert!(
            blend
                .get_clip_from_view()
                .project_point3(point)
                .abs_diff_eq(blend.from.get_clip_from_view().project_point3(point), 1e-5)
        );
        blend.progress = 1.0;
        assert!(
            blend
                .get_clip_from_view()
                .project_point3(point)
                .abs_diff_eq(blend.to.get_clip_from_view().project_point3(point), 1e-5)
        );
        blend.progress = 0.5;
        assert!(blend.get_clip_from_view().project_point3(point).is_finite());
    }
}
