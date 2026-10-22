//! 拍摄镜头预览卡片共享纯几何
//! （change: 2026-10-15-add-film-set-shooting-shot-previews，design D8）。
//!
//! 预览卡片的标题区/内容区与归属线接口是**绘制与命中共用**的同一份事实源：卡片绘制
//! （`canvas2d`）、GPU 预览 Sprite 摆放、命中查询与归属线终点都调用这里的纯函数，避免各处
//! 各算一次。常量与 contracts 的 `film-set-shot-preview.ts` 保持一致（宽度、标题区高度、
//! 内容区上下限、竖排间距），改一处必须同步双端。
//!
//! 本模块只做几何：不读 GPU、不写文档、不含 ECS 状态。

use bevy::prelude::*;

use crate::protocol::GraphNode;
/// 卡片宽度（画布单位）；与 contracts `SHOT_PREVIEW_CARD_WIDTH` 一致。
pub(crate) const SHOT_PREVIEW_CARD_WIDTH: f32 = 240.0;
/// 卡片标题区高度（画布单位）；与 contracts `SHOT_PREVIEW_HEADER_HEIGHT` 一致。
pub(crate) const SHOT_PREVIEW_HEADER_HEIGHT: f32 = 52.0;
/// 内容区最小高度（极端竖画幅兜底）。
pub(crate) const SHOT_PREVIEW_CONTENT_MIN_HEIGHT: f32 = 48.0;
/// 内容区最大高度（极端横画幅兜底）。
pub(crate) const SHOT_PREVIEW_CONTENT_MAX_HEIGHT: f32 = 320.0;

/// 是否为拍摄镜头预览节点（由呈现声明判定，不按 id 形态猜测）。
pub(crate) fn is_shot_preview_node(node: &GraphNode) -> bool {
    node.shot_preview.is_some()
}

/// 源镜头画幅（宽/高）；非法值回退 16:9，与本模块其余派生一致。
pub(crate) fn shot_preview_aspect(node: &GraphNode) -> f32 {
    node.shot_preview
        .as_ref()
        .map(|preview| preview.aspect)
        .filter(|aspect| aspect.is_finite() && *aspect > 0.0)
        .unwrap_or(16.0 / 9.0)
}

/// 由画幅（宽/高）派生内容区高度；带可辨识上下限，非法画幅回退 16:9。
pub(crate) fn content_height(aspect: f32) -> f32 {
    let safe = if aspect.is_finite() && aspect > 0.0 {
        aspect
    } else {
        16.0 / 9.0
    };
    ((SHOT_PREVIEW_CARD_WIDTH - 32.0) / safe).clamp(SHOT_PREVIEW_CONTENT_MIN_HEIGHT, SHOT_PREVIEW_CONTENT_MAX_HEIGHT)
}

/// 默认整体尺寸：内容高度 + 标题区 + 底部 16。
pub(crate) fn default_card_size(aspect: f32) -> Vec2 {
    Vec2::new(SHOT_PREVIEW_CARD_WIDTH, content_height(aspect) + SHOT_PREVIEW_HEADER_HEIGHT + 16.0)
}

/// 与图片、视频节点共用内容框：顶部 52，左右和底部各 16。
pub(crate) fn content_rect(x: f32, y: f32, width: f32, height: f32) -> (f32, f32, f32, f32) {
    super::layout::content_rect_for_bounds(x, y, width, height)
}

/// 节点内容区矩形（复用节点标准字段）。
pub(crate) fn content_rect_of(node: &GraphNode) -> (f32, f32, f32, f32) {
    content_rect(node.x, node.y, node.width, node.height)
}

/// 内容区中心（GPU 预览 Sprite 的锚点）。
pub(crate) fn content_center(node: &GraphNode) -> Vec2 {
    let (x, y, width, height) = content_rect_of(node);
    Vec2::new(x + width / 2.0, y + height / 2.0)
}

/// 内容区内的**完整 aspect** 图像尺寸（contain，不拉伸、不裁剪）。
pub(crate) fn texture_size(node: &GraphNode, texture: Vec2) -> Vec2 {
    let (_, _, box_width, box_height) = content_rect_of(node);
    let texture = if texture.x.is_finite() && texture.y.is_finite() && texture.x > 0.0 && texture.y > 0.0 {
        texture
    } else {
        Vec2::new(SHOT_PREVIEW_CARD_WIDTH, content_height(shot_preview_aspect(node)))
    };
    let scale = (box_width / texture.x).min(box_height / texture.y);
    Vec2::new((texture.x * scale).max(1.0), (texture.y * scale).max(1.0))
}

