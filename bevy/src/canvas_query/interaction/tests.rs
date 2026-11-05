//! `interaction` 模块的单元测试
//! （change: 2026-10-10-optimize-canvas-interaction-hot-path —— 从 `mod.rs` 拆出，使生产
//! 源码保持在业务 500 行上限内；断言不变）。

use super::*;
use crate::protocol::{Edge, GraphNode, NodeChrome, Selection};

#[test]
fn replacement_generation_never_reuses_old_query_identity() {
    seed_generation(100);
    let generation = accept_scene(&scene(vec![], vec![]));
    assert!(generation > 100);
    seed_generation(999); // A live realm cannot be reseeded.
    assert_eq!(current_generation(), generation);
    assert!(with_snapshot(100, |_| ()).is_err());
}

fn scene(nodes: Vec<GraphNode>, edges: Vec<Edge>) -> Scene {
    Scene {
        version: crate::protocol::CANVAS_RENDER_SCENE_VERSION.to_owned(),
        nodes,
        edges,
        selection: Selection::default(),
        ..Scene::default()
    }
}

mod node_action;
mod scene_area;
mod spatial;

fn node(id: &str, x: f32, y: f32, width: f32, height: f32) -> GraphNode {
    GraphNode {
        chrome: NodeChrome::Card,
        shared_world_instance: None,
        world_camera: None,
        model_preview: None,
        id: id.into(),
        kind: "image".into(),
        x,
        y,
        width,
        height,
        body: String::new(),
        title: String::new(),
        type_label: String::new(),
        progress: 0.0,
        progress_started_at: None,
        busy: false,
        texture: false,
        media_loading: false,
        resizable: true,
        ghost: false,
        card_label: None,
        model: None,
        history_strip: None,
    }
}

#[test]
fn accept_scene_bumps_generation_and_rejects_stale() {
    clear_snapshot();
    let first = accept_scene(&scene(vec![node("n", 0.0, 0.0, 100.0, 50.0)], vec![]));
    let stale = point_query(first.wrapping_sub(1), 10.0, 10.0, 1.0, None);
    assert!(!stale.available);
    assert_eq!(stale.reason.as_deref(), Some("stale"));
    let ok = point_query(first, 10.0, 10.0, 1.0, None);
    assert!(ok.available);
    assert_eq!(
        ok.hit,
        Some(PointHit::Node {
            node_id: "n".into()
        })
    );
}

#[test]
fn unavailable_without_snapshot() {
    clear_snapshot();
    let result = point_query(1, 0.0, 0.0, 1.0, None);
    assert!(!result.available);
    assert_eq!(result.reason.as_deref(), Some("unavailable"));
}

#[test]
fn point_hit_priority_port_then_body() {
    clear_snapshot();
    let g = accept_scene(&scene(vec![node("n", 0.0, 0.0, 100.0, 50.0)], vec![]));
    let port = point_query(g, 100.0, 25.0, 1.0, None);
    assert_eq!(
        port.hit,
        Some(PointHit::Port {
            node_id: "n".into(),
            side: "output".into()
        })
    );
    let body = point_query(g, 100.0 - 22.0, 23.0, 1.0, None);
    // The former close slot now downloads media via the DOM toolbar; the native
    // card no longer owns a download hit region, so this point falls through to
    // the node body and never deletes the node.
    assert_eq!(
        body.hit,
        Some(PointHit::Node {
            node_id: "n".into()
        })
    );
    // 卡片内不再有独立历史图标：历史入口迁移到节点下方历史条
    // （见 `history_strip_hit_is_below_node`），此点落在节点主体。
    assert_eq!(
        point_query(g, 50.0, 23.0, 1.0, None).hit,
        Some(PointHit::Node {
            node_id: "n".into()
        })
    );
}

#[test]
fn resize_only_hits_selected_node() {
    clear_snapshot();
    let mut s = scene(vec![node("n", 0.0, 0.0, 100.0, 50.0)], vec![]);
    let corner = (100.0 - 10.0, 50.0 - 10.0);
    let g = accept_scene(&s);
    assert_eq!(
        point_query(g, corner.0, corner.1, 1.0, None).hit,
        Some(PointHit::Node {
            node_id: "n".into()
        })
    );
    s.selection = Selection {
        nodes: vec!["n".into()],
        edge: None,
    };
    let g = accept_scene(&s);
    assert_eq!(
        point_query(g, corner.0, corner.1, 1.0, None).hit,
        Some(PointHit::Resize {
            node_id: "n".into(),
            handle: None
        })
    );
}


