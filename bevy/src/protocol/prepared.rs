//! prepared-and-register 边界 DTO（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，design D6）。
//!
//! Frontend 把已执行、已规范化的 Scene IR 一次性交给 Rust；Rust 在同一次调用中派生兼容
//! signature/AABB/extent、注册资源并返回轻量 metadata。

use serde::Deserialize;

use super::canonical_signature;
use super::model::{MODEL_ASSET_VERSION, ModelAabbDto, ModelOp};

/// Geometry is transmitted once. Keep its raw JSON bytes for the canonical signature,
/// and decode those same bytes for model preparation.
#[derive(Clone, Deserialize)]
#[serde(try_from = "PreparedModelWire")]
pub(crate) struct PreparedModelRequest {
    pub(crate) resource_version: String,
    pub(crate) scene_version: String,
    pub(crate) ops_json: String,
    pub(crate) ops: Vec<ModelOp>,
    pub(crate) expected_signature: Option<String>,
    pub(crate) expected_extent: Option<f32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreparedModelWire {
    #[serde(default)]
    resource_version: String,
    scene_version: String,
    ops: Box<serde_json::value::RawValue>,
    #[serde(default)]
    expected_signature: Option<String>,
    #[serde(default)]
    expected_extent: Option<f32>,
}

impl TryFrom<PreparedModelWire> for PreparedModelRequest {
    type Error = serde_json::Error;

    fn try_from(wire: PreparedModelWire) -> Result<Self, Self::Error> {
        let ops_json = wire.ops.get().to_owned();
        let ops = serde_json::from_str(&ops_json)?;
        Ok(Self {
            resource_version: wire.resource_version,
            scene_version: wire.scene_version,
            ops_json,
            ops,
            expected_signature: wire.expected_signature,
            expected_extent: wire.expected_extent,
        })
    }
}

/// Rust 派生并返回的轻量 metadata。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedModelMetadata {
    pub(crate) resource_version: String,
    pub(crate) resource_key: String,
    pub(crate) scene_version: String,
    pub(crate) signature: String,
    pub(crate) extent: f32,
    pub(crate) aabb: Option<ModelAabbDto>,
}

impl PreparedModelRequest {
    /// 边界级防御校验：版本、场景版本（V2-only）与至少一个 op。
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.resource_version != MODEL_ASSET_VERSION {
            return Err("Unknown model resource version");
        }
        // change: 2026-10-07-remove-residual-compatibility —— 只接受 V2 Scene IR。
        if !super::model::is_supported_scene_ir_version(&self.scene_version) {
            return Err("Unsupported model scene version");
        }
        if self.ops.is_empty() {
            return Err("Empty model resource ops");
        }
        Ok(())
    }

    /// Hash exactly the geometry bytes received from the authoring runtime.
    pub(crate) fn signature(&self) -> String {
        canonical_signature(&self.scene_version, &self.ops_json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_geometry_bytes_for_signature_without_duplicate_payload() {
        let ops = r##"[{"t":"sphere","id":"球","parent":null,"position":[0.123456789012345,0,0],"rotation":[0,0,0],"scale":[1,1,1],"color":"#ffffff","radius":1e-7}]"##;
        let json = format!(
            r#"{{"resourceVersion":"woohaa-prepared-model-resource-v1","sceneVersion":"woohaa-model-scene-ir-v2","ops":{ops}}}"#
        );
        let request: PreparedModelRequest = serde_json::from_str(&json).unwrap();
        assert!(request.validate().is_ok());
        assert_eq!(request.ops.len(), 1);
        assert_eq!(request.ops_json, ops);
        assert_eq!(
            request.signature(),
            canonical_signature("woohaa-model-scene-ir-v2", ops)
        );
    }

    #[test]
    fn malformed_geometry_is_rejected() {
        let json = r#"{"sceneVersion":"woohaa-model-scene-ir-v2","ops":[{"t":"unknown"}]}"#;
        assert!(serde_json::from_str::<PreparedModelRequest>(json).is_err());
    }
}