/// 归属线终点：卡片接口几何（左侧中点，画布坐标）。
///
/// 与 contracts `shotPreviewCardAttachment` 同一公式；归属线绘制与命中共用，不各自推导。
/// `width` 参与以保持双端同签名（左中点不依赖宽度，但调用方复用同一节点几何）。
pub(crate) fn card_attachment(x: f32, y: f32, _width: f32, height: f32) -> Vec2 {
    Vec2::new(x, y + height / 2.0)
}

/// 节点归属线终点。
pub(crate) fn card_attachment_of(node: &GraphNode) -> Vec2 {
    card_attachment(node.x, node.y, node.width, node.height)
}

/// 卡片是否在可视窗口内（与 `model_preview` 同一公式，但用卡片整矩形）。
///
/// 缺失/非法 surface 时保守返回 true（未知视口不为「屏外」）。
pub(crate) fn visible_on_surface(node: &GraphNode, viewport: [f32; 3], surface: Vec2) -> bool {
    if !surface.x.is_finite() || !surface.y.is_finite() || surface.x <= 0.0 || surface.y <= 0.0 {
        return true;
    }
    let [vx, vy, zoom] = viewport;
    if !vx.is_finite() || !vy.is_finite() || !zoom.is_finite() {
        return true;
    }
    node.x * zoom + vx < surface.x
        && (node.x + node.width) * zoom + vx > 0.0
        && node.y * zoom + vy < surface.y
        && (node.y + node.height) * zoom + vy > 0.0
}

/// 当前是否处于任何聚焦隔离（模型/图片/视频/模型编辑）。
///
/// 与 `model_preview` 同一门禁：聚焦时卡片预览、相机标记与归属线一并隐藏，不参与聚焦画面。
/// 只在总览绘制总览级派生呈现。
pub(crate) fn focuses_isolate(scene: &crate::protocol::Scene) -> bool {
    scene.model_focus.is_some()
        || scene.image_focus.is_some()
        || scene.video_focus.is_some()
        || scene.model_editor.is_some()
}

/// 卡片是否应因聚焦隔离而隐藏（与 [`focuses_isolate`] 同一事实源）。
pub(crate) fn card_is_hidden(scene: &crate::protocol::Scene, _owner_node_id: &str) -> bool {
    focuses_isolate(scene)
}

/// 卡片状态标签（供卡片正文与诊断复用）；`ready` 不显示任何文案。
pub(crate) fn status_label(state: &str) -> Option<&'static str> {
    match state {
        "preparing" => Some("预览准备中"),
        "stale" => Some("待更新"),
        "error" => Some("预览失败"),
        _ => None,
    }
}

/// 卡片正文：优先诊断文案，其次状态标签；`ready` 返回空串（沿用普通卡片正文行为）。
pub(crate) fn status_text(node: &GraphNode, shorten: &dyn Fn(&str, f32, f32) -> String) -> String {
    let Some(preview) = node.shot_preview.as_ref() else {
        return String::new();
    };
    let raw = preview
        .diagnostic
        .as_deref()
        .filter(|text| !text.trim().is_empty())
        .or_else(|| status_label(&preview.state))
        .unwrap_or("");
    if raw.is_empty() {
        String::new()
    } else {
        shorten(raw, (node.width - 48.0).max(24.0), 12.0)
    }
}

/// 动态卡片是否显示播放标记（仅动态且正在播放时）。
pub(crate) fn shows_playback_badge(node: &GraphNode) -> bool {
    node.shot_preview
        .as_ref()
        .is_some_and(|preview| preview.kind == "dynamic" && preview.playing == Some(true))
}

/// 动态卡片本地播放进度（0..1）；静态或缺失返回 `None`。
pub(crate) fn playback_progress(node: &GraphNode) -> Option<f32> {
    node.shot_preview
        .as_ref()
        .filter(|preview| preview.kind == "dynamic")
        .and_then(|preview| preview.progress)
        .filter(|progress| progress.is_finite() && (0.0..=1.0).contains(progress))
}

/// 播放标记圆钮半径（画布单位）；`shows_playback_badge` 为真时绘制。
pub(crate) const SHOT_PREVIEW_BADGE_RADIUS: f32 = 9.0;
/// 播放标记相对内容区左上角的内边距（画布单位）。
pub(crate) const SHOT_PREVIEW_BADGE_INSET: f32 = 16.0;

/// 播放标记圆钮中心：内容区左上角内边距处，避免遮挡中央画面与底部进度条。
pub(crate) fn playback_badge_center(node: &GraphNode) -> Vec2 {
    let (x, y, width, height) = content_rect_of(node);
    let inset = SHOT_PREVIEW_BADGE_INSET.min(width.max(0.0) / 2.0).min(height.max(0.0) / 2.0);
    Vec2::new(x + inset, y + inset)
}

