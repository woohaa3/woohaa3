//! `interaction` 模块的单元测试
//! （change: 2026-10-10-optimize-canvas-interaction-hot-path —— 从 `mod.rs` 拆出，使生产
//! 源码保持在业务 500 行上限内；断言不变）。

use super::*;
use crate::protocol::{Edge, GraphNode, GroupPresentation, Selection};

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

mod film_set;
mod group_model;
mod node_action;
mod spatial;

fn node(id: &str, x: f32, y: f32, width: f32, height: f32) -> GraphNode {
    GraphNode {
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
        busy: false,
        texture: false,
        media_loading: false,
        resizable: true,
        ghost: false,
        card_label: None,
        group: None,
        model: None,
        composite_asset: None,
        history_strip: None,
        aggregate_run: None,
        shot_preview: None,
    }
}

fn group(id: &str, x: f32, y: f32, w: f32, h: f32, leaves: u32) -> GraphNode {
    GraphNode {
        group: Some(GroupPresentation {
            badge_top_anchor: false,
            collapsed: false,
            action_bar: false,
            title: String::new(),
            member_count: 1,
            output_capable_leaf_count: leaves,
            model_bounds: None,
            run_status: None,
            geometry_quality: None,
            drop_target: false,
        
            overview_cache: None,
        }),
        ..node(id, x, y, w, h)
    }
}

fn film_set(
    id: &str,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    scope: Option<(f32, f32, f32, f32)>,
) -> GraphNode {
    GraphNode {
        kind: "model".into(),
        composite_asset: Some(match scope {
            Some((sx, sy, sw, sh)) => crate::protocol::CompositeAssetPresentation {
                panel: None,
                ownership_links: None,
                root_placement: None,
                content_extent: None,
                layout_aabb: None,
                empty_placeholder: None,
                geometry_quality: None,
                scope_shape: crate::protocol::CompositeAssetScopeShape::IsometricDiamond,
                scope_ground: Some(crate::protocol::ScopeGroundDto {
                    cx: sx + sw / 2.0,
                    cy: sy + sh / 2.0,
                    hx: 80.0,
                    hz: 80.0,
                }),
                x: sx,
                y: sy,
                width: sw,
                height: sh,
                media: Vec::new(),
                item_roots: std::collections::HashMap::new(),
                item_placements: std::collections::HashMap::new(),
            },
            None => crate::protocol::CompositeAssetPresentation {
                panel: None,
                ownership_links: None,
                root_placement: None,
                content_extent: None,
                layout_aabb: None,
                empty_placeholder: None,
                geometry_quality: None,
                scope_shape: crate::protocol::CompositeAssetScopeShape::IsometricDiamond,
                scope_ground: Some(crate::protocol::ScopeGroundDto {
                    cx: x + w / 2.0,
                    cy: y + h / 2.0,
                    hx: 80.0,
                    hz: 80.0,
                }),
                x: 0.0,
                y: 0.0,
                width: w,
                height: h,
                media: Vec::new(),
                item_roots: std::collections::HashMap::new(),
                item_placements: std::collections::HashMap::new(),
            },
        }),
        ..node(id, x, y, w, h)
    }
}

/// 轴对齐 `Rect` 范围的片场（可信矩形覆盖，无地面菱形）。
fn rect_film_set(id: &str, x: f32, y: f32, w: f32, h: f32) -> GraphNode {
    GraphNode {
        kind: "model".into(),
        composite_asset: Some(crate::protocol::CompositeAssetPresentation {
            panel: None,
            ownership_links: None,
            root_placement: None,
            content_extent: None,
            layout_aabb: None,
            empty_placeholder: None,
            geometry_quality: None,
            scope_shape: crate::protocol::CompositeAssetScopeShape::Rect,
            scope_ground: None,
            x,
            y,
            width: w,
            height: h,
            media: Vec::new(),
            item_roots: std::collections::HashMap::new(),
            item_placements: std::collections::HashMap::new(),
        }),
        ..node(id, x, y, w, h)
    }
}

