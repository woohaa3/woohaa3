//! Shared-world v1 basis conversion. Asset-local coordinates remain Y-up.
pub(crate) const UNITS_PER_METER: f64 = 64.0;

pub(crate) fn world_to_renderer(p: [f64; 3]) -> [f64; 3] {
    [p[0] * UNITS_PER_METER, p[2] * UNITS_PER_METER, -p[1] * UNITS_PER_METER]
}
pub(crate) fn renderer_to_world(p: [f64; 3]) -> [f64; 3] {
    [p[0] / UNITS_PER_METER, -p[2] / UNITS_PER_METER, p[1] / UNITS_PER_METER]
}
pub(crate) fn world_rotation_to_renderer(q: [f64; 4]) -> [f64; 4] {
    [q[0], q[2], -q[1], q[3]]
}
pub(crate) fn renderer_rotation_to_world(q: [f64; 4]) -> [f64; 4] {
    [q[0], -q[2], q[1], q[3]]
}

#[cfg(test)]
mod tests {
    use crate::protocol::{UNITS_PER_METER, renderer_rotation_to_world, renderer_to_world, world_rotation_to_renderer, world_to_renderer};
    use serde::Deserialize;
    #[derive(Deserialize)]
    struct Fixture { cases: Vec<Case> }
    #[derive(Deserialize)]
    struct Case { world: [f64; 3], renderer: [f64; 3], rotation: [f64; 4], renderer_rotation: [f64; 4], scale: f64, asset_point: [f64; 3], renderer_point: [f64; 3] }
    #[test]
    fn shared_fixture() {
        let fixture: Fixture = serde_json::from_str(include_str!("../../tests/fixtures/shared-world/coordinates.json")).unwrap();
        for case in fixture.cases {
            assert_eq!(world_to_renderer(case.world), case.renderer);
            assert_eq!(renderer_to_world(case.renderer), case.world);
            assert_eq!(world_rotation_to_renderer(case.rotation), case.renderer_rotation);
            assert_eq!(renderer_rotation_to_world(case.renderer_rotation), case.rotation);
            let q = bevy::math::DQuat::from_array(case.renderer_rotation);
            let local = bevy::math::DVec3::from_array(case.asset_point);
            let translation = bevy::math::DVec3::from_array(case.renderer);
            let expected = bevy::math::DVec3::from_array(case.renderer_point);
            let actual = translation + q * (local * case.scale * UNITS_PER_METER);
            assert!((actual - expected).length() < 1e-10);
            let inverse = q.inverse() * (expected - translation) / (case.scale * UNITS_PER_METER);
            assert!((inverse - local).length() < 1e-10);
        }
    }
}
