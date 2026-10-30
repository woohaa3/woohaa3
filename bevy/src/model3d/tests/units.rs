//! 纯函数/单实体单元测试：颜色、transform、mesh key、锚点
//! （change: refactor-bevy-rust-file-size，任务 4.1 / design D4）。

use super::super::layout::{MODEL_CARD_GAP, model_anchor, model_transform_signature, model_unit};
use super::super::mesh::mesh_key;
use super::super::scene::ModelGeometry;
use super::super::{grid, scene};
use crate::protocol::{GraphNode, ModelOp, ModelPlacement, ModelSnapshot};
use bevy::prelude::*;

#[test]
fn transform_signature_tracks_position_and_placement() {
    let model = ModelSnapshot {
        scene_version: Some("woohaa-model-scene-ir-v1".to_owned()),
        ops: vec![],
        signature: "sig".into(),
        extent: 1.0,
        aabb: None,
        geometry_keys: None,
        prepared_bounds: None,
        placement: ModelPlacement::default(),
    };
    let node = GraphNode {
        model_preview: None,
        id: "n".into(),
        kind: "model".into(),
        x: 10.0,
        y: 20.0,
        width: 224.0,
        height: 116.0,
        body: String::new(),
        title: String::new(),
        type_label: String::new(),
        progress: 0.0,
        busy: false,
        texture: false,
        media_loading: false,
        resizable: false,
        ghost: false,
        card_label: None,
        group: None,
        model: None,
        composite_asset: None,
        history_strip: None,
        aggregate_run: None,
        preview_card: None,
        run_feedback: None,
    };
    let a = model_transform_signature(&model, &ModelPlacement::default(), &node);
    let placed = ModelPlacement {
        offset: crate::protocol::ModelOffset {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        },
        scale: 1.0,
        yaw: 0.0,
    };
    let b = model_transform_signature(&model, &placed, &node);
    // 根 transform identity 不包含 model.signature（内容）；内容替换与根刷新分离。
    let c = ModelSnapshot {
        signature: "other".into(),
        ..model.clone()
    };
    let d = model_transform_signature(&c, &ModelPlacement::default(), &node);
    assert_ne!(a, b);
    assert_eq!(a, d);
}

#[test]
fn mesh_key_is_stable_for_same_geometry() {
    assert_eq!(
        mesh_key(&ModelGeometry::Sphere { radius: 0.25 }),
        mesh_key(&ModelGeometry::Sphere { radius: 0.25 })
    );
    assert_ne!(
        mesh_key(&ModelGeometry::Sphere { radius: 0.25 }),
        mesh_key(&ModelGeometry::Sphere { radius: 0.5 })
    );
}

#[test]
fn material_key_prefers_material_reference() {
    let op = ModelOp::Sphere {
        id: "s".into(),
        parent: None,
        position: [0.0; 3],
        rotation: [0.0; 3],
        scale: [1.0; 3],
        color: Some("#ff0000".into()),
        material: Some("armor".into()),
        radius: 0.2,
    };
    assert_eq!(scene::material_key(&op), "material:armor");
}

