use bevy::math::{Vec2, Vec3};

/// CSS dimensions of the observer's actual content viewport, never framebuffer pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GizmoView {
    pub position: Vec3,
    pub forward: Vec3,
    pub right: Vec3,
    pub up: Vec3,
    pub size: Vec2,
    pub fov: f32,
    pub near: f32,
}

impl GizmoView {
    pub fn orbit(
        target: Vec3,
        yaw: f32,
        pitch: f32,
        distance: f32,
        size: Vec2,
        fov: f32,
    ) -> Option<Self> {
        if !target.is_finite()
            || !yaw.is_finite()
            || !pitch.is_finite()
            || !distance.is_finite()
            || distance <= 0.0
        {
            return None;
        }
        let position = target
            + Vec3::new(
                yaw.sin() * pitch.cos(),
                -pitch.sin(),
                yaw.cos() * pitch.cos(),
            ) * distance;
        Self::new(position, target - position, Vec3::Y, size, fov, 0.05)
    }
    pub fn new(
        position: Vec3,
        forward: Vec3,
        up: Vec3,
        size: Vec2,
        fov: f32,
        near: f32,
    ) -> Option<Self> {
        if !position.is_finite()
            || !forward.is_finite()
            || !up.is_finite()
            || !size.is_finite()
            || size.min_element() <= 0.0
            || !fov.is_finite()
            || !(0.01..3.13).contains(&fov)
            || !near.is_finite()
            || near <= 0.0
        {
            return None;
        }
        let forward = forward.try_normalize()?;
        let right = forward.cross(up).try_normalize()?;
        Some(Self {
            position,
            forward,
            right,
            up: right.cross(forward),
            size,
            fov,
            near,
        })
    }
    pub fn world_per_css(&self, anchor: Vec3) -> Option<f32> {
        let depth = (anchor - self.position).dot(self.forward);
        let scale = 2.0 * depth * (self.fov * 0.5).tan() / self.size.y;
        (anchor.is_finite() && depth > self.near && scale.is_finite() && scale > 0.0)
            .then_some(scale)
    }
    pub fn project(&self, world: Vec3) -> Option<Vec2> {
        let scale = self.world_per_css(world)?;
        let rel = world - self.position;
        let point = self.size * 0.5 + Vec2::new(rel.dot(self.right), -rel.dot(self.up)) / scale;
        point.is_finite().then_some(point)
    }
    pub fn ray(&self, point: Vec2) -> Option<(Vec3, Vec3)> {
        if !point.is_finite() {
            return None;
        }
        let focal = self.size.y / (2.0 * (self.fov * 0.5).tan());
        let p = (point - self.size * 0.5) / focal;
        Some((
            self.position,
            (self.forward + self.right * p.x - self.up * p.y).try_normalize()?,
        ))
    }
    pub fn plane_point(&self, pointer: Vec2, origin: Vec3, normal: Vec3) -> Option<Vec3> {
        let (eye, dir) = self.ray(pointer)?;
        let denominator = normal.dot(dir);
        if denominator.abs() < 0.08 {
            return None;
        }
        let t = normal.dot(origin - eye) / denominator;
        (t.is_finite() && t > self.near).then_some(eye + dir * t)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn screen_scale_tracks_depth_and_rejects_clipping_and_invalid_view() {
        let a =
            GizmoView::orbit(Vec3::ZERO, 0.0, 0.0, 10.0, Vec2::new(1000.0, 800.0), 1.0).unwrap();
        let b = GizmoView::orbit(Vec3::ZERO, 0.0, 0.0, 20.0, a.size, 1.0).unwrap();
        assert_eq!(
            b.world_per_css(Vec3::ZERO),
            a.world_per_css(Vec3::ZERO).map(|s| s * 2.0)
        );
        assert!(a.world_per_css(a.position).is_none());
        assert!(a.project(a.position - a.forward).is_none());
        assert!(GizmoView::orbit(Vec3::ZERO, 0.0, 0.0, 10.0, Vec2::ZERO, 1.0).is_none());
        assert!(GizmoView::orbit(Vec3::ZERO, f32::NAN, 0.0, 10.0, a.size, 1.0).is_none());
    }
}