/// 动态卡片本地播放进度条的 `(底条矩形, 已完成矩形)`（画布坐标，高 3）。
///
/// 只读 `progress`（浏览器本地投影，不进入 canonical）；静态卡片或越界进度返回 `None`。
/// 返回 `(x, y, width, height)` 两段，绘制与命中复用同一几何。
pub(crate) fn playback_progress_bar(node: &GraphNode) -> Option<((f32, f32, f32, f32), (f32, f32, f32, f32))> {
    let progress = playback_progress(node)?;
    let (x, y, width, height) = content_rect_of(node);
    let bar_height = 3.0_f32.min(height.max(0.0));
    if bar_height <= 0.0 {
        return None;
    }
    let bar_y = y + height - bar_height;
    Some((
        (x, bar_y, width, bar_height),
        (x, bar_y, (width * progress).max(0.0), bar_height),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preview_node(data: &str) -> GraphNode {
        serde_json::from_str(data).expect("shot preview node")
    }

    fn node(x: f32, y: f32, width: f32, height: f32) -> GraphNode {
        preview_node(&format!(
            r#"{{"id":"shot-preview:x","type":"film-set-shot-preview","x":{x},"y":{y},
                "width":{width},"height":{height},
                "shotPreview":{{"filmSetNodeId":"film","clipId":"clip-1","kind":"dynamic",
                "name":"镜头","aspect":1.7777778,"duration":5,"state":"ready",
                "coverCamera":{{"azimuth":0,"elevation":0.7,"distance":8,"focusOffset":[0,0,0]}}}}}}"#
        ))
    }

    #[test]
    fn content_rect_matches_media_card_insets() {
        let rect = content_rect(10.0, 20.0, 240.0, 167.0);
        assert_eq!(rect, (26.0, 72.0, 208.0, 99.0));
        // 小尺寸沿用普通媒体内容框的下限。
        let degenerate = content_rect(0.0, 0.0, 240.0, 20.0);
        assert_eq!(degenerate.3, 24.0);
    }

    #[test]
    fn aspect_drives_content_height_with_clamps() {
        assert!((content_height(16.0 / 9.0) - 117.0).abs() < 0.001);
        // 极端横画幅（宽高比越大内容区越矮）触底到最小高度。
        assert_eq!(content_height(6.0), SHOT_PREVIEW_CONTENT_MIN_HEIGHT);
        assert_eq!(content_height(0.1), SHOT_PREVIEW_CONTENT_MAX_HEIGHT);
        // 非法画幅与本模块默认一致。
        assert_eq!(content_height(f32::NAN), content_height(16.0 / 9.0));
        assert_eq!(content_height(-1.0), content_height(16.0 / 9.0));
    }

    #[test]
    fn texture_size_contains_without_cropping() {
        let card = node(0.0, 0.0, 240.0, 185.0);
        // 比内容区更宽的纹理按宽度贴合，高度按比例缩小。
        let wide = texture_size(&card, Vec2::new(1920.0, 1080.0));
        assert!((wide.x - 208.0).abs() < 0.01);
        assert!((wide.y - 117.0).abs() < 0.5);
        // 竖纹理按高度贴合。
        let tall = texture_size(&card, Vec2::new(1080.0, 1920.0));
        assert!((tall.y - 117.0).abs() < 0.01 && tall.x < 208.0);
        // 非法纹理尺寸回退到镜头 aspect 的默认内容高度，不产生 NaN。
        let fallback = texture_size(&card, Vec2::new(0.0, f32::NAN));
        assert!(fallback.x.is_finite() && fallback.y.is_finite() && fallback.x > 0.0 && fallback.y > 0.0);
    }

    #[test]
    fn attachment_is_left_midpoint_and_shared_with_drawing() {
        let card = node(100.0, 50.0, 240.0, 167.0);
        let attachment = card_attachment_of(&card);
        assert_eq!(attachment, Vec2::new(100.0, 50.0 + 167.0 / 2.0));
        assert_eq!(card_attachment(0.0, 0.0, 10.0, 10.0), Vec2::new(0.0, 5.0));
    }

    #[test]
    fn visibility_uses_card_rect_and_unknown_surface_is_conservative() {
        let card = node(100.0, 100.0, 240.0, 167.0);
        assert!(visible_on_surface(&card, [0.0, 0.0, 1.0], Vec2::new(800.0, 600.0)));
        // 完全移出右侧。
        assert!(!visible_on_surface(&card, [-10_000.0, 0.0, 1.0], Vec2::new(800.0, 600.0)));
        // 未知/非法 surface 保守视为可见（不误杀）。
        assert!(visible_on_surface(&card, [0.0, 0.0, 1.0], Vec2::ZERO));
        assert!(visible_on_surface(&card, [f32::NAN, 0.0, 1.0], Vec2::new(800.0, 600.0)));
    }

    #[test]
    fn preview_type_is_declared_not_guessed() {
        assert!(!is_shot_preview_node(&serde_json::from_str::<GraphNode>(
            r#"{"id":"n","type":"image","x":0,"y":0}"#
        )
        .unwrap()));
        assert!(is_shot_preview_node(&node(0.0, 0.0, 240.0, 167.0)));
        assert!((shot_preview_aspect(&node(0.0, 0.0, 240.0, 167.0)) - 16.0 / 9.0).abs() < 0.001);
    }

    fn state_node(state: &str, kind: &str, playing: Option<bool>, diagnostic: Option<&str>) -> GraphNode {
        let playing = playing.map(|value| value.to_string()).unwrap_or_else(|| "null".to_owned());
        let diagnostic = diagnostic
            .map(|text| format!("\"{text}\""))
            .unwrap_or_else(|| "null".to_owned());
        preview_node(&format!(
            r#"{{"id":"shot-preview:x","type":"film-set-shot-preview","x":0,"y":0,"width":240,"height":167,
                "shotPreview":{{"filmSetNodeId":"film","clipId":"c1","kind":"{kind}","name":"镜头",
                "aspect":1.7777778,"duration":5,"state":"{state}","playing":{playing},"diagnostic":{diagnostic},
                "coverCamera":{{"azimuth":0,"elevation":0.7,"distance":8,"focusOffset":[0,0,0]}}}}}}"#
        ))
    }

    #[test]
    fn status_labels_are_recognizable_and_ready_is_silent() {
        assert_eq!(status_label("preparing"), Some("预览准备中"));
        assert_eq!(status_label("stale"), Some("待更新"));
        assert_eq!(status_label("error"), Some("预览失败"));
        assert_eq!(status_label("ready"), None);
        let shorten = |text: &str, _w: f32, _s: f32| text.to_owned();
        assert_eq!(status_text(&state_node("ready", "static", None, None), &shorten), "");
        assert_eq!(
            status_text(&state_node("preparing", "static", None, None), &shorten),
            "预览准备中"
        );
        // 诊断文案优先于通用状态标签。
        assert_eq!(
            status_text(&state_node("error", "static", None, Some("镜头动作无效")), &shorten),
            "镜头动作无效"
        );
        // 普通节点（无 shotPreview）不产生任何预览文案。
        let plain: GraphNode = serde_json::from_str(r#"{"id":"n","type":"image","x":0,"y":0}"#).unwrap();
        assert!(status_text(&plain, &shorten).is_empty());
    }

    #[test]
    fn playback_badge_and_progress_are_dynamic_only_and_bounded() {
        assert!(shows_playback_badge(&state_node("ready", "dynamic", Some(true), None)));
        assert!(!shows_playback_badge(&state_node("ready", "dynamic", Some(false), None)));
        assert!(!shows_playback_badge(&state_node("ready", "static", Some(true), None)));

        let mut dynamic = state_node("ready", "dynamic", Some(true), None);
        dynamic.shot_preview.as_mut().unwrap().progress = Some(0.5);
        assert_eq!(playback_progress(&dynamic), Some(0.5));
        let (track, done) = playback_progress_bar(&dynamic).unwrap();
        assert!((track.3 - 3.0).abs() < 0.001, "进度条高 3");
        assert!((done.2 - track.2 * 0.5).abs() < 0.001, "已完成宽度按进度");
        dynamic.shot_preview.as_mut().unwrap().progress = Some(1.5);
        assert_eq!(playback_progress(&dynamic), None, "越界进度不绘制");
        assert!(playback_progress_bar(&dynamic).is_none());
        let static_card = state_node("ready", "static", None, None);
        assert_eq!(playback_progress(&static_card), None, "静态卡片无进度");
        assert!(playback_progress_bar(&static_card).is_none());
    }

    #[test]
    fn focus_isolation_only_applies_to_focus_modes() {
        let mut scene = crate::protocol::Scene::default();
        assert!(!focuses_isolate(&scene));
        scene.model_focus = Some(serde_json::from_str(
            r#"{"nodeId":"m","target":[0,0,0],"yaw":0,"pitch":0,"distance":10,"fov":0.87}"#,
        )
        .unwrap());
        assert!(focuses_isolate(&scene));
    }
}
