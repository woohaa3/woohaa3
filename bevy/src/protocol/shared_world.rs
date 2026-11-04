//! Shared-world v1 basis conversion. Asset-local coordinates remain Y-up.
pub(crate) const UNITS_PER_METER: f64 = 64.0;

use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct WorldInstance {
    pub(crate) kind: String,
    pub(crate) version: String,
    pub(crate) instance_id: String,
    pub(crate) transform: WorldTransform,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorldTransform {
    pub(crate) version: String,
    pub(crate) position: WorldPoint,
    pub(crate) rotation: [f64; 4],
    pub(crate) scale: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorldPoint { pub(crate) u: f64, pub(crate) v: f64, pub(crate) h: f64 }

impl WorldInstance {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        let t = &self.transform;
        let norm: f64 = t.rotation.iter().map(|v| v * v).sum();
        if self.kind != "world-instance" || self.version != "shared-world-v1"
            || self.instance_id.trim().is_empty() || t.version != "shared-world-v1"
            || ![t.position.u, t.position.v, t.position.h, t.scale].iter().all(|v| v.is_finite())
            || !t.rotation.iter().all(|v| v.is_finite()) || (norm - 1.0).abs() > 1e-6 || t.scale <= 0.0 {
            return Err("Invalid shared world instance");
        }
        Ok(())
    }
}

pub(crate) fn deserialize_instance<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<WorldInstance>, D::Error> {
    WorldInstance::deserialize(d).map(Some)
}

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
