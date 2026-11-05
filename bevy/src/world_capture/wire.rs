//! 世界镜头捕获边界 JSON 与结果帧编码。
//!
//! 请求只携带镜头身份、输出尺寸与稳定 identity；世界内容由页面 `CurrentScene` 提供。
//! 结果帧布局与截图/缩略图一致：`[u32 LE width][u32 LE height][u32 LE status][payload...]`，
//! `status == 0` 成功（RGBA），`status == 1` 失败（UTF-8 失败码）。

use super::*;

/// 输出边长下界：再小也看不出取景。
const MIN_EDGE: u32 = 32;
/// 单次请求载荷上限（只有 identity 与尺寸）。
const MAX_REQUEST_BYTES: usize = 16 * 1024;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestJson {
    request_id: f64,
    generation: f64,
    camera_id: String,
    width: u32,
    height: u32,
}

/// 校验并排队一次世界镜头捕获；非法输入在边界拒绝，不覆盖已排队请求。
pub(crate) fn request(json: &str) -> Result<(), crate::BoundaryError> {
    if json.len() > MAX_REQUEST_BYTES {
        return Err(crate::BoundaryError::from_str(
            "World capture payload too large",
        ));
    }
    let parsed: RequestJson = serde_json::from_str(json)
        .map_err(|error| crate::BoundaryError::from_str(&error.to_string()))?;
    if parsed.camera_id.trim().is_empty()
        || !parsed.request_id.is_finite()
        || parsed.request_id < 0.0
        || !parsed.generation.is_finite()
        || parsed.generation < 0.0
    {
        return Err(crate::BoundaryError::from_str(
            "Invalid world capture request",
        ));
    }
    bridge::queue_world_capture_request(WorldCaptureRequest {
        request_id: parsed.request_id as u64,
        generation: parsed.generation as u64,
        camera_id: parsed.camera_id,
        width: parsed.width.clamp(MIN_EDGE, MAX_EDGE),
        height: parsed.height.clamp(MIN_EDGE, MAX_EDGE),
    });
    Ok(())
}

/// 取匹配 `(requestId, generation)` 的结果帧；尚未完成返回空数组。
pub(crate) fn poll(request_id: f64, generation: f64) -> Vec<u8> {
    if !request_id.is_finite() || request_id < 0.0 || !generation.is_finite() || generation < 0.0 {
        return Vec::new();
    }
    let Some(result) = bridge::take_world_capture_result(request_id as u64, generation as u64) else {
        return Vec::new();
    };
    match result.outcome {
        WorldCaptureOutcome::Ok {
            rgba,
            width,
            height,
        } => {
            let mut frame = Vec::with_capacity(12 + rgba.len());
            frame.extend_from_slice(&width.to_le_bytes());
            frame.extend_from_slice(&height.to_le_bytes());
            frame.extend_from_slice(&0u32.to_le_bytes());
            frame.extend_from_slice(&rgba);
            frame
        }
        WorldCaptureOutcome::Failed { code } => {
            let mut frame = Vec::with_capacity(12 + code.len());
            frame.extend_from_slice(&0u32.to_le_bytes());
            frame.extend_from_slice(&0u32.to_le_bytes());
            frame.extend_from_slice(&1u32.to_le_bytes());
            frame.extend_from_slice(code.as_bytes());
            frame
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request_json(camera_id: &str) -> String {
        format!(
            r#"{{"requestId":7,"generation":3,"cameraId":"{camera_id}","width":512,"height":512}}"#
        )
    }

    #[test]
    fn rejects_empty_camera_id() {
        assert!(request(&request_json("")).is_err());
    }

    #[test]
    fn queues_a_valid_request() {
        assert!(request(&request_json("camera-1")).is_ok());
        let queued = bridge::take_world_capture_request().expect("queued");
        assert_eq!(queued.camera_id, "camera-1");
        assert_eq!(queued.width, 512);
        assert_eq!(queued.height, 512);
    }

    #[test]
    fn failure_frame_carries_code() {
        bridge::set_world_capture_result(WorldCaptureResult {
            request_id: 9,
            generation: 2,
            outcome: WorldCaptureOutcome::Failed {
                code: "capture-busy".to_owned(),
            },
        });
        let frame = poll(9.0, 2.0);
        assert!(frame.len() >= 12);
        let status = u32::from_le_bytes(frame[8..12].try_into().expect("status"));
        assert_eq!(status, 1);
        assert_eq!(&frame[12..], b"capture-busy");
        assert!(poll(9.0, 2.0).is_empty(), "结果取出后不得重复发布");
    }
}
