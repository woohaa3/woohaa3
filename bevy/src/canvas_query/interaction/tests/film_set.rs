//! 片场（composite asset 范围）命中与框选回归
//! （从 `tests.rs` 拆出以维持单文件体积护栏；复用父模块的场景构造与查询辅助）。

use super::*;

#[test]
fn film_set_hits_scope_only_without_ports() {
    clear_snapshot();
    // 空片场：范围来自节点锚点附近的最小范围（无可见内容）。
    let g = accept_scene(&scene(
        vec![film_set("fs", 0.0, 0.0, 196.0, 64.0, None)],
        vec![],
    ));
    // 节点中心命中范围。
    let center = point_query(g, 98.0, 32.0, 1.0, None);
    assert_eq!(
        center.hit,
        Some(PointHit::FilmScope {
            node_id: "fs".into()
        })
    );
    // 端口位置（右侧中点）不产生 port 命中，若在菱形内仍是范围命中。
    let at_port = point_query(g, 98.0, 32.0, 1.0, None);
    assert_eq!(
        at_port.hit,
        Some(PointHit::FilmScope {
            node_id: "fs".into()
        })
    );
}

#[test]
fn film_set_rect_scope_stays_axis_aligned_without_diamond_expansion() {
    clear_snapshot();
    // 可信矩形覆盖：命中按轴对齐矩形，不被等距菱形替换，也不额外扩张。
    let g = accept_scene(&scene(vec![rect_film_set("fs", 0.0, 0.0, 260.0, 195.0)], vec![]));
    assert_eq!(
        point_query(g, 130.0, 97.5, 1.0, None).hit,
        Some(PointHit::FilmScope { node_id: "fs".into() })
    );
    // 矩形顶点（含边界）命中；圆角外一点不命中。
    assert_eq!(
        point_query(g, 0.0, 0.0, 1.0, None).hit,
        Some(PointHit::FilmScope { node_id: "fs".into() })
    );
    assert_eq!(point_query(g, 260.5, 97.5, 1.0, None).hit, None);
    assert_eq!(point_query(g, 130.0, 195.5, 1.0, None).hit, None);
}

#[test]
fn film_set_scope_yields_to_foreground_card_regardless_of_scroll() {
    clear_snapshot();
    // 上层普通卡片（文档顺序靠后）压住片场菱形中心：先命中最上层卡片，片场不吞前景。
    let g = accept_scene(&scene(
        vec![
            film_set("fs", 0.0, 0.0, 260.0, 195.0, Some((0.0, 0.0, 260.0, 195.0))),
            node("card", 60.0, 40.0, 120.0, 80.0),
        ],
        vec![],
    ));
    assert_eq!(
        point_query(g, 130.0, 97.5, 1.0, None).hit,
        Some(PointHit::Node { node_id: "card".into() })
    );
}

#[test]
fn film_set_scope_hit_is_stable_across_pan_and_zoom_increments() {
    clear_snapshot();
    let g = accept_scene(&scene(
        vec![film_set("fs", 0.0, 0.0, 260.0, 195.0, Some((0.0, 0.0, 260.0, 195.0)))],
        vec![],
    ));
    let ((right_x, right_y), (blank_x, blank_y)) = rhombus_marks(130.0, 97.5, 80.0);
    let baseline = point_query(g, right_x, right_y, 1.0, None).hit;
    assert_eq!(baseline, Some(PointHit::FilmScope { node_id: "fs".into() }));
    // 平移/缩放走纯视口增量：复用世界几何，不引入额外范围扩张，命中结论不变。
    let panned = accept_viewport(
        g,
        crate::protocol::Viewport { x: -420.0, y: 137.0, zoom: 1.75 },
    )
    .expect("viewport accepted");
    assert_eq!(
        point_query(panned, right_x, right_y, 1.75, None).hit,
        baseline
    );
    assert_eq!(point_query(panned, blank_x + 2.0, blank_y + 2.0, 1.75, None).hit, None);
}

#[test]
fn film_set_uses_projected_scope_bounds() {
    clear_snapshot();
    // 内容范围偏离节点卡片；命中按范围几何，卡片原位之外仍可命中范围。
    let g = accept_scene(&scene(
        vec![film_set(
            "fs",
            0.0,
            0.0,
            196.0,
            64.0,
            Some((300.0, 400.0, 120.0, 90.0)),
        )],
        vec![],
    ));
    // 基准矩形中心命中。
    let inside = point_query(g, 360.0, 445.0, 1.0, None);
    assert_eq!(
        inside.hit,
        Some(PointHit::FilmScope {
            node_id: "fs".into()
        })
    );
    let card = point_query(g, 10.0, 10.0, 1.0, None);
    assert_eq!(card.hit, None);
    // 框选覆盖菱形。
    assert!(
        marquee_query(g, 300.0, 400.0, 120.0, 90.0)
            .node_ids
            .contains(&"fs".into())
    );
}

