//! 帧交付的回归：真实多帧渲染、GIF 编码、预算与取消边界。
use super::*;
use photocraft_engine::Session;
use serde_json::json;

/// 建一份 8×8 文档并建立一个 3 帧的空白视频层，逐帧涂上不同颜色。
fn three_frame_session() -> Session {
    let mut session = Session::new();
    session.execute("file.new", json!({"width":8,"height":8})).unwrap();
    session.execute("timeline.create", json!({"duration":3,"fps":10.0})).unwrap();
    session.execute("layer.videoLayers.newBlankVideoLayer", json!({})).unwrap();
    for (frame, color) in [(0, "#ff0000"), (1, "#00ff00"), (2, "#0000ff")] {
        session.execute("timeline.setFrame", json!({"frame":frame})).unwrap();
        session
            .execute("paint.stroke", json!({
                "points": [[1, 1], [6, 6]],
                "size": 8,
                "hardness": 1,
                "opacity": 1,
                "flow": 1,
                "color": color,
                "target": "pixels"
            }))
            .unwrap();
    }
    session
}

fn document(session: &Session) -> &Document {
    &session.active().unwrap().doc
}

#[test]
fn delivery_plans_the_timeline_length_not_a_single_frame() {
    let session = three_frame_session();
    let report = plan_delivery(document(&session)).unwrap();
    assert_eq!(report.frames, 3);
    assert_eq!((report.width, report.height), (8, 8));
    assert_eq!(report.frame_bytes, 8 * 8 * 4);
    assert_eq!(report.fps_millis, 100);
}

#[test]
fn each_delivered_frame_keeps_its_own_pixels() {
    let session = three_frame_session();
    let doc = document(&session);
    let frames: Vec<Vec<u8>> = (0..3).map(|frame| render_frame_rgba(doc, frame).unwrap()).collect();
    for (index, rgba) in frames.iter().enumerate() {
        assert_eq!(rgba.len(), 8 * 8 * 4);
        // 每帧的主色不同：不能只取首帧冒充动画。
        let center = (4 * 8 + 4) * 4;
        let expected = [[255u8, 0, 0], [0, 255, 0], [0, 0, 255]][index];
        assert_eq!(&rgba[center..center + 3], &expected, "第 {index} 帧像素不符");
    }
    assert_ne!(frames[0], frames[1]);
    assert_ne!(frames[1], frames[2]);
}

#[test]
fn delivery_freezes_a_snapshot_and_leaves_the_document_untouched() {
    let session = three_frame_session();
    let before = document(&session).clone();
    let _ = render_frame_rgba(&before, 2).unwrap();
    assert_eq!(document(&session).timeline.as_ref().unwrap().current, 2);
    // 渲染把播放头放在快照副本上，不移动原文档。
    assert_eq!(before.timeline.as_ref().unwrap().current, 2);
    let _ = render_frame_rgba(&before, 0).unwrap();
    assert_eq!(before.timeline.as_ref().unwrap().current, 2);
}

#[test]
fn an_animated_gif_encodes_every_frame() {
    let session = three_frame_session();
    let doc = document(&session);
    let report = plan_delivery(doc).unwrap();
    let delay = gif_delay_cs(report.fps_millis);
    let frames: Vec<IndexedFrame> = (0..report.frames)
        .map(|frame| index_frame(&render_frame_rgba(doc, frame).unwrap(), report.width, report.height, delay).unwrap())
        .collect();
    let bytes = encode_gif(report.width, report.height, &frames, true).unwrap();
    assert_eq!(&bytes[..6], b"GIF89a");
    assert_eq!(*bytes.last().unwrap(), 0x3B);
    // 解码回来必须仍是三帧，且帧像素各不相同（真实动画，不是单帧）。
    let decoded = photocraft_codecs::decode_gif_frames(&bytes, &photocraft_codecs::DecodeOptions::default()).unwrap();
    assert_eq!(decoded.len(), 3);
    assert_eq!(decoded[0].delay_ms, 100);
    let pixels: Vec<Vec<u8>> = decoded.iter().map(|frame| frame.image.data().to_vec()).collect();
    assert_ne!(pixels[0], pixels[1]);
    assert_ne!(pixels[1], pixels[2]);
}

#[test]
fn a_transparent_frame_keeps_transparency() {
    // 全透明 RGBA → 透明索引；`file.new` 的背景层是不透明白，因此这里直接测编码输入。
    let rgba = vec![0u8; 4 * 4 * 4];
    let frame = index_frame(&rgba, 4, 4, 10).unwrap();
    assert!(frame.transparent.is_some(), "全透明帧需要透明索引");
    let bytes = encode_gif(4, 4, &[frame], false).unwrap();
    assert_eq!(&bytes[..6], b"GIF89a");
    let decoded = photocraft_codecs::decode_gif_frames(&bytes, &photocraft_codecs::DecodeOptions::default()).unwrap();
    assert_eq!(decoded.len(), 1);
    assert!(decoded[0].image.data().chunks_exact(4).all(|pixel| pixel[3] == 0));
}

#[test]
fn out_of_range_frames_and_empty_deliveries_are_rejected() {
    let session = three_frame_session();
    let doc = document(&session);
    let failure = render_frame_rgba(doc, 3).unwrap_err();
    assert_eq!(failure.code, "frame-out-of-range");
    let empty = encode_gif(4, 4, &[], true).unwrap_err();
    assert_eq!(empty.code, "empty-delivery");
    let mismatched = index_frame(&[0, 0, 0], 4, 4, 10).unwrap_err();
    assert_eq!(mismatched.code, "invalid-frame-bytes");
}

#[test]
fn a_timeline_longer_than_the_frame_budget_is_refused_before_rendering() {
    let mut session = Session::new();
    session.execute("file.new", json!({"width":4,"height":4})).unwrap();
    // 上游允许到 1,000,000 帧；本域在渲染前先按 120 帧预算拒绝。
    session.execute("timeline.create", json!({"duration":121,"fps":30.0})).unwrap();
    let doc = document(&session);
    let failure = plan_delivery(doc).unwrap_err();
    assert_eq!(failure.code, "frame-count-exceeded");
    assert!(failure.message.contains("121"));
}

#[test]
fn video_layer_reports_cover_the_nested_tree() {
    let session = three_frame_session();
    let reports = video_layer_frame_counts(document(&session));
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0]["frames"], 3);
    assert_eq!(reports[0]["hasOriginal"], false);
}

#[test]
fn a_document_without_a_timeline_delivers_one_frame() {
    let mut session = Session::new();
    session.execute("file.new", json!({"width":4,"height":4})).unwrap();
    let report = plan_delivery(document(&session)).unwrap();
    assert_eq!(report.frames, 1);
    assert_eq!(report.fps_millis, 33);
}
