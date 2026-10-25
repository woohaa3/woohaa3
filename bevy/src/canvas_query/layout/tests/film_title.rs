//! 片场标题面板布局测试（自 `layout.rs` 内联测试拆出，控制单文件体积）。

use crate::canvas_query::layout::{
    FILM_TITLE_CHIP_PAD, FILM_TITLE_FONT, FILM_TITLE_GAP, FILM_TITLE_MIN_TEXT_WIDTH,
    FILM_TITLE_MIN_WIDTH, FILM_TITLE_TYPE_FONT, estimated_text_width, film_title_chip_height,
    film_title_layout,
};
use crate::protocol::GraphNode;

use super::node;

fn film_node(title: &str, scope: (f32, f32, f32, f32)) -> GraphNode {
    film_node_with_ground(title, scope, 40.0)
}

fn film_node_with_ground(title: &str, scope: (f32, f32, f32, f32), half: f32) -> GraphNode {
    let mut node = film_node_typed(title, scope, half);
    node.type_label = String::new();
    node
}

fn film_node_typed(title: &str, scope: (f32, f32, f32, f32), half: f32) -> GraphNode {
    let mut node = node(320.0, 200.0);
    node.title = title.into();
    node.composite_asset = Some(crate::protocol::CompositeAssetPresentation {
        panel: None,
        ownership_links: None,
        root_placement: None,
        content_extent: None,
        layout_aabb: None,
        empty_placeholder: None,
        geometry_quality: None,
        scope_shape: crate::protocol::CompositeAssetScopeShape::IsometricDiamond,
        scope_ground: Some(crate::protocol::ScopeGroundDto {
            cx: scope.0 + scope.2 / 2.0,
            cy: scope.1 + scope.3 / 2.0,
            hx: half,
            hz: half,
        }),
        x: scope.0,
        y: scope.1,
        width: scope.2,
        height: scope.3,
        media: Vec::new(),
        item_roots: std::collections::HashMap::new(),
        item_placements: std::collections::HashMap::new(),
    });
    node
}

#[test]
fn film_title_floats_above_scope_top_centered() {
    // 真实地面范围（hx=hz=120 → 菱形 AABB 340×170）；带业务类型名。
    let mut node = film_node_with_ground("片场 A", (100.0, 50.0, 400.0, 300.0), 120.0);
    node.type_label = "片场".into();
    let scope = crate::canvas_query::scope::node_scope(&node);
    let layout = film_title_layout(&node);
    let (chip_x, chip_y, chip_w, chip_h) = layout.chip;
    assert_eq!(layout.title, "片场 A");
    assert_eq!(layout.type_label, "片场");
    // 面板整体浮在范围顶部之上（含间隙），不侵占范围内部。
    assert!(chip_y + chip_h <= scope.aabb.y, "面板底边应在范围顶部之上");
    assert!((scope.aabb.y - (chip_y + chip_h) - FILM_TITLE_GAP).abs() < 1e-3);
    // 水平居中于范围中心。
    let chip_center_x = chip_x + chip_w / 2.0;
    assert!((chip_center_x - (scope.aabb.x + scope.aabb.width / 2.0)).abs() < 1e-3);
    // 两行都在面板内，且类型名在标题下方。
    assert_eq!(layout.title_pos.x, chip_x + FILM_TITLE_CHIP_PAD);
    assert!(layout.title_pos.y >= chip_y);
    assert!(layout.title_pos.y + FILM_TITLE_FONT <= chip_y + chip_h);
    assert!(layout.type_pos.y > layout.title_pos.y + FILM_TITLE_FONT);
    assert!(layout.type_pos.y + FILM_TITLE_TYPE_FONT <= chip_y + chip_h + 1e-3);
}

#[test]
fn film_title_without_business_type_is_single_line() {
    let node = film_node_with_ground("片场 A", (100.0, 50.0, 400.0, 300.0), 120.0);
    let layout = film_title_layout(&node);
    assert!(layout.type_label.is_empty());
    assert_eq!(layout.chip.3, film_title_chip_height(false));
}

#[test]
fn film_title_floats_above_scope_top_and_truncates() {
    let long = "非常长的中文片场名称".repeat(8);
    let node = film_node_with_ground(&long, (0.0, 0.0, 200.0, 150.0), 90.0);
    let scope = crate::canvas_query::scope::node_scope(&node);
    let layout = film_title_layout(&node);
    assert!(layout.title.ends_with('…'));
    assert!(layout.title.chars().count() >= 2);
    // 面板浮在范围顶部之上；文案保留可读下限，允许面板宽于很小的地面范围。
    assert!(layout.chip.1 + layout.chip.3 <= scope.aabb.y);
    assert!(
        layout.chip.2
            <= scope
                .aabb
                .width
                .max(FILM_TITLE_MIN_TEXT_WIDTH + FILM_TITLE_CHIP_PAD * 2.0)
                + 1e-3
    );
}

#[test]
fn film_title_keeps_readable_width_on_narrow_scope() {
    // 小地面、较高的片场：范围远窄于标题，标题仍必须可读而不是只剩省略号。
    let node = film_node_with_ground("非常长的中文片场名称", (0.0, 0.0, 64.0, 64.0), 32.0);
    let scope = crate::canvas_query::scope::node_scope(&node);
    let layout = film_title_layout(&node);
    assert!(scope.aabb.width < FILM_TITLE_MIN_TEXT_WIDTH);
    assert!(
        layout.title.chars().count() >= 6,
        "极小范围也应显示足够字符：{}",
        layout.title
    );
    assert!(layout.chip.2 >= FILM_TITLE_MIN_TEXT_WIDTH);
    assert!(layout.chip.2 > scope.aabb.width);
    // 文案仍完整落在面板底衬内。
    assert!(
        layout.chip.2 + 1e-3
            >= estimated_text_width(&layout.title, FILM_TITLE_FONT) + FILM_TITLE_CHIP_PAD * 2.0
    );
}

#[test]
fn film_title_floats_above_tall_content_bounds() {
    let mut node = film_node_with_ground("高塔", (0.0, 0.0, 160.0, 400.0), 12.0);
    let asset = node.composite_asset.as_mut().unwrap();
    asset.content_extent = Some(2.0);
    asset.root_placement = Some(crate::protocol::ModelPlacement {
        offset: crate::protocol::ModelOffset::default(),
        scale: 1.0,
        yaw: 0.0,
    });
    asset.layout_aabb = Some(crate::protocol::ModelAabbDto {
        min: [-8.0, 0.0, -8.0],
        max: [8.0, 40.0, 8.0],
    });
    let scope = crate::canvas_query::scope::node_scope(&node);
    let content = scope.content.expect("tall model content bounds");
    // 模型内容顶部高于地面范围顶部：标题必须让到内容顶部之上。
    assert!(content.y < scope.aabb.y);
    let layout = film_title_layout(&node);
    let (chip_x, chip_y, chip_w, chip_h) = layout.chip;
    let anchor_top = scope.aabb.y.min(content.y);
    assert!((anchor_top - (chip_y + chip_h) - FILM_TITLE_GAP).abs() < 1e-3);
    // 水平居中于模型内容包围盒，而不是地面范围。
    assert!((chip_x + chip_w / 2.0 - (content.x + content.width / 2.0)).abs() < 1e-3);
}

#[test]
fn film_title_accepts_empty_name_without_panic() {
    let node = film_node("", (0.0, 0.0, 64.0, 64.0));
    let layout = film_title_layout(&node);
    assert_eq!(layout.title, "");
    assert!(layout.chip.2 >= FILM_TITLE_MIN_WIDTH);
    assert!(layout.chip.0.is_finite());
}
