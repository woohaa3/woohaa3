//! 空间候选查询的等价性与局部性回归
//! （change: 2026-10-23-scale-canvas-media-residency，design D7 / 任务 7.3、7.5）。
//!
//! 空间网格只缩小遍历范围，**不得**改变命中结果、z 顺序或文档顺序。这里用独立的暴力实现
//! 对照 indexed 查询，并断言候选数量局部化（不是靠「结果一样但仍在全量扫描」蒙过）。

use super::*;
use crate::canvas_query::interaction::snapshot::{apply_selection, build_snapshot};

/// 千节点网格场景：`count` 个卡片按 40 列铺开，间距 300。
fn grid_scene(count: usize) -> Scene {
    let nodes: Vec<GraphNode> = (0..count)
        .map(|index| {
            node(
                &format!("n{index}"),
                (index % 40) as f32 * 300.0,
                (index / 40) as f32 * 300.0,
                200.0,
                150.0,
            )
        })
        .collect();
    scene(nodes, vec![])
}

/// 与索引无关的暴力点命中：只按节点本体判定（用于对照）。
fn brute_force_node_hit(snapshot: &crate::canvas_query::interaction::snapshot::InteractionSnapshot, world: Vec2) -> Option<String> {
    snapshot
        .order
        .iter()
        .filter_map(|index| snapshot.nodes.get(*index))
        .filter(|node| !node.ghost)
        .find(|node| crate::canvas_query::layout::in_rect(world, node.bounds))
        .map(|node| node.id.clone())
}

#[test]
fn point_hits_on_a_thousand_nodes_match_brute_force() {
    clear_snapshot();
    let generation = accept_scene(&grid_scene(1000));
    for (x, y) in [(0.0, 0.0), (123.0, 77.0), (5_000.0, 3_500.0), (10_000.0, 8_000.0), (-40.0, -40.0)] {
        let hit = point_query(generation, x, y, 1.0, None).hit;
        let node_hit = match hit {
            Some(PointHit::Node { node_id }) => Some(node_id),
            Some(other) => panic!("unexpected hit at ({x}, {y}): {other:?}"),
            None => None,
        };
        // 对照：用同一快照的全量顺序重新判定节点本体命中。
        let expected = with_snapshot(generation, |snapshot| brute_force_node_hit(snapshot, Vec2::new(x, y)))
            .expect("snapshot");
        assert_eq!(node_hit, expected, "point ({x}, {y}) 必须与全量扫描一致");
    }
}

#[test]
fn overlapping_cards_keep_topmost_hit_with_spatial_candidates() {
    clear_snapshot();
    // 三个完全重叠的卡片：后绘制者（文档序更后）优先。
    let generation = accept_scene(&scene(
        vec![
            node("a", 100.0, 100.0, 200.0, 150.0),
            node("b", 100.0, 100.0, 200.0, 150.0),
            node("c", 100.0, 100.0, 200.0, 150.0),
        ],
        vec![],
    ));
    assert_eq!(
        point_query(generation, 200.0, 175.0, 1.0, None).hit,
        Some(PointHit::Node { node_id: "c".into() })
    );
}

#[test]
fn marquee_on_a_thousand_nodes_matches_document_order_scan() {
    clear_snapshot();
    let generation = accept_scene(&grid_scene(1000));
    let (x, y, width, height) = (250.0, 120.0, 400.0, 500.0);
    let indexed = marquee_query(generation, x, y, width, height).node_ids;
    let expected = with_snapshot(generation, |snapshot| {
        let left = x.min(x + width);
        let right = x.max(x + width);
        let top = y.min(y + height);
        let bottom = y.max(y + height);
        snapshot
            .nodes
            .iter()
            .filter(|node| !node.ghost)
            .filter(|node| match &node.scope {
                Some(scope) => crate::canvas_query::scope::intersects_rect(
                    scope,
                    crate::canvas_query::scope::ScopeRect { x: left, y: top, width: right - left, height: bottom - top },
                ),
                None => {
                    let (nx, ny, nw, nh) = node.bounds;
                    nx < right && nx + nw > left && ny < bottom && ny + nh > top
                }
            })
            .map(|node| node.id.clone())
            .collect::<Vec<String>>()
    })
    .expect("snapshot");
    assert_eq!(indexed, expected);
    assert!(!indexed.is_empty(), "框选必须命中样例节点");
    // 文档顺序（不是空间顺序）：`n1`（第 2 列）必须排在 `n41`（下一行）之前。
    let position = |id: &str| indexed.iter().position(|entry| entry == id);
    if let (Some(first), Some(second)) = (position("n1"), position("n41")) {
        assert!(first < second, "框选结果必须保持文档顺序");
    }
}

