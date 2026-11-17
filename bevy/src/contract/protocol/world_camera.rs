//! Shared-world camera DTO carried by `world-camera` canvas nodes.
//!
//! Rust only performs boundary-level defence; the Web contracts own the authoritative
//! codec. The pose follows `shared-world-v1`: `[u, v, h, w]` quaternion in the world
//! basis, local `-Z` forward and `+Y` up after the basis change.
#![cfg_attr(not(feature = "canvas-core"), allow(dead_code))]

use serde::Deserialize;

pub(crate) const WORLD_CAMERA_VERSION: &str = "shared-world-v1";
const ROTATION_UNIT_TOLERANCE: f64 = 1e-6;
const ISOMETRIC_FORWARD_COMPONENT: f64 = 0.577_350_269_189_625_8;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct WorldCamera {
    pub(crate) kind: String,
    pub(crate) version: String,
    pub(crate) camera_id: String,
    pub(crate) settings_version: String,
    pub(crate) position: WorldCameraPoint,
    pub(crate) rotation: [f64; 4],
    pub(crate) projection: WorldCameraProjection,
    pub(crate) capture_mode: WorldCameraCaptureMode,
    pub(crate) aspect: WorldCameraAspect,
    pub(crate) bound_instance_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorldCameraPoint {
    pub(crate) u: f64,
    pub(crate) v: f64,
    pub(crate) h: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum WorldCameraProjection {
    Isometric {
        #[serde(rename = "verticalSizeMeters")]
        vertical_size_meters: f64,
        #[serde(rename = "nearMeters")]
        near_meters: f64,
        #[serde(rename = "farMeters")]
        far_meters: f64,
    },
    Perspective {
        #[serde(rename = "verticalFovRadians")]
        vertical_fov_radians: f64,
        #[serde(rename = "nearMeters")]
        near_meters: f64,
        #[serde(rename = "farMeters")]
        far_meters: f64,
    },
}

impl WorldCameraProjection {
    pub(crate) fn near(&self) -> f64 {
        match self {
            Self::Isometric { near_meters, .. } | Self::Perspective { near_meters, .. } => {
                *near_meters
            }
        }
    }

    pub(crate) fn far(&self) -> f64 {
        match self {
            Self::Isometric { far_meters, .. } | Self::Perspective { far_meters, .. } => {
                *far_meters
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum WorldCameraCaptureMode {
    Static,
    Dynamic,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorldCameraAspect {
    pub(crate) width: f64,
    pub(crate) height: f64,
}

impl WorldCamera {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.kind != "world-camera"
            || self.version != WORLD_CAMERA_VERSION
            || self.camera_id.trim().is_empty()
            || self.settings_version.trim().is_empty()
        {
            return Err("Invalid world camera identity");
        }
        let p = &self.position;
        if ![p.u, p.v, p.h].iter().all(|v| v.is_finite()) {
            return Err("Invalid world camera position");
        }
        if !self.rotation.iter().all(|v| v.is_finite()) {
            return Err("Invalid world camera rotation");
        }
        let norm: f64 = self.rotation.iter().map(|v| v * v).sum();
        if (norm - 1.0).abs() > ROTATION_UNIT_TOLERANCE {
            return Err("Invalid world camera rotation");
        }
        let near = self.projection.near();
        let far = self.projection.far();
        if !near.is_finite() || !far.is_finite() || !(near > 0.0 && far > near) {
            return Err("Invalid world camera projection range");
        }
        match &self.projection {
            WorldCameraProjection::Isometric {
                vertical_size_meters,
                ..
            } => {
                if !vertical_size_meters.is_finite() || *vertical_size_meters <= 0.0 {
                    return Err("Invalid world camera isometric size");
                }
                // Canonical equal-axis poses and grid-aligned downward poses are both
                // valid orthographic isometric views.
                let [x, y, z, w] = self.rotation;
                let forward = rotate([x, z, -y, w], [0.0, 0.0, -1.0]);
                let canonical = forward.iter().all(|value| {
                    (value.abs() - ISOMETRIC_FORWARD_COMPONENT).abs() <= ROTATION_UNIT_TOLERANCE
                });
                let horizontal = (forward[0] * forward[0] + forward[2] * forward[2]).sqrt();
                let grid_aligned = horizontal > ROTATION_UNIT_TOLERANCE
                    && forward[1] < 0.0
                    && (forward[0].abs() <= ROTATION_UNIT_TOLERANCE
                        || forward[2].abs() <= ROTATION_UNIT_TOLERANCE);
                if !canonical && !grid_aligned {
                    return Err("Invalid world camera isometric pose");
                }
            }
            WorldCameraProjection::Perspective {
                vertical_fov_radians,
                ..
            } => {
                if !vertical_fov_radians.is_finite()
                    || *vertical_fov_radians <= 0.0
                    || *vertical_fov_radians >= std::f64::consts::PI
                {
                    return Err("Invalid world camera field of view");
                }
            }
        }
        let aspect = &self.aspect;
        if ![aspect.width, aspect.height]
            .iter()
            .all(|v| v.is_finite() && *v > 0.0)
        {
            return Err("Invalid world camera aspect");
        }
        if self
            .bound_instance_id
            .as_ref()
            .is_some_and(|id| id.trim().is_empty())
        {
            return Err("Invalid world camera binding");
        }
        Ok(())
    }
}

pub(crate) fn deserialize_camera<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<WorldCamera>, D::Error> {
    WorldCamera::deserialize(d).map(Some)
}

fn rotate(q: [f64; 4], v: [f64; 3]) -> [f64; 3] {
    let [x, y, z, w] = q;
    let tx = 2.0 * (y * v[2] - z * v[1]);
    let ty = 2.0 * (z * v[0] - x * v[2]);
    let tz = 2.0 * (x * v[1] - y * v[0]);
    [
        v[0] + w * tx + (y * tz - z * ty),
        v[1] + w * ty + (z * tx - x * tz),
        v[2] + w * tz + (x * ty - y * tx),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn camera(value: serde_json::Value) -> WorldCamera {
        serde_json::from_value(value).unwrap()
    }

    fn default_value() -> serde_json::Value {
        serde_json::json!({
            "kind": "world-camera",
            "version": "shared-world-v1",
            "cameraId": "camera-1",
            "settingsVersion": "v1",
            "position": { "u": 0.0, "v": 0.0, "h": 1.5 },
            "rotation": [
                -0.27984814233312133,
                -0.11591689595929515,
                0.3647051996310009,
                0.8804762392171493
            ],
            "projection": {
                "kind": "isometric",
                "verticalSizeMeters": 8.0,
                "nearMeters": 0.1,
                "farMeters": 500.0
            },
            "captureMode": { "kind": "static" },
            "aspect": { "width": 16.0, "height": 9.0 },
            "boundInstanceId": null
        })
    }

    #[test]
    fn accepts_canonical_isometric_camera() {
        camera(default_value()).validate().unwrap();
    }

    #[test]
    fn accepts_grid_aligned_isometric_pose() {
        let mut value = default_value();
        value["rotation"] = serde_json::json!([0.0, -0.229752920547361, 0.97324898946773, 0.0]);
        camera(value).validate().unwrap();
    }

    #[test]
    fn rejects_non_isometric_pose() {
        let mut value = default_value();
        value["rotation"] = serde_json::json!([0.0, 0.0, 0.0, 1.0]);
        assert_eq!(
            camera(value).validate(),
            Err("Invalid world camera isometric pose")
        );
    }

    #[test]
    fn rejects_unknown_fields_and_bad_ranges() {
        let mut value = default_value();
        value["gpuHandle"] = serde_json::json!(1);
        assert!(serde_json::from_value::<WorldCamera>(value).is_err());

        let mut value = default_value();
        value["projection"] = serde_json::json!({
            "kind": "perspective",
            "verticalFovRadians": 1.0,
            "nearMeters": 2.0,
            "farMeters": 1.0
        });
        assert_eq!(
            camera(value).validate(),
            Err("Invalid world camera projection range")
        );
    }
}
