use super::{GizmoLine, GizmoView, hit_lines};
use bevy::math::{Mat3, Vec2, Vec3};

pub const AXIS_CSS: f32 = 88.0;
pub const YAW_RADIUS_CSS: f32 = 64.0;
pub const RING_SEGMENTS: usize = 64;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ObjectTool {
    #[default]
    Move,
    Yaw,
    Scale,
}

#[derive(Clone, Debug)]
pub struct ObjectGizmoLayout {
    pub origin: Vec3,
    pub scale: f32,
    pub lines: Vec<GizmoLine>,
    pub axes: [Option<(Vec2, f32)>; 3],
    pub scale_point: Option<Vec3>,
    pub tool: ObjectTool,
    pub ring_u: Vec3,
    pub ring_v: Vec3,
}

impl ObjectGizmoLayout {
    pub fn new(view: &GizmoView, origin: Vec3, tool: ObjectTool, parent: Mat3) -> Option<Self> {
        let scale = view.world_per_css(origin)?;
        view.project(origin)?;
        let mut result = Self {
            origin,
            scale,
            lines: Vec::new(),
            axes: [None; 3],
            scale_point: None,
            tool,
            ring_u: parent * Vec3::X,
            ring_v: parent * Vec3::NEG_Z,
        };
        let basis_size = result.ring_u.length().max(result.ring_v.length());
        if !parent.is_finite()
            || !basis_size.is_finite()
            || basis_size <= 1e-8
            || parent.determinant().abs() <= 1e-12
        {
            return None;
        }
        result.ring_u *= scale * YAW_RADIUS_CSS / basis_size;
        result.ring_v *= scale * YAW_RADIUS_CSS / basis_size;
        match tool {
            ObjectTool::Move => {
                let screen = view.project(origin)?;
                for (index, axis) in [Vec3::X, Vec3::Y, Vec3::Z].into_iter().enumerate() {
                    let tip = origin + axis * (scale * AXIS_CSS);
                    let Some(projected) = view.project(tip) else {
                        continue;
                    };
                    let delta = projected - screen;
                    // An almost end-on axis has no stable drag constraint and is not drawn.
                    if delta.length() < 12.0 {
                        continue;
                    }
                    result.axes[index] =
                        Some((delta.normalize(), scale * AXIS_CSS / delta.length()));
                    let handle = ["x", "y", "z"][index];
                    let end = tip - axis * scale * 9.0;
                    result.line(origin + axis * scale * 7.0, end, 1.75, handle);
                    let side = axis
                        .cross(view.forward)
                        .try_normalize()
                        .unwrap_or(view.right)
                        * scale
                        * 3.0;
                    result.line(end + side, tip, 1.75, handle);
                    result.line(end - side, tip, 1.75, handle);
                }
                result.square(view, origin, 5.0, "center");
            }
            ObjectTool::Yaw => {
                for i in 0..RING_SEGMENTS {
                    let a = i as f32 / RING_SEGMENTS as f32 * std::f32::consts::TAU;
                    let b = (i + 1) as f32 / RING_SEGMENTS as f32 * std::f32::consts::TAU;
                    result.line(result.ring_point(a), result.ring_point(b), 1.75, "yaw-ring");
                }
            }
            ObjectTool::Scale => {
                let tip = origin + (view.right + view.up).normalize() * scale * 64.0;
                if view.project(tip).is_some() {
                    result.line(origin, tip, 1.25, "");
                    result.square(view, tip, 5.0, "scale");
                    result.scale_point = Some(tip);
                }
            }
        }
        Some(result)
    }
    fn line(&mut self, start: Vec3, end: Vec3, width_css: f32, handle: &'static str) {
        self.lines.push(GizmoLine {
            start,
            end,
            width_css,
            handle,
            secondary: false,
            rear: false,
            visible: true,
        });
    }
    fn square(&mut self, view: &GizmoView, center: Vec3, half: f32, handle: &'static str) {
        let r = view.right * self.scale * half;
        let u = view.up * self.scale * half;
        let p = [
            center - r - u,
            center + r - u,
            center + r + u,
            center - r + u,
        ];
        for i in 0..4 {
            self.line(p[i], p[(i + 1) % 4], 1.75, handle);
        }
    }
    pub fn ring_point(&self, angle: f32) -> Vec3 {
        self.origin + self.ring_u * angle.cos() + self.ring_v * angle.sin()
    }
    pub fn hit(&self, view: &GizmoView, pointer: Vec2) -> Option<&'static str> {
        let center = view.project(self.origin)?;
        if self.tool == ObjectTool::Move && (pointer - center).abs().max_element() <= 9.0 {
            return Some("center");
        }
        if let Some(point) = self.scale_point
            && (pointer - view.project(point)?).abs().max_element() <= 10.0
        {
            return Some("scale");
        }
        hit_lines(&self.lines, view, pointer).map(|(h, _)| h)
    }
    pub fn yaw_constraint(&self, view: &GizmoView, pointer: Vec2) -> Option<YawConstraint> {
        let normal = self.ring_u.cross(self.ring_v).try_normalize()?;
        let mut result = YawConstraint {
            origin: self.origin.to_array(),
            u: self.ring_u.to_array(),
            v: self.ring_v.to_array(),
            normal: normal.to_array(),
            start_angle: 0.0,
            mode: "plane".into(),
            direction: [0.0; 2],
            radians_per_pixel: 0.0,
        };
        if let Some(point) = view.plane_point(pointer, self.origin, normal) {
            result.start_angle = self.angle(point)?;
        } else {
            // Edge-on rings use the nearest finite projected tangent, frozen at pointer-down.
            let mut best = None;
            for i in 0..RING_SEGMENTS {
                let angle = i as f32 / RING_SEGMENTS as f32 * std::f32::consts::TAU;
                let p = view.project(self.ring_point(angle))?;
                let q = view.project(self.ring_point(angle + 0.01))?;
                let tangent = (q - p) / 0.01;
                if tangent.length() < 12.0 {
                    continue;
                }
                let distance = pointer.distance_squared(p);
                if best.is_none_or(|(d, _, _): (f32, f32, Vec2)| distance < d) {
                    best = Some((distance, angle, tangent));
                }
            }
            let (_, angle, tangent) = best?;
            result.start_angle = angle;
            result.mode = "tangent".into();
            result.direction = tangent.normalize().to_array();
            result.radians_per_pixel = 1.0 / tangent.length();
        }
        Some(result)
    }
    fn angle(&self, point: Vec3) -> Option<f32> {
        let normal = self.ring_u.cross(self.ring_v).try_normalize()?;
        let inverse = Mat3::from_cols(self.ring_u, self.ring_v, normal).inverse();
        let local = inverse * (point - self.origin);
        (local.is_finite() && local.truncate().length() > 1e-5).then(|| local.y.atan2(local.x))
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YawConstraint {
    pub origin: [f32; 3],
    pub u: [f32; 3],
    pub v: [f32; 3],
    pub normal: [f32; 3],
    pub start_angle: f32,
    pub mode: String,
    pub direction: [f32; 2],
    pub radians_per_pixel: f32,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_independent_handles_and_degenerate_axes_share_picking_geometry() {
        for distance in [10.0, 100.0, 10000.0] {
            let view = GizmoView::orbit(
                Vec3::ZERO,
                0.0,
                0.0,
                distance,
                Vec2::new(1200.0, 800.0),
                1.0,
            )
            .unwrap();
            let g = ObjectGizmoLayout::new(&view, Vec3::ZERO, ObjectTool::Move, Mat3::IDENTITY)
                .unwrap();
            assert!((g.axes[0].unwrap().1 * g.axes[0].unwrap().0.length() - g.scale).abs() < 1e-3);
            assert!(g.axes[2].is_none());
            assert_eq!(g.hit(&view, Vec2::new(644.0, 400.0)), Some("x"));
            assert_eq!(g.hit(&view, Vec2::new(600.0, 400.0)), Some("center"));
            assert_eq!(g.lines.len(), 10);
        }
    }
    #[test]
    fn edge_on_yaw_has_finite_tangent_and_parent_basis_is_preserved() {
        let view =
            GizmoView::orbit(Vec3::ZERO, 0.0, 0.0, 10.0, Vec2::new(1200.0, 800.0), 1.0).unwrap();
        let g = ObjectGizmoLayout::new(&view, Vec3::ZERO, ObjectTool::Yaw, Mat3::IDENTITY).unwrap();
        let c = g.yaw_constraint(&view, Vec2::new(600.0, 400.0)).unwrap();
        assert_eq!(c.mode, "tangent");
        assert!(c.radians_per_pixel.is_finite());
        let parent = Mat3::from_rotation_x(0.6) * Mat3::from_diagonal(Vec3::new(2.0, 3.0, 4.0));
        let g = ObjectGizmoLayout::new(&view, Vec3::ZERO, ObjectTool::Yaw, parent).unwrap();
        assert!(
            g.ring_u
                .cross(g.ring_v)
                .normalize()
                .dot((parent * Vec3::X).cross(parent * Vec3::NEG_Z).normalize())
                > 0.999
        );
    }
}