#[test]
fn probe_candidates_match_full_scan_on_one_side_only() {
    clear_snapshot();
    let generation = accept_scene(&grid_scene(1000));
    let next = probe_query(generation, "n21", "next").candidates;
    let prev = probe_query(generation, "n21", "prev").candidates;
    let expected = with_snapshot(generation, |snapshot| {
        let source = snapshot.nodes.iter().find(|node| node.id == "n21").expect("source");
        let next = snapshot
            .nodes
            .iter()
            .filter(|node| node.id != "n21" && !node.ghost && node.center.x > source.center.x)
            .map(|node| node.id.clone())
            .collect::<Vec<String>>();
        let prev = snapshot
            .nodes
            .iter()
            .filter(|node| node.id != "n21" && !node.ghost && node.center.x < source.center.x)
            .map(|node| node.id.clone())
            .collect::<Vec<String>>();
        (next, prev)
    })
    .expect("snapshot");
    assert_eq!(next.iter().map(|candidate| candidate.node_id.clone()).collect::<Vec<String>>(), expected.0);
    assert_eq!(prev.iter().map(|candidate| candidate.node_id.clone()).collect::<Vec<String>>(), expected.1);
    assert!(!next.is_empty());
}

#[test]
fn position_increments_relocate_spatial_candidates_without_full_rebuild() {
    clear_snapshot();
    let base = accept_scene(&grid_scene(200));
    let request = crate::protocol::PositionUpdateRequest {
        version: crate::protocol::CANVAS_POSITION_UPDATE_VERSION.to_owned(),
        base_scene_generation: base,
        positions: vec![
            crate::protocol::NodePosition { id: "n0".into(), x: 9_000.0, y: 9_000.0 },
            crate::protocol::NodePosition { id: "n1".into(), x: -9_000.0, y: -9_000.0 },
        ],
        viewport: None,
    };
    let generation = accept_positions(&request).expect("accept positions").0;
    // 旧位置不再命中，新位置命中：证明网格条目跟着走了。
    assert_eq!(point_query(generation, 20.0, 20.0, 1.0, None).hit, None);
    assert_eq!(
        point_query(generation, 9_100.0, 9_100.0, 1.0, None).hit,
        Some(PointHit::Node { node_id: "n0".into() })
    );
    assert_eq!(
        point_query(generation, -8_950.0, -8_950.0, 1.0, None).hit,
        Some(PointHit::Node { node_id: "n1".into() })
    );
    // 未移动的邻近节点仍然命中。
    assert_eq!(
        point_query(generation, 620.0, 20.0, 1.0, None).hit,
        Some(PointHit::Node { node_id: "n2".into() })
    );
}

#[test]
fn point_candidates_are_local_instead_of_document_wide() {
    clear_snapshot();
    let scene = grid_scene(1000);
    let snapshot = build_snapshot(&scene, 1);
    let candidates = snapshot.point_node_candidates(Vec2::new(150.0, 75.0), 1.0);
    assert!(!candidates.is_empty());
    // 局部化门槛：命中点附近的候选必须远少于文档规模（这里用 1/20 的宽松上界）。
    assert!(
        candidates.len() * 20 < scene.nodes.len(),
        "候选应局部化，实际 {} / {}",
        candidates.len(),
        scene.nodes.len()
    );
}

#[test]
fn selection_resize_handles_still_hit_after_indexing() {
    clear_snapshot();
    let mut scene = grid_scene(5);
    scene.selection = crate::protocol::Selection { nodes: vec!["n0".into()], edge: None };
    let snapshot = build_snapshot(&scene, 1);
    let mut snapshot = snapshot;
    apply_selection(&mut snapshot, &scene.selection.nodes);
    assert!(snapshot.nodes[0].resize.is_some());
}