#[test]
fn edge_hit_uses_broad_phase() {
    clear_snapshot();
    let s = scene(
        vec![
            node("a", 0.0, 0.0, 100.0, 50.0),
            node("b", 400.0, 0.0, 100.0, 50.0),
        ],
        vec![Edge {
            id: "e".into(),
            source: "a".into(),
            target: "b".into(),
            label: String::new(),
        }],
    );
    let g = accept_scene(&s);
    // 边在两端口中点附近；取中点。
    let mid = ((100.0 + 400.0) / 2.0, 25.0);
    let hit = point_query(g, mid.0, mid.1 - 200.0, 1.0, None);
    // 远离边应为空；靠近时命中边。
    assert_eq!(hit.hit, None);
    let near = point_query(g, mid.0, mid.1, 1.0, None);
    assert_eq!(
        near.hit,
        Some(PointHit::Edge {
            edge_id: "e".into()
        })
    );
}

#[test]
fn edge_delete_button_hover_bridge_covers_label_to_button() {
    clear_snapshot();
    // 有标签的纵向边：端口 (100,25) / (100,325) → 算术中点 (100,175)。
    // 标签按内容收缩："图片" = 2 个汉字 → 宽 22 + 左右内边距 16 = 38，居中于中点；
    // 按钮排在标签右侧，中心 (132,175)。
    let s = scene(
        vec![
            node("a", 0.0, 0.0, 100.0, 50.0),
            node("b", 100.0, 300.0, 100.0, 50.0),
        ],
        vec![Edge {
            id: "e".into(),
            source: "a".into(),
            target: "b".into(),
            label: "图片".into(),
        }],
    );
    let g = accept_scene(&s);
    let label_side = (112.0, 175.0);
    let gap = (120.0, 175.0);
    let button = (132.0, 175.0);
    // 未悬停时既没有幽灵按钮，也没有标签保持区。
    assert_eq!(point_query(g, button.0, button.1, 1.0, None).hit, None);
    assert_eq!(
        point_query(g, label_side.0, label_side.1, 1.0, None).hit,
        None
    );
    // 悬停后：标签保持悬停（不删除），间隙与按钮命中删除按钮。
    assert_eq!(
        point_query(g, label_side.0, label_side.1, 1.0, Some("e")).hit,
        Some(PointHit::Edge {
            edge_id: "e".into()
        })
    );
    for point in [gap, button] {
        assert_eq!(
            point_query(g, point.0, point.1, 1.0, Some("e")).hit,
            Some(PointHit::EdgeDelete {
                edge_id: "e".into()
            })
        );
    }
}

#[test]
fn marquee_intersects_but_skips_ghost() {
    clear_snapshot();
    let mut ghost = node("c", 50.0, 0.0, 100.0, 50.0);
    ghost.ghost = true;
    let g = accept_scene(&scene(
        vec![
            node("a", 0.0, 0.0, 100.0, 50.0),
            node("b", 300.0, 0.0, 100.0, 50.0),
            ghost,
        ],
        vec![],
    ));
    let result = marquee_query(g, -10.0, -10.0, 200.0, 200.0);
    assert_eq!(result.node_ids, vec!["a".to_owned()]);
}

#[test]
fn probe_returns_direction_candidates() {
    clear_snapshot();
    let g = accept_scene(&scene(
        vec![
            node("a", 0.0, 0.0, 100.0, 50.0),
            node("b", 300.0, 0.0, 100.0, 50.0),
        ],
        vec![],
    ));
    let next = probe_query(g, "a", "next");
    assert_eq!(next.candidates.len(), 1);
    assert_eq!(next.candidates[0].node_id, "b");
    assert!(next.candidates[0].connectable);
    let prev = probe_query(g, "a", "prev");
    assert!(prev.candidates.is_empty());
}

#[test]
fn json_entrypoint_round_trips() {
    clear_snapshot();
    let g = accept_scene(&scene(vec![node("n", 0.0, 0.0, 100.0, 50.0)], vec![]));
    let json = format!("{{\"generation\":{g},\"x\":10,\"y\":10,\"zoom\":1}}");
    let parsed = point_query_json(&json);
    assert!(parsed.contains("\"available\":true"));
    assert!(parsed.contains("\"nodeId\":\"n\""));
    // 非法 JSON 返回稳定 unavailable。
    let bad = point_query_json("{not json");
    assert!(bad.contains("\"available\":false"));
    assert!(bad.contains("unavailable"));
}




