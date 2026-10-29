//! 内部对象索引与总览位置增量的边界
//! （change: 2026-10-14-scope-film-set-object-picking-to-focus，任务 2.2 / design D2/D3）。
//!
//! 这些回归固定三件事：
//! - 总览位置增量**不**平移或维护内部对象候选（design D3）；
//! - 退出后移动对象再重新聚焦，从最新接受场景重建最新坐标（不复活旧基线）；
//! - 跨目标读取不返回旧目标数据（design D2）。

use super::{
    FilmSetItemCandidate, accept_items, clear_items, current_candidates, item_bounds_query_json,
    work,
};
use crate::canvas_query::interaction::{accept_positions, accept_scene, point_query};
use crate::protocol::{CANVAS_POSITION_UPDATE_VERSION, NodePosition, PositionUpdateRequest, Scene};

fn film_set_scene(node_id: &str) -> Scene {
    Scene {
        nodes: serde_json::from_value(serde_json::json!([
            {"id": node_id, "type": "model", "x": 0, "y": 0,
             "compositeAsset": {"x": 0, "y": 0, "width": 260, "height": 195}}
        ]))
        .unwrap(),
        ..Default::default()
    }
}

fn candidate(node_id: &str, item_id: &str, min: [f32; 3], max: [f32; 3]) -> FilmSetItemCandidate {
    FilmSetItemCandidate {
        node_id: node_id.into(),
        item_id: item_id.into(),
        min,
        max,
        unit: 2.,
        yaw: 0.7,
        world_to_local: Some([1.; 9]),
        plane_inverse: None,
    }
}

fn request(base: u32, id: &str, x: f32, y: f32) -> PositionUpdateRequest {
    PositionUpdateRequest {
        version: CANVAS_POSITION_UPDATE_VERSION.into(),
        base_scene_generation: base,
        positions: vec![NodePosition {
            id: id.into(),
            x,
            y,
        }],
        viewport: None,
    }
}

/// 总览位置增量不改变内部对象候选（既不平移也不清空基线）。
#[test]
fn overview_position_increments_never_touch_internal_candidates() {
    clear_items();
    let base = accept_scene(&film_set_scene("film"));
    crate::canvas_query::model_pick::accept_models(Vec::new(), base, Default::default());
    let item = candidate("film", "obj", [-10.; 3], [10.; 3]);
    accept_items(Some("film".into()), vec![item.clone()], 4);
    let builds_before = work().builds;

    for i in 0..50 {
        let (generation, _) =
            accept_positions(&request(base, "film", i as f32 * 0.13, i as f32 * -0.17)).unwrap();
        assert_eq!(current_candidates()[0], item);
        assert!(point_query(generation, 0., 0., 1., None).available);
    }
    assert_eq!(work().builds, builds_before, "总览位置增量不得重建内部候选");
}

/// 退出聚焦后移动对象，再重新聚焦：候选来自最新接受场景（不复活退出前坐标）。
#[test]
fn refocusing_after_overview_move_rebuilds_latest_coordinates() {
    clear_items();
    let base = accept_scene(&film_set_scene("film"));
    crate::canvas_query::model_pick::accept_models(Vec::new(), base, Default::default());
    accept_items(
        Some("film".into()),
        vec![candidate("film", "obj", [-10.; 3], [10.; 3])],
        0,
    );

    // 退出到总览：关闭状态，旧候选清除。
    accept_items(None, Vec::new(), 0);
    assert!(item_bounds_query_json("{\"nodeId\":\"film\"}").contains("\"available\":false"));

    // 总览移动（位置增量）不影响已关闭状态。
    accept_positions(&request(base, "film", 40., 25.)).unwrap();
    assert!(item_bounds_query_json("{\"nodeId\":\"film\"}").contains("\"available\":false"));

    // 重新聚焦：由最新接受场景派生最新坐标。
    let moved = candidate("film", "obj", [30.; 3], [50.; 3]);
    accept_items(Some("film".into()), vec![moved.clone()], 0);
    assert_eq!(current_candidates()[0], moved);
    let bounds = item_bounds_query_json("{\"nodeId\":\"film\"}");
    assert!(bounds.contains("\"available\":true"));
    assert!(bounds.contains("\"center\":[40.0,40.0,40.0]"), "{bounds}");
}

/// 跨目标读取：A 的查询不返回 B 的候选，也不返回 A 的旧数据。
#[test]
fn cross_target_reads_never_return_other_or_stale_items() {
    clear_items();
    accept_items(
        Some("a".into()),
        vec![candidate("a", "a-obj", [-1.; 3], [1.; 3])],
        0,
    );
    assert!(item_bounds_query_json("{\"nodeId\":\"a\"}").contains("\"itemId\":\"a-obj\""));
    assert!(item_bounds_query_json("{\"nodeId\":\"b\"}").contains("\"available\":false"));
    accept_items(
        Some("b".into()),
        vec![candidate("b", "b-obj", [-2.; 3], [2.; 3])],
        0,
    );
    assert!(item_bounds_query_json("{\"nodeId\":\"a\"}").contains("\"available\":false"));
    let b = item_bounds_query_json("{\"nodeId\":\"b\"}");
    assert!(b.contains("\"itemId\":\"b-obj\""), "{b}");
}

/// 合法空目标：可用但无命中；不因空候选被误判为关闭。
#[test]
fn accepted_empty_target_stays_available() {
    clear_items();
    accept_items(Some("empty".into()), Vec::new(), 0);
    let bounds = item_bounds_query_json("{\"nodeId\":\"empty\"}");
    assert!(bounds.contains("\"available\":true"), "{bounds}");
    assert!(bounds.contains("\"items\":[]"), "{bounds}");
}

/// 未接受场景（新 realm 未就绪/重放前）：查询不可用。
#[test]
fn unaccepted_realm_reports_unavailable() {
    clear_items();
    assert!(item_bounds_query_json("{\"nodeId\":\"film\"}").contains("\"available\":false"));
}

/// 非法位置增量原子拒绝：不部分改动索引或内部候选。
#[test]
fn invalid_position_increment_keeps_internal_index_untouched() {
    clear_items();
    let base = accept_scene(&film_set_scene("film"));
    crate::canvas_query::model_pick::accept_models(Vec::new(), base, Default::default());
    let item = candidate("film", "obj", [-10.; 3], [10.; 3]);
    accept_items(Some("film".into()), vec![item.clone()], 0);
    let mut update = request(base, "film", 5., 5.);
    update.positions.push(NodePosition {
        id: "missing".into(),
        x: f32::MAX,
        y: f32::MAX,
    });
    assert!(accept_positions(&update).is_err());
    assert_eq!(current_candidates()[0], item);
}
