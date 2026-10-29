//! Shot capture JSON and result-buffer encoding behind the shared canvas facade.
use crate::BoundaryError;
use crate::bridge;

pub(crate) fn request(json: &str) -> Result<(), BoundaryError> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ShotCaptureRequestJson {
        request_id: f64,
        node_id: String,
        generation: f64,
        #[serde(default)]
        width: Option<u32>,
        #[serde(default)]
        height: Option<u32>,
        /// 请求来源标签（诊断用；缺省为空串）。
        #[serde(default)]
        source: String,
    }
    let parsed: ShotCaptureRequestJson =
        serde_json::from_str(json).map_err(|err| BoundaryError::from_str(&err.to_string()))?;
    if parsed.node_id.is_empty()
        || !parsed.request_id.is_finite()
        || parsed.request_id < 0.0
        || !parsed.generation.is_finite()
        || parsed.generation < 0.0
    {
        return Err(BoundaryError::from_str("Invalid shot capture request"));
    }
    bridge::queue_shot_capture(bridge::ShotCaptureBridgeRequest {
        request_id: parsed.request_id as u64,
        // rig_generation 由路由系统按当前 rig 派生代数填写。
        rig_generation: 0,
        bridge_generation: parsed.generation as u64,
        node_id: parsed.node_id,
        source: parsed.source,
        width: parsed
            .width
            .unwrap_or(crate::model3d::capture::CAPTURE_WIDTH),
        height: parsed
            .height
            .unwrap_or(crate::model3d::capture::CAPTURE_HEIGHT),
    });
    Ok(())
}

pub(crate) fn poll(request_id: f64, generation: f64) -> Vec<u8> {
    use bridge::ShotCaptureBridgeOutcome;
    let request_id = request_id as u64;
    let generation = generation as u64;
    match bridge::take_shot_capture_result(request_id, generation) {
        Some(result) => match result.outcome {
            ShotCaptureBridgeOutcome::Ok {
                rgba,
                width,
                height,
            } => {
                let mut out = Vec::with_capacity(12 + rgba.len());
                out.extend_from_slice(&width.to_le_bytes());
                out.extend_from_slice(&height.to_le_bytes());
                out.extend_from_slice(&0u32.to_le_bytes());
                out.extend_from_slice(&rgba);
                out
            }
            ShotCaptureBridgeOutcome::Failed { code } => {
                let mut out = Vec::with_capacity(12 + code.len());
                out.extend_from_slice(&0u32.to_le_bytes());
                out.extend_from_slice(&0u32.to_le_bytes());
                out.extend_from_slice(&1u32.to_le_bytes());
                out.extend_from_slice(code.as_bytes());
                out
            }
        },
        None => Vec::new(),
    }
}