#[test]
fn accept_viewport_reuses_world_index_and_bumps_generation() {
    clear_snapshot();
    let g = accept_scene(&scene(vec![node("n", 0.0, 0.0, 100.0, 50.0)], vec![]));
    assert_eq!(base_generation(), g);
    // 合法纯视口增量：推进 generation，base 不变，命中仍按世界几何。
    let next = accept_viewport(
        g,
        crate::protocol::Viewport {
            x: 5.0,
            y: 0.0,
            zoom: 1.0,
        },
    )
    .expect("viewport accepted");
    assert_eq!(next, g.wrapping_add(1));
    assert_eq!(base_generation(), g);
    assert_eq!(
        point_query(next, 10.0, 10.0, 1.0, None).hit,
        Some(PointHit::Node {
            node_id: "n".into()
        })
    );
    // 旧 generation 现在 stale。
    assert_eq!(
        point_query(g, 10.0, 10.0, 1.0, None).reason.as_deref(),
        Some("stale")
    );
}

#[test]
fn accept_viewport_rejects_stale_base_and_missing_snapshot() {
    clear_snapshot();
    // 无快照：unavailable。
    assert_eq!(
        accept_viewport(
            1,
            crate::protocol::Viewport {
                x: 0.0,
                y: 0.0,
                zoom: 1.0
            }
        ),
        Err("unavailable")
    );
    let g = accept_scene(&scene(vec![node("n", 0.0, 0.0, 100.0, 50.0)], vec![]));
    // base 不匹配：原子拒绝，generation 不变。
    assert_eq!(
        accept_viewport(
            g.wrapping_add(3),
            crate::protocol::Viewport {
                x: 0.0,
                y: 0.0,
                zoom: 1.0
            }
        ),
        Err("stale-base")
    );
    assert_eq!(point_query(g, 10.0, 10.0, 1.0, None).available, true);
}

#[test]
fn accept_viewport_rejects_non_overview_scene() {
    clear_snapshot();
    // 聚焦场景（model_focus 存在）不允许纯视口增量。
    let mut s = scene(vec![node("n", 0.0, 0.0, 100.0, 50.0)], vec![]);
    s.model_focus = Some(crate::protocol::ModelFocus {
        version: crate::protocol::MODEL_FOCUS_VERSION.to_owned(),
        node_id: "n".into(),
        target: [0.0, 0.0, 0.0],
        yaw: 0.0,
        pitch: 0.0,
        distance: 4.0,
        fov: 45.0,
        radius: 1.0,
    });
    let g = accept_scene(&s);
    assert_eq!(
        accept_viewport(
            g,
            crate::protocol::Viewport {
                x: 0.0,
                y: 0.0,
                zoom: 1.0
            }
        ),
        Err("not-overview")
    );
}

#[test]
fn accept_observer_reuses_world_index_and_bumps_generation() {
    clear_snapshot();
    let mut s = scene(vec![node("n", 0.0, 0.0, 100.0, 50.0)], vec![]);
    s.model_focus = Some(crate::protocol::ModelFocus {
        version: crate::protocol::MODEL_FOCUS_VERSION.to_owned(),
        node_id: "n".into(),
        target: [0.0, 0.0, 0.0],
        yaw: 0.0,
        pitch: 0.0,
        distance: 4.0,
        fov: 45.0,
        radius: 1.0,
    });
    let g = accept_scene(&s);
    let next = accept_observer(g, "n").expect("observer accepted");
    assert_eq!(next, g.wrapping_add(1));
    assert_eq!(base_generation(), g);
    assert_eq!(
        point_query(next, 10.0, 10.0, 1.0, None).hit,
        Some(PointHit::Node {
            node_id: "n".into()
        })
    );
    assert_eq!(
        point_query(g, 10.0, 10.0, 1.0, None).reason.as_deref(),
        Some("stale")
    );
}