/// 内容 identity 与根 transform identity 分离（任务 1.1 / design D4）。
#[test]
fn content_and_transform_identity_are_independent() {
    let node = |id: &str| GraphNode {
        model_preview: None,
        id: id.into(),
        kind: "model".into(),
        x: 0.0,
        y: 0.0,
        width: 224.0,
        height: 116.0,
        body: String::new(),
        title: String::new(),
        type_label: String::new(),
        progress: 0.0,
        busy: false,
        texture: false,
        media_loading: false,
        resizable: false,
        ghost: false,
        card_label: None,
        group: None,
        model: None,
        composite_asset: None,
        history_strip: None,
        aggregate_run: None,
        preview_card: None,
        run_feedback: None,
    };
    let v2_before = ModelSnapshot {
        scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
        ops: vec![],
        signature: "v2-sig-a".into(),
        extent: 3.0,
        aabb: None,
        geometry_keys: None,
        prepared_bounds: None,
        placement: ModelPlacement::default(),
    };
    let v2_after = ModelSnapshot {
        signature: "v2-sig-b".into(),
        ..v2_before.clone()
    };
    // 内容签名变化（Scene IR）在根 transform identity 上不可见。
    assert_eq!(
        model_transform_signature(&v2_before, &ModelPlacement::default(), &node("v2")),
        model_transform_signature(&v2_after, &ModelPlacement::default(), &node("v2"))
    );
    // placement 变化属于根 transform identity。
    let placed = ModelPlacement {
        offset: Default::default(),
        scale: 2.0,
        yaw: 0.5,
    };
    assert_ne!(
        model_transform_signature(&v2_before, &ModelPlacement::default(), &node("v2")),
        model_transform_signature(&v2_before, &placed, &node("v2"))
    );
}
/// 重复 shape 复用同一 mesh key（任务 4.2）：同尺寸关节不线性创建重复资源。
#[test]
fn repeated_shapes_share_mesh_key() {
    let joint = ModelGeometry::Sphere { radius: 0.22 };
    assert_eq!(
        mesh_key(&joint),
        mesh_key(&ModelGeometry::Sphere { radius: 0.22 })
    );
    let keys: std::collections::HashSet<String> = (0..10).map(|_| mesh_key(&joint)).collect();
    assert_eq!(keys.len(), 1, "重复 shape 应共享同一 mesh key");
}

/// 卡片不与模型重叠（change: 卡片与模型不重叠）：模型顶部投影到卡片底部下方固定间距。
#[test]
fn model_anchor_keeps_card_above_model_top() {
    let node = GraphNode {
        model_preview: None,
        id: "m".into(),
        kind: "model".into(),
        x: 100.0,
        y: 200.0,
        width: 260.0,
        height: 195.0,
        body: String::new(),
        title: String::new(),
        type_label: String::new(),
        progress: 0.0,
        busy: false,
        texture: false,
        media_loading: false,
        resizable: false,
        ghost: false,
        card_label: None,
        group: None,
        model: None,
        composite_asset: None,
        history_strip: None,
        aggregate_run: None,
        preview_card: None,
        run_feedback: None,
    };
    // 高模型：0..4 单位的 box（unit 缩放到世界）。
    let model = ModelSnapshot {
        scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
        ops: vec![ModelOp::Box {
            id: "body".into(),
            parent: None,
            position: [0.0, 2.0, 0.0],
            rotation: [0.0; 3],
            scale: [1.0; 3],
            color: Some("#ffffff".into()),
            material: None,
            size: [1.0, 4.0, 1.0],
        }],
        signature: "sig".into(),
        extent: 4.0,
        aabb: None,
        geometry_keys: None,
        prepared_bounds: None,
        placement: ModelPlacement::default(),
    };
    let placement = ModelPlacement::default();
    let unit = model_unit(&node, &model, &placement);
    let view_rotation = grid::view_rotation();
    let anchor = model_anchor(&node, &model, &placement, unit);
    // 画布屏幕 y 向下坐标（y 轴翻转后）。
    let anchor_screen_y = -(view_rotation * anchor).y;

    // 卡片底部（屏幕 y 向下）：node.y + node.height。
    let card_bottom = node.y + node.height;
    let top = scene::model_world_aabb(&model, view_rotation, unit)
        .unwrap()
        .max[1];
    let model_top_screen_y = anchor_screen_y - top;
    let gap = model_top_screen_y - card_bottom;
    assert!(
        (gap - MODEL_CARD_GAP).abs() < 0.5,
        "gap {gap} 应约等于 {MODEL_CARD_GAP}"
    );
    // 模型整体位于卡片下方：模型顶部不高于卡片底部。
    assert!(
        model_top_screen_y >= card_bottom,
        "模型顶部不应高于卡片底部"
    );
}