#[test]
fn film_set_diamond_blank_corner_misses_but_edge_hits() {
    clear_snapshot();
    // 地面矩形 hx=hz=80 → 菱形，中心 (130,97.5)。
    let g = accept_scene(&scene(
        vec![film_set("fs", 0.0, 0.0, 260.0, 195.0, Some((0.0, 0.0, 260.0, 195.0)))],
        vec![],
    ));
    let ((right_x, right_y), (blank_x, blank_y)) = rhombus_marks(130.0, 97.5, 80.0);
    // AABB 左上空白角在菱形外：不命中。
    assert_eq!(point_query(g, blank_x + 2.0, blank_y + 2.0, 1.0, None).hit, None);
    // 右顶点边界包含。
    assert_eq!(
        point_query(g, right_x, right_y, 1.0, None).hit,
        Some(PointHit::FilmScope { node_id: "fs".into() })
    );
    // 中心命中。
    assert_eq!(
        point_query(g, 130.0, 97.5, 1.0, None).hit,
        Some(PointHit::FilmScope { node_id: "fs".into() })
    );
}

#[test]
fn film_set_marquee_uses_real_diamond_positive_area() {
    clear_snapshot();
    let g = accept_scene(&scene(
        vec![film_set("fs", 0.0, 0.0, 260.0, 195.0, Some((0.0, 0.0, 260.0, 195.0)))],
        vec![],
    ));
    let ((_rx, _ry), (blank_x, blank_y)) = rhombus_marks(130.0, 97.5, 80.0);
    // AABB 左上空白角：仅触 AABB，不与菱形正面积交叠 → 不选中。
    assert!(!marquee_query(g, blank_x, blank_y, 6.0, 6.0).node_ids.contains(&"fs".into()));
    // 覆盖中心 → 选中。
    assert!(marquee_query(g, 100.0, 70.0, 60.0, 60.0).node_ids.contains(&"fs".into()));
    // 反向拖框仍选中。
    assert!(marquee_query(g, 200.0, 160.0, -60.0, -60.0).node_ids.contains(&"fs".into()));
}

#[test]
fn film_set_selected_exposes_eight_handles_not_aabb_corner() {
    clear_snapshot();
    let mut s = scene(
        vec![film_set("fs", 0.0, 0.0, 260.0, 195.0, Some((0.0, 0.0, 260.0, 195.0)))],
        vec![],
    );
    s.selection = Selection {
        nodes: vec!["fs".into()],
        edge: None,
    };
    let g = accept_scene(&s);
    let ((right_x, right_y), (blank_x, blank_y)) = rhombus_marks(130.0, 97.5, 80.0);
    // 右顶点命中 resize 抓手。
    assert_eq!(
        point_query(g, right_x, right_y, 1.0, None).hit,
        Some(PointHit::Resize {
            node_id: "fs".into(),
            handle: Some("e".into())
        })
    );
    // AABB 空白角不暴露不可见 resize 命中。
    assert_eq!(point_query(g, blank_x + 2.0, blank_y + 2.0, 1.0, None).hit, None);
    // 未选中节点不暴露抓手（重新接受未选中场景）。
    let unselected = accept_scene(&scene(
        vec![film_set("fs", 0.0, 0.0, 260.0, 195.0, Some((0.0, 0.0, 260.0, 195.0)))],
        vec![],
    ));
    assert_eq!(
        point_query(unselected, right_x, right_y, 1.0, None).hit,
        Some(PointHit::FilmScope { node_id: "fs".into() })
    );
}

#[test]
fn film_set_not_connectable_by_probe() {
    clear_snapshot();
    let g = accept_scene(&scene(
        vec![
            node("a", 0.0, 0.0, 100.0, 50.0),
            film_set("fs", 400.0, 0.0, 196.0, 64.0, None),
        ],
        vec![],
    ));
    let candidates = probe_query(g, "a", "next").candidates;
    let target = candidates
        .iter()
        .find(|candidate| candidate.node_id == "fs");
    assert!(target.is_some_and(|candidate| !candidate.connectable));
}

#[test]
fn film_set_tall_model_body_above_scope_is_pickable_but_not_a_drop_target() {
    clear_snapshot();
    // 小地面、较高的片场：地面菱形只到基准矩形底部附近，模型身体投影在其上方。
    let mut node = film_set("fs", 0.0, 0.0, 80.0, 400.0, Some((0.0, 0.0, 80.0, 400.0)));
    node.composite_asset.as_mut().unwrap().scope_ground = Some(crate::protocol::ScopeGroundDto {
        cx: 40.0,
        cy: 360.0,
        hx: 8.0,
        hz: 8.0,
    });
    let scope = crate::canvas_query::scope::node_scope(&node);
    assert!(scope.aabb.y > 300.0);
    let g = accept_scene(&scene(vec![node], vec![]));
    // 范围顶部之上的模型身体可点选。
    assert_eq!(
        point_query(g, 40.0, 300.0, 1.0, None).hit,
        Some(PointHit::FilmScope { node_id: "fs".into() })
    );
    // AABB 内、平行四边形外的空白角仍不命中。
    assert_eq!(
        point_query(g, scope.aabb.x + 2.0, scope.aabb.y + 2.0, 1.0, None).hit,
        None
    );
    // drop 仍只认地面范围，不因上方身体可点选而接收素材。
    assert_eq!(drop_target_query(g, 40.0, 300.0, &[]).target_node_id, None);
}
