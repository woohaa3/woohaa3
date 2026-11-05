//! 节点内部底部历史圆点绘制
//! （change: 2026-10-12-unify-generation-history-strip，design D4）。
//!
//! 只**被动**消费 Web 投影的 `historyStrip` 语义：绘制节点内部底部的状态圆点
//! （成功/失败/执行中/排队/取消/中断/部分成功），当前生效版本用独立装饰（外圈）表达，
//! 不挤占状态颜色。纹理、完整历史与详情仍由受控历史接口负责；本模块不执行命中（命中在
//! `canvas_query::interaction` 用同一 `layout::history_strip_rect` 几何）、不提交命令。
//!
//! 抽出独立模块的理由：`render.rs` 接近文件体积上限（`tests/file_size.rs` 守卫）。

use bevy::prelude::*;

use crate::protocol::{GraphNode, HistoryStripPresentation};
use crate::theme::ThemeResource;

use super::geometry::Geometry;
use super::layout::{NODE_HISTORY_STRIP_DOT_RADIUS, history_strip_dot};

/// 当前版本装饰外圈相对圆点半径的增量。
const CURRENT_RING_OFFSET: f32 = 1.8;

/// 追加节点内居中的历史圆点。单个归档成功隐藏，单个活动/失败仍显示。
pub(crate) fn draw_history_strip(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    z: f32,
) {
    let Some(strip) = node.history_strip.as_ref().filter(|strip| {
        strip.dots.len() > 1
            || strip
                .dots
                .iter()
                .any(|dot| dot.state != "succeeded" || dot.recoverable == Some(false) || dot.unseen)
    }) else {
        return;
    };
    let count = strip.dots.len();
    for (index, dot) in strip.dots.iter().enumerate() {
        // New scenes delegate dots and their interaction rings to the small dynamic layer.
        if dot.selected.is_some() {
            continue;
        }
        let center = history_strip_dot(node.x, node.y, node.width, node.height, index, count);
        let color = dot_color(theme, &dot.state);
        // 当前版本装饰：外圈（不改变圆点状态颜色）。
        if dot.current {
            geometry.ring(
                center,
                NODE_HISTORY_STRIP_DOT_RADIUS + CURRENT_RING_OFFSET,
                1.2,
                z + 0.004,
                theme.token_u32("interactionAccent"),
                16,
            );
        }
        geometry.circle(center, NODE_HISTORY_STRIP_DOT_RADIUS, z + 0.005, color, 14);
        if dot.unseen {
            draw_unseen_badge(geometry, theme, center, z + 0.006);
        }
    }
}

/// 未查看版本提醒：右上角小圆点 + 背景色分离环，不占用状态颜色或当前/选中外圈。
pub(crate) fn draw_unseen_badge(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    center: Vec2,
    z: f32,
) {
    let badge = center + Vec2::new(2.8, -2.8);
    geometry.ring(
        badge,
        1.55,
        0.9,
        z,
        theme.token_u32("canvasNodeSurface"),
        12,
    );
    geometry.circle(badge, 1.35, z + 0.0005, theme.token_u32("statusWarning"), 12);
}

/// 聚合节点运行遮罩：覆盖整个节点/范围几何的半透明遮罩 + “运行中”。
///
/// 返回需要绘制的标签（供调用方复用标签实体池）。
pub(crate) fn draw_aggregate_run_overlay(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    bounds: (f32, f32, f32, f32),
    z: f32,
) -> String {
    let (x, y, width, height) = bounds;
    geometry.rounded_rect_alpha(
        x,
        y,
        width,
        height,
        8.0,
        z,
        theme.token_u32("canvasNodeContent"),
        0.45,
    );
    "运行中".to_owned()
}