/// 空模型（无几何）回退到既有固定偏移，不发生 NaN。
#[test]
fn model_anchor_falls_back_for_empty_model() {
    let node = GraphNode {
        model_preview: None,
        id: "m".into(),
        kind: "model".into(),
        x: 0.0,
        y: 0.0,
        width: 260.0,
        height: 195.0,
        body: String::new(),
        title: String::new(),
        type_label: String::new(),
        progress: 0.0,
        busy: false,
        texture: false,
        media_loading: false,
        resizable: false,
        ghost: false,
        card_label: None,
        group: None,
        model: None,
        composite_asset: None,
        history_strip: None,
        aggregate_run: None,
        preview_card: None,
        run_feedback: None,
    };
    let model = ModelSnapshot {
        scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
        ops: vec![],
        signature: "empty".into(),
        extent: 1.0,
        aabb: None,
        geometry_keys: None,
        prepared_bounds: None,
        placement: ModelPlacement::default(),
    };
    let placement = ModelPlacement::default();
    let unit = model_unit(&node, &model, &placement);
    let anchor = model_anchor(&node, &model, &placement, unit);
    assert!(anchor.x.is_finite() && anchor.y.is_finite());
}

/// 组形象在固定徽章内居中，模型比例不改变徽章锚点。
#[test]
fn group_anchor_centers_model_inside_bottom_footer() {
    let node = GraphNode {
        model_preview: None,
        id: "group".into(),
        kind: "group".into(),
        x: 100.0,
        y: 200.0,
        width: 500.0,
        height: 400.0,
        body: String::new(),
        title: String::new(),
        type_label: String::new(),
        progress: 0.0,
        busy: false,
        texture: false,
        media_loading: false,
        resizable: false,
        ghost: false,
        card_label: None,
        group: Some(crate::protocol::GroupPresentation {
            collapsed: false,
            badge_scale: 1.,
            badge_resizable: false,
            action_bar: false,
            title: String::new(),
            member_count: 0,
            output_capable_leaf_count: 0,
            model_bounds: None,
            run_status: None,
            geometry_quality: None,
            drop_target: false,
        }),
        model: None,
        composite_asset: None,
        history_strip: None,
        aggregate_run: None,
        preview_card: None,
        run_feedback: None,
    };
    let model = ModelSnapshot {
        scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
        ops: vec![ModelOp::Box {
            id: "body".into(),
            parent: None,
            position: [3.0, 1.0, -2.0],
            rotation: [0.0; 3],
            scale: [1.0; 3],
            color: Some("#ffffff".into()),
            material: None,
            size: [1.0, 2.0, 1.0],
        }],
        signature: "group-default".into(),
        extent: 2.0,
        aabb: None,
        geometry_keys: None,
        prepared_bounds: None,
        placement: ModelPlacement::default(),
    };
    let placement = ModelPlacement::default();
    let unit = model_unit(&node, &model, &placement);
    let anchor = model_anchor(&node, &model, &placement, unit);
    let rotation = grid::view_rotation();
    let anchor_canvas = rotation * anchor;
    let local = scene::model_world_aabb(&model, rotation, unit).expect("group model bounds");
    let center_y = -(anchor_canvas.y + (local.min[1] + local.max[1]) / 2.);
    let center_x = anchor_canvas.x + (local.min[0] + local.max[0]) / 2.0;
    // 组徽标位于气泡结构矩形下方的独立徽标区域；模型光学中心跟随徽标中心。
    let badge = crate::canvas_query::group_model::badge_rect(&node);
    assert!((center_y - (badge.y + badge.w / 2.)).abs() < 0.5);
    assert!((center_x - (node.x + node.width / 2.0)).abs() < 0.5);
    assert!(local.max[0] - local.min[0] <= node.width);
    assert!(local.max[1] - local.min[1] <= node.height);
    assert!(
        local.max[0] - local.min[0] <= crate::canvas_query::group_model::MODEL_MAX_WIDTH + 0.01
    );
    assert!(
        local.max[1] - local.min[1] <= crate::canvas_query::group_model::MODEL_MAX_HEIGHT + 0.01
    );
}