/// 由地面矩形（hx=hz，即菱形）派生范围的 right 顶点与 AABB 左上角，供命中测试使用。
fn rhombus_marks(cx: f32, cy: f32, half: f32) -> ((f32, f32), (f32, f32)) {
    let ax = crate::isometric_grid::plan::scope_axis_x();
    let ay = crate::isometric_grid::plan::scope_axis_y();
    let rx = ax * 2.0 * half;
    let ry = ay * 2.0 * half;
    ((cx + rx, cy), (cx - rx, cy - ry))
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
fn group_background_does_not_block_member() {
    clear_snapshot();
    let s = scene(
        vec![
            group("g", 0.0, 0.0, 400.0, 300.0, 1),
            node("c", 50.0, 50.0, 100.0, 60.0),
        ],
        vec![],
    );
    let g = accept_scene(&s);
    assert_eq!(
        point_query(g, 70.0, 80.0, 1.0, None).hit,
        Some(PointHit::Node {
            node_id: "c".into()
        })
    );
    assert_eq!(
        point_query(g, 350.0, 250.0, 1.0, None).hit,
        Some(PointHit::Node {
            node_id: "g".into()
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
fn drop_target_uses_real_scope_and_excludes_sources() {
    clear_snapshot();
    // 地面矩形 hx=hz=80 → 菱形，中心 (130,97.5)。
    let g = accept_scene(&scene(
        vec![film_set(
            "fs",
            0.0,
            0.0,
            260.0,
            195.0,
            Some((0.0, 0.0, 260.0, 195.0)),
        )],
        vec![],
    ));
    let ((right_x, right_y), (blank_x, blank_y)) = rhombus_marks(130.0, 97.5, 80.0);
    // 右顶点附近在范围内。
    assert_eq!(
        drop_target_query(g, right_x, right_y, &[]).target_node_id,
        Some("fs".into())
    );
    // AABB 空白角在菱形外：不命中。
    assert_eq!(
        drop_target_query(g, blank_x + 2.0, blank_y + 2.0, &[]).target_node_id,
        None
    );
    // 来源排除：范围内但被排除时不命中。
    assert_eq!(
        drop_target_query(g, 130.0, 97.5, &["fs".to_owned()]).target_node_id,
        None
    );
    // 过期 generation 稳定 stale，不返回目标。
    let stale = drop_target_query(g.wrapping_add(99), 130.0, 97.5, &[]);
    assert!(!stale.available);
    assert!(stale.target_node_id.is_none());
}

#[test]
fn drop_target_fixes_topmost_node_before_business_filter() {
    clear_snapshot();
    // 上层普通卡片（文档顺序靠后）压住片场菱形中心：先固定实际最上层卡片。
    let g = accept_scene(&scene(
        vec![
            film_set("fs", 0.0, 0.0, 260.0, 195.0, Some((0.0, 0.0, 260.0, 195.0))),
            node("card", 60.0, 40.0, 120.0, 80.0),
        ],
        vec![],
    ));
    assert_eq!(
        drop_target_query(g, 130.0, 97.5, &[]).target_node_id,
        Some("card".into())
    );
}

#[test]
fn scope_geometry_query_returns_parallelogram_vertices_and_base() {
    clear_snapshot();
    let g = accept_scene(&scene(
        vec![film_set(
            "fs",
            0.0,
            0.0,
            260.0,
            195.0,
            Some((0.0, 0.0, 260.0, 195.0)),
        )],
        vec![],
    ));
    let result = scope_geometry_query(g);
    assert!(result.available);
    assert_eq!(result.scopes.len(), 1);
    let entry = &result.scopes[0];
    assert_eq!(entry.node_id, "fs");
    assert_eq!(entry.shape, "isometric-diamond");
    // 地面 hx=hz=80 → 菱形顶点在投影轴上。
    let ((right_x, right_y), (blank_x, blank_y)) = rhombus_marks(130.0, 97.5, 80.0);
    assert!((entry.vertices[1][0] - right_x).abs() < 1e-3);
    assert!((entry.vertices[1][1] - right_y).abs() < 1e-3);
    assert!((entry.aabb[0] - blank_x).abs() < 1e-3);
    let axis_ratio =
        crate::isometric_grid::plan::scope_axis_x() / crate::isometric_grid::plan::scope_axis_y();
    assert!((entry.aabb[2] / entry.aabb[3] - axis_ratio).abs() < 1e-3);
    // 基准矩形是内容 fit 矩形，不是 AABB。
    assert_eq!(entry.base, [0.0, 0.0, 260.0, 195.0]);
    // JSON 入口 round-trip（camelCase）。
    let json = scope_geometry_query_json(&format!("{{\"generation\":{g}}}"));
    assert!(json.contains("\"nodeId\":\"fs\""));
    assert!(json.contains("\"shape\":\"isometric-diamond\""));
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

/// 拍摄镜头预览卡片节点（最小合法 `shotPreview` 呈现）。
fn shot_preview_node(id: &str, x: f32, y: f32, width: f32, height: f32) -> GraphNode {
    GraphNode {
        shot_preview: Some(
            serde_json::from_str(
                r#"{"filmSetNodeId":"film","clipId":"clip-1","kind":"dynamic","name":"镜头",
                    "aspect":1.7777778,"duration":5,"state":"ready",
                    "coverCamera":{"azimuth":0,"elevation":0.7,"distance":8,"focusOffset":[0,0,0]}}"#,
            )
            .unwrap(),
        ),
        ..node(id, x, y, width, height)
    }
}

#[test]
fn shot_preview_hits_content_region_only() {
    clear_snapshot();
    // 卡片 (100,200,240,167)：内容区 (116,252,208,99)，与媒体卡片内边距一致。
    let g = accept_scene(&scene(
        vec![shot_preview_node(
            "shot-preview:p",
            100.0,
            200.0,
            240.0,
            167.0,
        )],
        vec![],
    ));
    // 内容区中心 → 拍摄播放入口。
    assert_eq!(
        point_query(g, 220.0, 300.0, 1.0, None).hit,
        Some(PointHit::ShotPreview {
            node_id: "shot-preview:p".into()
        })
    );
    // 标题区（含名称与类型标记）不建立开播候选，回落普通 Node。
    assert_eq!(
        point_query(g, 220.0, 216.0, 1.0, None).hit,
        Some(PointHit::Node {
            node_id: "shot-preview:p".into()
        })
    );
    // 标题下半行、左右与底部留白都不能触发播放。
    for (x, y) in [
        (220.0, 240.0),
        (108.0, 300.0),
        (332.0, 300.0),
        (220.0, 358.0),
    ] {
        assert_eq!(
            point_query(g, x, y, 1.0, None).hit,
            Some(PointHit::Node {
                node_id: "shot-preview:p".into()
            })
        );
    }
    // 普通节点不产生拍摄命中。
    let plain = accept_scene(&scene(vec![node("n", 100.0, 200.0, 240.0, 167.0)], vec![]));
    assert_eq!(
        point_query(plain, 220.0, 300.0, 1.0, None).hit,
        Some(PointHit::Node {
            node_id: "n".into()
        })
    );
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
fn group_resize_uses_accepted_capability_and_shared_rect_through_selection_and_positions() {
    use super::snapshot::{apply_selection, build_snapshot};
    let mut group = group("g", 0., 0., 400., 300., 0);
    group.resizable = false;
    let mut input = scene(vec![group], vec![]);
    input.selection.nodes = vec!["g".into()];
    let mut snapshot = build_snapshot(&input, 1);
    apply_selection(&mut snapshot, &input.selection.nodes);
    assert!(snapshot.nodes[0].resize.is_none());
    input.nodes[0].resizable = true;
    let mut snapshot = build_snapshot(&input, 2);
    apply_selection(&mut snapshot, &input.selection.nodes);
    let corners = crate::canvas_query::layout::resize_corner_rects(0., 0., 400., 300.);
    assert_eq!(
        snapshot.nodes[0].resize,
        Some(crate::canvas_query::scope::corners_grip(corners))
    );
    let generation = accept_scene(&input);
    assert!(matches!(
        point_query(generation, 390., 290., 1., None).hit,
        Some(PointHit::Resize { .. })
    ));
    apply_selection(&mut snapshot, &["g".into(), "other".into()]);
    assert!(snapshot.nodes[0].resize.is_none());
    apply_selection(&mut snapshot, &["g".into()]);
    assert!(snapshot.nodes[0].resize.is_some());
    input.nodes[0].x = 100.;
    input.nodes[0].y = 50.;
    let generation = accept_scene(&input);
    assert!(matches!(
        point_query(generation, 490., 340., 1., None).hit,
        Some(PointHit::Resize { .. })
    ));
}