#[test]
fn accept_observer_rejects_overview_and_stale_base() {
    clear_snapshot();
    assert_eq!(accept_observer(1, "n"), Err("unavailable"));
    let g = accept_scene(&scene(vec![node("n", 0.0, 0.0, 100.0, 50.0)], vec![]));
    assert_eq!(accept_observer(g, "n"), Err("not-focused"));
    let mut s = scene(vec![node("n", 0.0, 0.0, 100.0, 50.0)], vec![]);
    s.model_focus = Some(crate::protocol::ModelFocus {
        version: crate::protocol::MODEL_FOCUS_VERSION.to_owned(),
        node_id: "n".into(),
        target: [0.0, 0.0, 0.0],
        yaw: 0.0,
        pitch: 0.0,
        distance: 4.0,
        fov: 45.0,
        radius: 1.0,
    });
    let focused = accept_scene(&s);
    assert_eq!(
        accept_observer(focused.wrapping_add(3), "n"),
        Err("stale-base")
    );
    assert_eq!(point_query(focused, 10.0, 10.0, 1.0, None).available, true);
}

#[test]
fn visible_aggregate_handles_are_queryable_and_removed_with_projection() {
    clear_snapshot();
    let mut input = scene(
        vec![
            node("a", 200.0, 0.0, 200.0, 120.0),
            node("b", 200.0, 300.0, 200.0, 120.0),
        ],
        vec![],
    );
    input.selection.nodes = vec!["a".into(), "b".into()];
    input.aggregate_connect = Some(crate::protocol::AggregateConnect {
        direction: None,
        cursor: None,
        pending_edges: vec![],
    });
    let generation = accept_scene(&input);
    for (x, direction) in [(182.0, "input"), (418.0, "output")] {
        assert_eq!(
            point_query(generation, x, 210.0, 1.0, None).hit,
            Some(PointHit::AggregateHandle {
                direction: direction.into()
            })
        );
    }
    // 放大/缩小复用世界几何；触控命中容差按 zoom 调整。
    assert_eq!(
        point_query(generation, 438.0, 210.0, 0.5, None).hit,
        Some(PointHit::AggregateHandle {
            direction: "output".into()
        })
    );
    input.aggregate_connect = None;
    let next = accept_scene(&input);
    assert!(point_query(next, 418.0, 210.0, 1.0, None).hit.is_none());
    assert!(!point_query(generation, 418.0, 210.0, 1.0, None).available);
}


#[test]
fn history_dots_hit_inside_node_and_single_version_does_not_capture() {
    clear_snapshot();
    let mut n = node("n", 100.0, 200.0, 248.0, 232.0);
    n.history_strip = Some(crate::protocol::HistoryStripPresentation {
        dots: vec![
            crate::protocol::HistoryStripDot {
                selected: None,
                hovered: false,
                pressed: false,
                presentation_id: None,
                entry_id: None,
                operation_id: None,
                recoverable: None,
                state: "succeeded".into(),
                current: true,
                unseen: false,
            },
            crate::protocol::HistoryStripDot {
                selected: None,
                hovered: false,
                pressed: false,
                presentation_id: None,
                entry_id: None,
                operation_id: None,
                recoverable: None,
                state: "succeeded".into(),
                current: false,
                unseen: false,
            },
        ],
        truncated: 0,
    });
    let g = accept_scene(&scene(vec![n.clone()], vec![]));
    assert_eq!(
        point_query(g, 220.0, 420.0, 1.0, None).hit,
        Some(PointHit::History {
            node_id: "n".into()
        })
    );
    assert_ne!(
        point_query(g, 220.0, 447.0, 1.0, None).hit,
        Some(PointHit::History {
            node_id: "n".into()
        })
    );
    n.history_strip.as_mut().unwrap().dots.truncate(1);
    let g = accept_scene(&scene(vec![n], vec![]));
    assert_eq!(
        point_query(g, 220.0, 420.0, 1.0, None).hit,
        Some(PointHit::Node {
            node_id: "n".into()
        })
    );
}