/// 片场（composite-asset）：没有卡片，模型锚定在节点矩形**中心**（无朝下偏移），且模型投影
/// 高度不超过节点矩形（范围框罩住模型）。change: 2026-10-08-make-film-set-model-only 修订。
#[test]
fn film_set_anchor_centers_model_within_node() {
    let node = GraphNode {
        model_preview: None,
        id: "film".into(),
        kind: "model".into(),
        x: 100.0,
        y: 200.0,
        width: 260.0,
        height: 195.0,
        body: String::new(),
        title: String::new(),
        type_label: String::new(),
        progress: 0.0,
        busy: false,
        texture: false,
        media_loading: false,
        resizable: false,
        ghost: false,
        card_label: None,
        group: None,
        model: None,
        composite_asset: Some(crate::protocol::CompositeAssetPresentation {
            panel: None,
            root_placement: None,
            content_extent: None,
            layout_aabb: None,
            empty_placeholder: None,
            geometry_quality: None,
            scope_shape: crate::protocol::CompositeAssetScopeShape::Rect,
            scope_ground: None,
            x: 100.0,
            y: 200.0,
            width: 260.0,
            height: 195.0,
            media_planes: Vec::new(),
            item_roots: std::collections::HashMap::new(),
            item_placements: std::collections::HashMap::new(),
        }),
        history_strip: None,
        aggregate_run: None,
        preview_card: None,
        run_feedback: None,
    };
    // 高模型：0..4 单位的 box（unit 缩放到世界）。
    let model = ModelSnapshot {
        scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
        ops: vec![ModelOp::Box {
            id: "body".into(),
            parent: None,
            position: [0.0, 2.0, 0.0],
            rotation: [0.0; 3],
            scale: [1.0; 3],
            color: Some("#ffffff".into()),
            material: None,
            size: [1.0, 4.0, 1.0],
        }],
        signature: "sig".into(),
        extent: 4.0,
        aabb: None,
        geometry_keys: None,
        prepared_bounds: None,
        placement: ModelPlacement::default(),
    };
    let placement = ModelPlacement::default();
    let unit = model_unit(&node, &model, &placement);
    let anchor = model_anchor(&node, &model, &placement, unit);
    let layout_rotation = grid::view_rotation();
    // `model_world_aabb` 的 AABB 已在屏幕对齐坐标系（layout_rotation 已应用，y 向上）。
    let aabb = scene::model_world_aabb(&model, layout_rotation, unit).unwrap();
    let center = aabb.center();
    // 锚点画布坐标（y 向下）。
    let anchor_q = layout_rotation * anchor;
    let anchor_canvas = Vec2::new(anchor_q.x, -anchor_q.y);
    // 模型中心画布坐标：屏幕对齐中心偏移 (center.x, -center.y) 加锚点。
    let screen_center = Vec2::new(anchor_canvas.x + center.x, anchor_canvas.y - center.y);
    let node_center = Vec2::new(node.x + node.width / 2.0, node.y + node.height / 2.0);
    assert!(
        (screen_center - node_center).length() < 0.5,
        "片场模型中心 {screen_center:?} 应对齐节点中心 {node_center:?}"
    );
    // 模型投影尺寸不超过节点矩形（去掉固定边距后有富余）。
    let projected_h = aabb.max[1] - aabb.min[1];
    assert!(
        projected_h <= node.height,
        "模型投影高度 {projected_h} 不应超过节点高度 {}",
        node.height
    );
}

