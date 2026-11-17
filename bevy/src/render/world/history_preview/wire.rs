//! 历史缩略图边界 JSON 与结果帧编码
//! （change: 2026-10-26-move-generation-history-to-ai-center，D6）。
//!
//! 请求只携带服务端权威脚本派生出的 V2 Scene IR 与稳定 identity；结果帧布局与截图通道一致：
//! `[u32 LE width][u32 LE height][u32 LE status][payload...]`，
//! `status == 0` 成功（RGBA），`status == 1` 失败（UTF-8 失败码）。

use std::sync::Arc;

use super::*;

/// 输出边长下界：再小也看不出模型轮廓。
const MIN_EDGE: u32 = 32;
/// 输出边长上界：历史卡片不需要更大，超过就浪费回读带宽。
const MAX_EDGE: u32 = 1024;
/// 单次请求载荷上限（Scene IR + identity）。
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestJson {
    request_id: f64,
    generation: f64,
    scene_version: String,
    ops: Vec<crate::protocol::ModelOp>,
    width: u32,
    height: u32,
}

/// 校验并排队一次缩略图作业；非法输入在边界拒绝，不覆盖已排队请求。
pub(crate) fn request(json: &str) -> Result<(), crate::BoundaryError> {
    if json.len() > MAX_REQUEST_BYTES {
        return Err(crate::BoundaryError::from_str(
            "History thumbnail payload too large",
        ));
    }
    let parsed: RequestJson = serde_json::from_str(json)
        .map_err(|error| crate::BoundaryError::from_str(&error.to_string()))?;
    if !parsed.request_id.is_finite()
        || parsed.request_id < 0.0
        || !parsed.generation.is_finite()
        || parsed.generation < 0.0
    {
        return Err(crate::BoundaryError::from_str(
            "Invalid history thumbnail request",
        ));
    }
    if parsed.scene_version != crate::protocol::MODEL_SCENE_IR_V2 {
        return Err(crate::BoundaryError::from_str(
            "Unsupported model scene version",
        ));
    }
    if parsed.ops.is_empty() {
        return Err(crate::BoundaryError::from_str("Empty model scene"));
    }
    let snapshot = crate::protocol::ModelSnapshot::new(
        Some(parsed.scene_version),
        parsed.ops,
        String::new(),
        1.0,
        Default::default(),
    );
    let snapshot = model3d::prepare_snapshot(snapshot);
    bridge::queue_history_thumbnail_request(HistoryThumbnailRequest {
        request_id: parsed.request_id as u64,
        generation: parsed.generation as u64,
        snapshot: Arc::new(snapshot),
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
    let Some(result) = bridge::take_history_thumbnail_result(request_id as u64, generation as u64)
    else {
        return Vec::new();
    };
    match result.outcome {
        HistoryThumbnailOutcome::Ok {
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
        HistoryThumbnailOutcome::Failed { code } => {
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

    fn request_json(ops: &str) -> String {
        format!(
            r#"{{"requestId":7,"generation":3,"sceneVersion":"{}","ops":{},"width":256,"height":256}}"#,
            crate::protocol::MODEL_SCENE_IR_V2,
            ops
        )
    }

    #[test]
    fn rejects_empty_scene() {
        assert!(request(&request_json("[]")).is_err());
    }

    #[test]
    fn rejects_unknown_scene_version() {
        let json = request_json(r##"[{"op":"material","id":"a","color":"#ffffff"}]"##).replace(
            crate::protocol::MODEL_SCENE_IR_V2,
            "woohaa-model-scene-ir-v1",
        );
        assert!(request(&json).is_err());
    }

    #[test]
    fn failure_frame_carries_code() {
        bridge::set_history_thumbnail_result(HistoryThumbnailResult {
            request_id: 9,
            generation: 2,
            outcome: HistoryThumbnailOutcome::Failed {
                code: "thumbnail-busy".to_owned(),
            },
        });
        let frame = poll(9.0, 2.0);
        assert!(frame.len() >= 12);
        let status = u32::from_le_bytes(frame[8..12].try_into().expect("status"));
        assert_eq!(status, 1);
        assert_eq!(&frame[12..], b"thumbnail-busy");
        assert!(poll(9.0, 2.0).is_empty(), "结果取出后不得重复发布");
    }

    #[test]
    fn late_result_is_not_taken_by_another_identity() {
        bridge::set_history_thumbnail_result(HistoryThumbnailResult {
            request_id: 4,
            generation: 1,
            outcome: HistoryThumbnailOutcome::Failed {
                code: "thumbnail-empty-image".to_owned(),
            },
        });
        assert!(poll(5.0, 1.0).is_empty());
        assert!(!poll(4.0, 1.0).is_empty());
    }
}