#[test]
fn chrome_none_world_model_has_no_card_port_history_or_resize_hits() {
    clear_snapshot();
    let mut world = node("world", 0.0, 0.0, 200.0, 160.0);
    world.chrome = NodeChrome::None;
    let card = node("card", 400.0, 0.0, 100.0, 100.0);
    let mut s = scene(vec![world, card], vec![]);
    s.selection = Selection {
        nodes: vec!["world".into()],
        ..Selection::default()
    };
    let g = accept_scene(&s);
    // 卡片本体、输入/输出端口、选中 resize 抓手都不再留下隐形命中。
    assert_eq!(point_query(g, 100.0, 80.0, 1.0, None).hit, None);
    assert_eq!(point_query(g, 200.0, 80.0, 1.0, None).hit, None);
    assert_eq!(point_query(g, 0.0, 80.0, 1.0, None).hit, None);
    assert_eq!(point_query(g, 194.0, 154.0, 1.0, None).hit, None);
    // 世界对象也不能经旧卡片矩形参与框选、拖动粘连/合并目标。
    let marquee = marquee_query(g, -10.0, -10.0, 700.0, 300.0);
    assert!(marquee.available);
    assert_eq!(marquee.node_ids, vec!["card".to_owned()]);
    let probe = probe_query(g, "card", "prev");
    assert!(probe.available);
    assert!(probe.candidates.is_empty());
    let drop = drop_target_query(g, 100.0, 80.0, &[]);
    assert!(drop.available);
    assert_eq!(drop.target_node_id, None);
}

#[test]
fn selected_edge_delete_follows_the_curve_instead_of_its_old_midpoint() {
    clear_snapshot();
    let mut s = scene(
        vec![
            node("a", 0.0, 0.0, 100.0, 50.0),
            node("b", 400.0, 0.0, 100.0, 50.0),
        ],
        vec![Edge {
            id: "e".into(),
            source: "a".into(),
            target: "b".into(),
            label: "输入".into(),
        }],
    );
    s.hover = Some(crate::protocol::NodeHover {
        node_id: None,
        port: None,
        edge_id: Some("e".into()),
        cursor: Some(crate::protocol::CursorPoint { x: 320.0, y: 28.0 }),
    });
    let g = accept_scene(&s);
    assert!(matches!(
        point_query(g, 320.0, 25.0, 1.0, Some("e")).hit,
        Some(PointHit::Edge { .. })
    ));
    s.selection.edge = Some("e".into());
    let g = accept_scene(&s);
    assert!(matches!(
        point_query(g, 320.0, 25.0, 1.0, Some("e")).hit,
        Some(PointHit::EdgeDelete { .. })
    ));
    assert!(matches!(
        point_query(g, 250.0, 25.0, 1.0, Some("e")).hit,
        Some(PointHit::Edge { .. })
    ));
    s.hover.as_mut().unwrap().cursor = Some(crate::protocol::CursorPoint { x: 180.0, y: 22.0 });
    let g = accept_scene(&s);
    assert!(matches!(
        point_query(g, 180.0, 25.0, 1.0, Some("e")).hit,
        Some(PointHit::EdgeDelete { .. })
    ));
    assert!(matches!(
        point_query(g, 320.0, 25.0, 1.0, Some("e")).hit,
        Some(PointHit::Edge { .. })
    ));
}

#[test]
fn magnetic_ports_require_acquisition_and_remain_bounded_to_the_original_anchor() {
    for (side, anchor) in [
        ("input", Vec2::new(0.0, 25.0)),
        ("output", Vec2::new(100.0, 25.0)),
    ] {
        clear_snapshot();
        let mut s = scene(vec![node("a", 0.0, 0.0, 100.0, 50.0)], vec![]);
        let g = accept_scene(&s);
        let near = anchor + Vec2::new(32.0, 0.0);
        assert!(!matches!(
            point_query(g, near.x, near.y, 1.0, None).hit,
            Some(PointHit::Port { .. })
        ));
        let hover = crate::protocol::NodeHover {
            node_id: Some("a".into()),
            port: Some(side.into()),
            edge_id: None,
            cursor: Some(crate::protocol::CursorPoint {
                x: near.x,
                y: near.y,
            }),
        };
        let center = crate::canvas_query::layout::magnetic_port_center(anchor, &hover, side);
        assert!((center - anchor - Vec2::new(24.0, 0.0)).length() < 0.001);
        s.hover = Some(hover);
        let g = accept_scene(&s);
        assert_eq!(
            point_query(g, near.x, near.y, 1.0, None).hit,
            Some(PointHit::Port {
                node_id: "a".into(),
                side: side.into()
            })
        );
        let far = anchor + Vec2::new(40.0, 0.0);
        assert!(!matches!(
            point_query(g, far.x, far.y, 1.0, None).hit,
            Some(PointHit::Port { .. })
        ));
        // Diagonal tolerance is circular; the corner of its bounding square cannot latch.
        assert!(!matches!(
            point_query(g, anchor.x + 30.0, anchor.y + 30.0, 1.0, None).hit,
            Some(PointHit::Port { .. })
        ));
    }
}
