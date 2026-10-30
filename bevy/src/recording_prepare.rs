//! 从冻结 IR 到渲染计划/探针的装配
//! （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 3.2 / 3.4）。
//!
//! worker 收到的快照里已经是**编译产物**（Scene IR JSON + motion JSON）；这里只做：
//! - 解析成渲染器认识的 typed 结构（拒绝未知版本/非法结构）；
//! - 组装 `RenderRequest` 的固定部分（场景、签名、extent、capture）；
//! - 探测真实 GPU 适配器，供宿主的能力协商与「软件渲染不算验收」判定使用。
//!
//! 不执行 JavaScript、不读任意路径、不做业务校验（那些在冻结阶段完成）。

use serde::Deserialize;

use crate::protocol::ModelOp;
use crate::recording_job::ProbeFailure;
use crate::recording_probe_gpu::RecordingRenderPlan;
use crate::renderer_protocol::{CaptureOptions, MotionRequest};

/// 渲染器接受的场景 schema。
pub const SCENE_SCHEMA: &str = "woohaa-model-scene-ir-v2";

/// `-1`/未知版本一律拒绝，不做「尽量兼容」。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SceneDocument {
    scene_version: String,
    #[serde(default)]
    signature: String,
    #[serde(default = "default_extent")]
    extent: f32,
    ops: Vec<ModelOp>,
    #[serde(default)]
    media_planes: Vec<crate::recording_probe_gpu::RecordingMediaPlane>,
    #[serde(default)]
    composite_asset_frame: Option<crate::renderer_protocol::CompositeAssetFrameRequest>,
}

fn default_extent() -> f32 {
    2.0
}

/// 解析冻结 IR 并组装渲染计划。
pub fn prepare_render_plan(
    scene_ir_json: &str,
    motion_json: &str,
    width: u32,
    height: u32,
    background: &str,
) -> Result<RecordingRenderPlan, ProbeFailure> {
    let scene: SceneDocument =
        serde_json::from_str(scene_ir_json).map_err(|error| ProbeFailure {
            stage: "RECORDING_ERROR_STAGE_COMPILE",
            code: "recording-scene-ir-invalid",
            message: error.to_string(),
        })?;
    if scene.scene_version != SCENE_SCHEMA {
        return Err(ProbeFailure {
            stage: "RECORDING_ERROR_STAGE_COMPILE",
            code: "recording-scene-ir-unsupported",
            message: format!("不支持的场景 schema：{}", scene.scene_version),
        });
    }
    if scene.ops.is_empty() && scene.media_planes.is_empty() {
        return Err(ProbeFailure {
            stage: "RECORDING_ERROR_STAGE_COMPILE",
            code: "recording-scene-ir-empty",
            message: "场景没有任何图元".into(),
        });
    }
    let motion: MotionRequest =
        serde_json::from_str(motion_json).map_err(|error| ProbeFailure {
            stage: "RECORDING_ERROR_STAGE_COMPILE",
            code: "recording-motion-invalid",
            message: error.to_string(),
        })?;
    Ok(RecordingRenderPlan {
        scene_version: scene.scene_version,
        signature: scene.signature,
        extent: scene.extent,
        ops: scene.ops,
        media_planes: scene.media_planes,
        composite_asset_frame: scene.composite_asset_frame,
        motion,
        capture: CaptureOptions {
            width,
            height,
            background: background.to_owned(),
            // 录制使用片场保存的初始镜头（不经 dimetric 预览预设）。
            camera_preset: "initial".to_owned(),
        },
        media_playback: Vec::new(),
        media_content_types: std::collections::BTreeMap::new(),
    })
}

/// 真实 GPU 适配器信息。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GpuAdapterInfo {
    pub name: String,
    pub backend: String,
    pub software: bool,
}

