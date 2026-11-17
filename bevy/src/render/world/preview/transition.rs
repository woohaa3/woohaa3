//! Presentation-only flight from the actual canvas observer into the selected lens.
use bevy::{
    camera::{CameraProjection, ScalingMode, SubCameraView},
    math::Vec3A,
    prelude::*,
};

pub(super) const DURATION: f64 = 0.55;

pub(super) struct EntryFlight {
    pub node_id: String,
    pub started: f64,
    pub transform: Transform,
    pub projection: Projection,
    pub surface: Vec2,
}

impl EntryFlight {
    pub fn amount(&self, now: f64) -> f32 {
        let t = ((now - self.started) / DURATION).clamp(0.0, 1.0) as f32;
        1.0 - (1.0 - t).powi(4)
    }

    pub fn pose(&self, target: Transform, amount: f32) -> Transform {
        Transform::from_translation(self.transform.translation.lerp(target.translation, amount))
            .with_rotation(self.transform.rotation.slerp(target.rotation, amount))
    }

    pub fn rect(&self, target: Vec4, amount: f32) -> Vec4 {
        Vec4::new(0.0, 0.0, self.surface.x, self.surface.y).lerp(target, amount)
    }

    pub fn lens(
        &self,
        mut target: Projection,
        rect: Vec4,
        amount: f32,
        source_zoom: f32,
        target_height: f32,
    ) -> Projection {
        let mut source = self.projection.clone();
        if let Projection::Orthographic(projection) = &mut source {
            projection.scale = 1.0;
            projection.scaling_mode = ScalingMode::FixedVertical {
                viewport_height: self.surface.y / source_zoom,
            };
        }
        if let Projection::Orthographic(projection) = &mut target {
            projection.scale = 1.0;
            projection.scaling_mode = ScalingMode::FixedVertical {
                viewport_height: target_height,
            };
        }
        source.update(rect.z, rect.w);
        target.update(rect.z, rect.w);
        // Normalize homogeneous W at a useful scene distance before blending. This
        // continuously morphs orthographic into perspective without a lens switch.
        let distance = match &target {
            Projection::Perspective(projection) => {
                (target_height / (2.0 * (projection.fov * 0.5).tan())).max(1.0)
            }
            _ => 1.0,
        };
        Projection::custom(BlendedLens {
            matrix: source.get_clip_from_view() * (1.0 - amount)
                + target.get_clip_from_view() * (amount / distance),
            far: source.far().max(target.far()),
        })
    }
}

#[derive(Clone, Debug)]
struct BlendedLens {
    matrix: Mat4,
    far: f32,
}

impl CameraProjection for BlendedLens {
    fn get_clip_from_view(&self) -> Mat4 {
        self.matrix
    }
    fn get_clip_from_view_for_sub(&self, view: &SubCameraView) -> Mat4 {
        let size = view.size.as_vec2();
        let scale = view.full_size.as_vec2() / size;
        let offset = (view.full_size.as_vec2() - size - 2.0 * view.offset) / size;
        let crop = Mat4::from_cols(
            Vec4::new(scale.x, 0.0, 0.0, 0.0),
            Vec4::new(0.0, scale.y, 0.0, 0.0),
            Vec4::Z,
            Vec4::new(offset.x, -offset.y, 0.0, 1.0),
        );
        crop * self.matrix
    }
    // The logical display rectangle determines aspect; the image size is held
    // constant through the flight to avoid allocating a render target every frame.
    fn update(&mut self, _width: f32, _height: f32) {}
    fn far(&self) -> f32 {
        self.far
    }
    fn get_frustum_corners(&self, near: f32, far: f32) -> [Vec3A; 8] {
        std::array::from_fn(|index| {
            let z = if index < 4 { near } else { far };
            let w = self.matrix.z_axis.w * z + self.matrix.w_axis.w;
            let x = if index % 4 < 2 { 1.0 } else { -1.0 };
            let y = if index % 4 == 0 || index % 4 == 3 {
                -1.0
            } else {
                1.0
            };
            Vec3A::new(
                x * w / self.matrix.x_axis.x,
                y * w / self.matrix.y_axis.y,
                z,
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn world_camera_entry_flight_starts_at_observer_and_arrives_without_lens_jump() {
        let flight = EntryFlight {
            node_id: "camera".into(),
            started: 5.0,
            transform: Transform::from_xyz(100.0, 200.0, 300.0),
            projection: Projection::Orthographic(crate::isometric_grid::canvas_camera_projection()),
            surface: Vec2::new(1200.0, 800.0),
        };
        let end =
            Transform::from_xyz(-200.0, 100.0, 40.0).with_rotation(Quat::from_rotation_y(1.2));
        let rect = Vec4::new(100.0, 80.0, 1000.0, 562.5);
        assert_eq!(flight.amount(5.0), 0.0);
        assert_eq!(flight.pose(end, 0.0), flight.transform);
        assert_eq!(flight.rect(rect, 0.0), Vec4::new(0.0, 0.0, 1200.0, 800.0));
        assert_eq!(flight.amount(5.0 + DURATION), 1.0);
        assert!(flight.pose(end, 1.0).translation.distance(end.translation) < 1e-4);
        assert!(flight.pose(end, 1.0).rotation.angle_between(end.rotation) < 1e-4);
        assert_eq!(flight.rect(rect, 1.0), rect);
        let perspective = Projection::Perspective(PerspectiveProjection::default());
        let start = flight.lens(perspective.clone(), flight.rect(rect, 0.0), 0.0, 2.0, 512.0);
        let mut expected_start = OrthographicProjection {
            scale: 1.0,
            scaling_mode: ScalingMode::FixedVertical {
                viewport_height: 400.0,
            },
            ..crate::isometric_grid::canvas_camera_projection()
        };
        expected_start.update(1200.0, 800.0);
        assert!(
            start
                .get_clip_from_view()
                .abs_diff_eq(expected_start.get_clip_from_view(), 1e-6)
        );
        let mut expected_end = perspective.clone();
        expected_end.update(rect.z, rect.w);
        let point = Vec3::new(30.0, 40.0, -500.0);
        let finish = flight.lens(perspective.clone(), rect, 1.0, 2.0, 512.0);
        assert!(
            finish
                .get_clip_from_view()
                .project_point3(point)
                .distance(expected_end.get_clip_from_view().project_point3(point))
                < 1e-5
        );
        for step in 0..=100 {
            let amount = step as f32 / 100.0;
            let lens = flight.lens(
                perspective.clone(),
                flight.rect(rect, amount),
                amount,
                2.0,
                512.0,
            );
            let matrix = lens.get_clip_from_view();
            assert!(matrix.is_finite() && matrix.inverse().is_finite());
            assert!(
                lens.get_frustum_corners(-1.0, -1000.0)
                    .iter()
                    .all(|point| point.is_finite())
            );
        }
    }
}