/// 历史条圆点状态颜色。
pub(super) fn dot_color(theme: &ThemeResource, state: &str) -> u32 {
    match state {
        "succeeded" => theme.token_u32("canvasProgressFill"),
        "failed" => theme.token_u32("statusDanger"),
        "running" => theme.token_u32("statusWarningSoft"),
        "queued" => theme.token_u32("canvasProgressTrack"),
        "cancelled" => theme.token_u32("canvasCloseIcon"),
        "interrupted" => theme.token_u32("canvasPortDefault"),
        "partial" => theme.token_u32("canvasNodeBorderSelected"),
        _ => theme.token_u32("canvasProgressTrack"),
    }
}

/// 供测试访问：某呈现的圆点数量（有界）。
#[allow(dead_code)]
pub(crate) fn dot_count(strip: &HistoryStripPresentation) -> usize {
    strip.dots.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{HistoryStripDot, HistoryStripPresentation};

    #[test]
    fn single_failure_is_visible_and_uses_danger() {
        let theme = ThemeResource::default();
        assert_eq!(dot_color(&theme, "failed"), theme.token_u32("statusDanger"));
        assert_eq!(
            dot_color(&theme, "running"),
            theme.token_u32("statusWarningSoft")
        );
        let strip: HistoryStripPresentation = serde_json::from_str(r#"{"dots":[{"state":"failed","current":false,"presentationId":"operation:run","operationId":"run","recoverable":false}],"truncated":0}"#).unwrap();
        let node = node(Some(strip));
        assert!(super::super::layout::has_history_strip(&node));
        let mut geometry = Geometry::default();
        draw_history_strip(&mut geometry, &theme, &node, 10.0);
        assert!(positions(geometry) > 0);
    }

    #[test]
    fn unseen_badge_adds_a_corner_marker_without_replacing_state_color() {
        let theme = ThemeResource::default();
        let with_unseen: HistoryStripPresentation = serde_json::from_str(
            r#"{"dots":[{"state":"succeeded","current":false,"entryId":"e","unseen":true},{"state":"succeeded","current":true,"entryId":"f"}],"truncated":0}"#,
        )
        .unwrap();
        let without: HistoryStripPresentation = serde_json::from_str(
            r#"{"dots":[{"state":"succeeded","current":false,"entryId":"e"},{"state":"succeeded","current":true,"entryId":"f"}],"truncated":0}"#,
        )
        .unwrap();
        let mut marked = Geometry::default();
        draw_history_strip(&mut marked, &theme, &node(Some(with_unseen)), 10.0);
        let mut plain = Geometry::default();
        draw_history_strip(&mut plain, &theme, &node(Some(without)), 10.0);
        assert!(positions(marked) > positions(plain));
    }

    #[test]
    fn single_unseen_success_is_drawn() {
        let theme = ThemeResource::default();
        let strip: HistoryStripPresentation = serde_json::from_str(
            r#"{"dots":[{"state":"succeeded","current":true,"entryId":"e","unseen":true}],"truncated":0}"#,
        )
        .unwrap();
        let mut geometry = Geometry::default();
        draw_history_strip(&mut geometry, &theme, &node(Some(strip)), 10.0);
        assert!(positions(geometry) > 0);
    }

    fn node(strip: Option<HistoryStripPresentation>) -> GraphNode {
        GraphNode {
            chrome: crate::protocol::NodeChrome::Card,
            shared_world_instance: None,
            world_camera: None,
            model_preview: None,
            media_loading: false,
            id: "n".into(),
            kind: "image".into(),
            x: 0.0,
            y: 0.0,
            width: 248.0,
            height: 232.0,
            body: String::new(),
            title: String::new(),
            type_label: String::new(),
            progress: 0.0,
            progress_started_at: None,
            busy: false,
            texture: false,
            resizable: false,
            ghost: false,
            card_label: None,
            model: None,
            history_strip: strip,
        }
    }

    fn positions(geometry: Geometry) -> usize {
        let mesh = geometry.build();
        mesh.attribute(Mesh::ATTRIBUTE_POSITION)
            .expect("positions")
            .as_float3()
            .expect("float3 positions")
            .iter()
            .filter(|p| p[0] > -1.0e5)
            .count()
    }

    #[test]
    fn absent_or_single_version_has_no_geometry() {
        // 没有多个可切换版本时，不绘制任何几何。
        let theme = ThemeResource::default();
        let mut geometry = Geometry::default();
        draw_history_strip(&mut geometry, &theme, &node(None), 10.0);
        assert_eq!(positions(geometry), 0);
        let mut empty = Geometry::default();
        draw_history_strip(
            &mut empty,
            &theme,
            &node(Some(HistoryStripPresentation {
                dots: vec![],
                truncated: 0,
            })),
            10.0,
        );
        assert_eq!(positions(empty), 0);
    }

    #[test]
    fn dots_add_over_bar() {
        let theme = ThemeResource::default();
        let bare = node(None);
        let with_dots = node(Some(HistoryStripPresentation {
            dots: vec![
                HistoryStripDot {
                    selected: None,
                    hovered: false,
                    pressed: false,
                    unseen: false,
                    presentation_id: None,
                    entry_id: None,
                    operation_id: None,
                    recoverable: None,
                    state: "succeeded".into(),
                    current: false,
                },
                HistoryStripDot {
                    selected: None,
                    hovered: false,
                    pressed: false,
                    unseen: false,
                    presentation_id: None,
                    entry_id: None,
                    operation_id: None,
                    recoverable: None,
                    state: "running".into(),
                    current: false,
                },
            ],
            truncated: 0,
        }));
        let mut base = Geometry::default();
        draw_history_strip(&mut base, &theme, &bare, 10.0);
        let mut with = Geometry::default();
        draw_history_strip(&mut with, &theme, &with_dots, 10.0);
        assert!(positions(with) > positions(base));
    }

    #[test]
    fn dots_draw_and_current_adds_ring() {
        let theme = ThemeResource::default();
        let strip = HistoryStripPresentation {
            dots: vec![
                HistoryStripDot {
                    selected: None,
                    hovered: false,
                    pressed: false,
                    unseen: false,
                    presentation_id: None,
                    entry_id: None,
                    operation_id: None,
                    recoverable: None,
                    state: "succeeded".into(),
                    current: false,
                },
                HistoryStripDot {
                    selected: None,
                    hovered: false,
                    pressed: false,
                    unseen: false,
                    presentation_id: None,
                    entry_id: None,
                    operation_id: None,
                    recoverable: None,
                    state: "failed".into(),
                    current: true,
                },
                HistoryStripDot {
                    selected: None,
                    hovered: false,
                    pressed: false,
                    unseen: false,
                    presentation_id: None,
                    entry_id: None,
                    operation_id: None,
                    recoverable: None,
                    state: "running".into(),
                    current: false,
                },
            ],
            truncated: 0,
        };
        let mut geometry = Geometry::default();
        draw_history_strip(&mut geometry, &theme, &node(Some(strip)), 10.0);
        // 三个圆点和一个当前版本外圈。
        assert!(positions(geometry) > 40);
    }

    #[test]
    fn single_version_has_no_dot_or_overflow_marker() {
        let theme = ThemeResource::default();
        let mut geometry = Geometry::default();
        draw_history_strip(
            &mut geometry,
            &theme,
            &node(Some(HistoryStripPresentation {
                dots: vec![HistoryStripDot {
                    selected: None,
                    hovered: false,
                    pressed: false,
                    unseen: false,
                    presentation_id: None,
                    entry_id: None,
                    operation_id: None,
                    recoverable: None,
                    state: "succeeded".into(),
                    current: true,
                }],
                truncated: 0,
            })),
            10.0,
        );
        assert_eq!(positions(geometry), 0);
    }

    #[test]
    fn aggregate_overlay_draws_and_labels() {
        let theme = ThemeResource::default();
        let mut geometry = Geometry::default();
        let label =
            draw_aggregate_run_overlay(&mut geometry, &theme, (0.0, 0.0, 200.0, 100.0), 10.0);
        assert_eq!(label, "运行中");
        assert!(positions(geometry) > 30);
    }
}