/// 固定世界不变式：同一内容/placement 派生稳定 unit/anchor/AABB；真实 scale 改变才改变 bounds
/// （change: make-shot-framing-zoom-invariant，任务 5.1）。
#[test]
fn model_world_is_stable_and_scale_sensitive() {
    let node = GraphNode {
        model_preview: None,
        id: "m".into(),
        kind: "model".into(),
        x: 100.0,
        y: 200.0,
        width: 260.0,
        height: 195.0,
        body: String::new(),
        title: String::new(),
        type_label: String::new(),
        progress: 0.0,
        busy: false,
        texture: false,
        media_loading: false,
        resizable: false,
        ghost: false,
        card_label: None,
        group: None,
        model: None,
        composite_asset: None,
        history_strip: None,
        aggregate_run: None,
        preview_card: None,
        run_feedback: None,
    };
    let model = ModelSnapshot {
        scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
        ops: vec![ModelOp::Box {
            id: "body".into(),
            parent: None,
            position: [0.0, 2.0, 0.0],
            rotation: [0.0, 0.0, 0.0],
            scale: [1.0; 3],
            color: Some("#ffffff".into()),
            material: None,
            size: [1.0, 4.0, 1.0],
        }],
        signature: "sig".into(),
        extent: 4.0,
        aabb: None,
        geometry_keys: None,
        prepared_bounds: None,
        placement: ModelPlacement::default(),
    };
    let placement = ModelPlacement {
        offset: crate::protocol::ModelOffset {
            x: 0.5,
            y: 0.25,
            z: -0.1,
        },
        scale: 1.3,
        yaw: 35.0,
    };
    // 派生函数只接受内容与 placement：同输入多次派生逐位稳定。
    let unit = model_unit(&node, &model, &placement);
    let anchor = model_anchor(&node, &model, &placement, unit);
    let aabb = super::super::layout::model_world_aabb_for_node(&model, &placement, &node).unwrap();
    assert!(unit.is_finite() && unit > 0.0);
    assert_eq!(
        anchor,
        model_anchor(
            &node,
            &model,
            &placement,
            model_unit(&node, &model, &placement)
        )
    );
    assert_eq!(
        aabb.min,
        super::super::layout::model_world_aabb_for_node(&model, &placement, &node)
            .unwrap()
            .min
    );
    // 真实 placement.scale 改变确实改变世界 bounds 与半径。
    let scaled = ModelPlacement {
        scale: placement.scale * 2.0,
        ..placement
    };
    let scaled_aabb =
        super::super::layout::model_world_aabb_for_node(&model, &scaled, &node).unwrap();
    let radius = |a: crate::model3d::scene::ModelAabb| {
        (bevy::prelude::Vec3::from_array(a.max) - bevy::prelude::Vec3::from_array(a.min)).length()
            * 0.5
    };
    assert!(
        (radius(scaled_aabb) - radius(aabb) * 2.0).abs() < 1e-2,
        "scale 改变应翻倍世界半径"
    );
}

/// `offset.z` 保留在协议与内容身份里，但不再参与画布观察深度
/// （change: 2026-10-27-order-canvas-layers-by-ground-anchor，design D1/D5）。
#[test]
fn placement_offset_z_never_moves_canvas_anchor() {
    let node: GraphNode = serde_json::from_value(serde_json::json!({
        "id": "m", "type": "model3d", "x": 10., "y": 20., "width": 260., "height": 195.
    }))
    .unwrap();
    let model = ModelSnapshot {
        scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
        ops: vec![ModelOp::Box {
            id: "body".into(),
            parent: None,
            position: [0.0, 1.0, 0.0],
            rotation: [0.0; 3],
            scale: [1.0; 3],
            color: None,
            material: None,
            size: [2.0, 2.0, 2.0],
        }],
        signature: "sig".into(),
        extent: 2.0,
        aabb: None,
        geometry_keys: None,
        prepared_bounds: None,
        placement: ModelPlacement::default(),
    };
    let base = ModelPlacement::default();
    let with_z = ModelPlacement {
        offset: crate::protocol::ModelOffset {
            x: 0.0,
            y: 0.0,
            z: -7.0,
        },
        ..ModelPlacement::default()
    };
    let anchor = |placement: &ModelPlacement| {
        model_anchor(
            &node,
            &model,
            placement,
            model_unit(&node, &model, placement),
        )
    };
    assert_eq!(anchor(&base), anchor(&with_z));
}