/// 探测渲染后端实际使用的适配器。
///
/// 通过启动一个最小离屏渲染并读取其日志实现——这与 worker 后续真正使用的路径一致，
/// 因此不会出现「探测说硬件、实际跑软件」的分叉。
pub fn detect_gpu_adapter() -> Option<GpuAdapterInfo> {
    let request = crate::renderer_protocol::RenderRequest::for_recording(
        "adapter-probe".into(),
        SCENE_SCHEMA.into(),
        "adapter-probe".into(),
        2.0,
        // 探测只需要一个合法的最小图元；空 ops 会被渲染器拒绝。
        vec![minimal_op()],
        CaptureOptions {
            width: 16,
            height: 16,
            background: "#000000".into(),
            camera_preset: "initial".into(),
        },
        MotionRequest::default_for_test(1.0),
    );
    let capture = CaptureOptions {
        width: 16,
        height: 16,
        background: "#000000".into(),
        camera_preset: "initial".into(),
    };
    // 探测失败（无适配器）返回 None；成功时不解析日志即可认为有可用设备。
    match crate::model3d::preview::render_rgba(&request, &capture) {
        Ok(pixels) if !pixels.is_empty() => crate::model3d::preview::render::detected_adapter(),
        _ => None,
    }
}

/// 探测用的最小合法图元（单个立方体）。
fn minimal_op() -> ModelOp {
    serde_json::from_value(serde_json::json!({
        "t": "box", "id": "probe", "size": [1.0, 1.0, 1.0], "color": "#ffffff"
    }))
    .expect("minimal probe op")
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD_SCENE: &str = r##"{
      "sceneVersion": "woohaa-model-scene-ir-v2",
      "signature": "sig",
      "extent": 4.0,
      "ops": [
        { "t": "material", "id": "m", "color": "#cc4455" },
        { "t": "box", "id": "body", "size": [1,1,1], "material": "m" }
      ]
    }"##;

    const GOOD_MOTION: &str = r#"{
      "duration": 2.0, "looped": false, "cameraMotion": [], "modelMotion": [],
      "objects": [],
      "initialCamera": {"azimuth":0.5,"elevation":0.5,"distance":4,"focusOffset":[0,0,0],"aspect":"16:9"},
      "timeSeconds": 0
    }"#;

    #[test]
    fn parses_frozen_ir_into_a_plan() {
        let plan = prepare_render_plan(GOOD_SCENE, GOOD_MOTION, 320, 180, "#101418").expect("plan");
        assert_eq!(plan.scene_version, SCENE_SCHEMA);
        assert_eq!(plan.ops.len(), 2);
        assert_eq!(plan.capture.width, 320);
        assert_eq!(plan.capture.height, 180);
        assert_eq!(plan.capture.camera_preset, "initial");
        assert_eq!(plan.motion.duration, 2.0);
    }

    #[test]
    fn rejects_unknown_schema_and_empty_scene() {
        let bad_schema = GOOD_SCENE.replace("woohaa-model-scene-ir-v2", "woohaa-model-scene-ir-v1");
        let error =
            prepare_render_plan(&bad_schema, GOOD_MOTION, 320, 180, "#000").expect_err("schema");
        assert_eq!(error.code, "recording-scene-ir-unsupported");

        let empty = GOOD_SCENE.replace(
            r##"{ "t": "material", "id": "m", "color": "#cc4455" },
        { "t": "box", "id": "body", "size": [1,1,1], "material": "m" }"##,
            "",
        );
        let error = prepare_render_plan(&empty, GOOD_MOTION, 320, 180, "#000").expect_err("empty");
        assert_eq!(error.code, "recording-scene-ir-empty");
    }

    #[test]
    fn rejects_malformed_json_with_stable_codes() {
        let error = prepare_render_plan("{", GOOD_MOTION, 320, 180, "#000").expect_err("bad scene");
        assert_eq!(error.code, "recording-scene-ir-invalid");
        assert_eq!(error.stage, "RECORDING_ERROR_STAGE_COMPILE");

        let error = prepare_render_plan(GOOD_SCENE, "{", 320, 180, "#000").expect_err("bad motion");
        assert_eq!(error.code, "recording-motion-invalid");
    }

    #[test]
    fn does_not_execute_scripts_or_read_paths() {
        // 冻结 IR 里即使带脚本字段也只当作未知字段忽略，不执行。
        let with_script = GOOD_SCENE.replace(
            r#""signature": "sig","#,
            r#""signature": "sig", "modelScript": "scene.box({});", "source": "/etc/passwd","#,
        );
        let plan = prepare_render_plan(&with_script, GOOD_MOTION, 320, 180, "#000").expect("plan");
        assert_eq!(plan.ops.len(), 2);
    }
}
