//! Card / Group / FilmSet 持久选中描边的 ECS 回归
//! （change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs，任务 3.2）。
//!
//! 三个 producer 共享 `SelectionOutlineBatch` 与 flush，但各自拥有形状规则。这里断言：
//! 非选中态不产生几何、resize 抓手只在可缩放节点出现、运行中 group 用实线而非虚线、
//! group 尖角气泡路径的尾接点仍在描边里、hover/drop-target 不会伪造选中描边，以及多种类型
//! 同时选中时几何是逐类结果的拼接（互不覆盖）。
use super::*;
use crate::protocol::Scene;
use bevy::mesh::VertexAttributeValues;

fn nodes() -> Vec<crate::protocol::GraphNode> {
    serde_json::from_value(serde_json::json!([
        {"id":"card", "type":"text", "x":0, "y":0, "width":240, "height":180,
         "resizable":true, "title":"Card", "body":"body"},
        {"id":"plain", "type":"text", "x":300, "y":0, "width":240, "height":180,
         "title":"Plain", "body":"body"},
        {"id":"group", "type":"group", "x":600, "y":0, "width":220, "height":160,
         "resizable":true, "model":{"resourceKey":"missing:group"},
         "group":{"title":"Group", "memberCount":2}},
        {"id":"group-running", "type":"group", "x":900, "y":0, "width":220, "height":160,
         "resizable":true, "model":{"resourceKey":"missing:running"},
         "group":{"title":"Running", "memberCount":2,
                  "runStatus":{"label":"生成中", "state":"running"}}},
        {"id":"film", "type":"model", "x":1200, "y":0, "width":220, "height":170,
         "resizable":true,
         "compositeAsset":{"x":1200, "y":0, "width":220, "height":170}}
    ]))
    .unwrap()
}

fn selection_world() -> World {
    let mut world = world();
    world.resource_mut::<CurrentScene>().0 = Scene {
        nodes: nodes(),
        ..default()
    };
    world
}

fn select(world: &mut World, ids: &[&str]) {
    world.resource_mut::<CurrentScene>().0.selection.nodes =
        ids.iter().map(|id| (*id).to_owned()).collect();
}

fn outline(world: &World) -> Vec<Vec2> {
    let Some(handle) = world.resource::<SelectionOutlineLayer>().mesh().cloned() else {
        return Vec::new();
    };
    let Some(mesh) = world.resource::<Assets<Mesh>>().get(&handle) else {
        return Vec::new();
    };
    match mesh.attribute(Mesh::ATTRIBUTE_POSITION) {
        Some(VertexAttributeValues::Float32x3(values)) => values
            .iter()
            // 空批次用远离画布的兜底三角形清空上一帧；它不是节点几何。
            .filter(|point| point[0] > -100_000.0)
            .map(|point| Vec2::new(point[0], -point[1]))
            .collect(),
        _ => Vec::new(),
    }
}

fn draw(world: &mut World, ids: &[&str]) -> Vec<Vec2> {
    select(world, ids);
    render(world);
    outline(world)
}

#[test]
fn unselected_nodes_contribute_nothing_and_hover_never_fakes_selection() {
    let mut world = selection_world();
    assert!(draw(&mut world, &[]).is_empty(), "无选中时批次为空");

    // hover / drop-target 是瞬时状态，不产生持久选中描边。
    world.resource_mut::<CurrentScene>().0.hover =
        Some(serde_json::from_value(serde_json::json!({"nodeId":"plain"})).unwrap());
    world.resource_mut::<CurrentScene>().0.nodes[3]
        .group
        .as_mut()
        .unwrap()
        .drop_target = true;
    render(&mut world);
    assert!(
        outline(&world).is_empty(),
        "hover/drop-target 不得写入选区批次"
    );
}

#[test]
fn card_outline_is_present_and_resize_grip_depends_on_resizable() {
    let mut world = selection_world();
    let plain = draw(&mut world, &["plain"]);
    assert!(!plain.is_empty(), "普通卡片选中必须产生描边");
    let resizable = draw(&mut world, &["card"]);
    assert!(!resizable.is_empty());
    assert!(
        resizable.len() > plain.len(),
        "可缩放卡片多出 resize 抓手：{} vs {}",
        resizable.len(),
        plain.len()
    );
}

#[test]
fn group_running_uses_solid_stroke_on_the_closed_structural_frame() {
    let mut world = selection_world();
    let idle = draw(&mut world, &["group"]);
    assert!(!idle.is_empty(), "group 选中必须产生描边");
    let running = draw(&mut world, &["group-running"]);
    assert!(!running.is_empty(), "运行中 group 选中必须产生描边");
    assert_ne!(
        idle.len(),
        running.len(),
        "运行中应切换为实线描边，而不是复用虚线几何"
    );

    // 组框是闭合圆角矩形：不再有气泡尖尾、开口或徽标描边。
    let node = world
        .resource::<CurrentScene>()
        .0
        .nodes
        .iter()
        .find(|node| node.id == "group")
        .expect("group fixture");
    let frame = crate::canvas_query::group_model::frame_path(node);
    assert!(frame.len() > 4, "组框是采样圆角矩形");
    assert_eq!(
        frame.first().copied(),
        frame.last().copied(),
        "组框路径必须闭合"
    );
    let bottom = node.y + node.height;
    assert!(
        frame.iter().any(|point| (point.y - bottom).abs() < 1.0
            && point.x >= node.x
            && point.x <= node.x + node.width),
        "闭合描边必须经过结构底边"
    );
    assert!(
        idle.iter().all(|point| point.y <= bottom + 8.),
        "徽标不再向下撑开组框描边（四角抓手的圆点可略超出角点）：{idle:?}"
    );
    let start = frame[0];
    assert!(
        idle.iter().any(|point| point.distance(start) < 1.6),
        "选中描边必须覆盖闭合路径起点：{start:?}"
    );
}

#[test]
fn film_set_scope_outline_is_produced_and_cleared() {
    let mut world = selection_world();
    let film = draw(&mut world, &["film"]);
    assert!(!film.is_empty(), "片场选中必须产生范围框/抓手");
    assert!(draw(&mut world, &[]).is_empty(), "取消选中后同批次必须清空");
}

#[test]
fn mixed_selection_concatenates_each_type_without_overwriting() {
    let mut world = selection_world();
    let card = draw(&mut world, &["card"]).len();
    let group = draw(&mut world, &["group"]).len();
    let film = draw(&mut world, &["film"]).len();
    let mixed = draw(&mut world, &["card", "group", "film"]);
    assert_eq!(
        mixed.len(),
        card + group + film,
        "三个 producer 必须向同一批次追加，而不是互相覆盖"
    );
}

#[test]
fn scene_group_selection_highlights_only_four_badge_bottom_edges() {
    let mut world = world();
    let mut node: crate::protocol::GraphNode = serde_json::from_value(serde_json::json!({
        "id":"scene", "type":"group", "x":50, "y":30, "width":400, "height":200,
        "model":{"resourceKey":"scene:model"},
        "group":{"badgeTopAnchor":true,
            "modelBounds":{"aabb":{"min":[-2,0,-1],"max":[2,3,1]},"extent":4}}
    }))
    .unwrap();
    let theme = ThemeResource::default();
    let mut normal = crate::canvas2d::geometry::Geometry::default();
    crate::canvas2d::group::draw_group(
        &mut normal,
        &theme,
        &node,
        node.group.as_ref().unwrap(),
        false,
        1.,
    );
    let (normal_frame, bottom) = normal.into_layers();
    assert_eq!(bottom.count_vertices(), 16);
    let Some(VertexAttributeValues::Float32x4(colors)) = bottom.attribute(Mesh::ATTRIBUTE_COLOR)
    else {
        panic!("floor outline must carry its pale alpha");
    };
    assert!(colors.iter().all(|rgba| (rgba[3] - 0.55).abs() < 0.001));
    let mut selected = crate::canvas2d::geometry::Geometry::default();
    crate::canvas2d::group::draw_group(
        &mut selected,
        &theme,
        &node,
        node.group.as_ref().unwrap(),
        true,
        1.,
    );
    let (selected_frame, selected_bottom) = selected.into_layers();
    assert_eq!(
        selected_bottom.count_vertices(), 3,
        "selection producer owns the bright floor outline"
    );
    assert_eq!(
        normal_frame.attribute(Mesh::ATTRIBUTE_POSITION),
        selected_frame.attribute(Mesh::ATTRIBUTE_POSITION),
        "selection keeps the normal group frame"
    );
    for collapsed in [false, true] {
        node.group.as_mut().unwrap().collapsed = collapsed;
        world.resource_mut::<CurrentScene>().0 = Scene {
            nodes: vec![node.clone()],
            ..default()
        };
        assert!(draw(&mut world, &[]).is_empty());
        let selected = draw(&mut world, &["scene"]);
        assert_eq!(
            selected.len(),
            16,
            "four solid edges, no highlighted group frame"
        );
        assert!(selected.iter().all(|p| p.y > node.y + node.height));
        assert!(
            draw(&mut world, &[]).is_empty(),
            "deselection clears the highlight"
        );
    }
    // Ordinary groups keep their structural selection, including before model readiness.
    node.group.as_mut().unwrap().collapsed = false;
    node.group.as_mut().unwrap().badge_top_anchor = false;
    world.resource_mut::<CurrentScene>().0.nodes = vec![node];
    assert!(draw(&mut world, &["scene"]).iter().any(|p| p.y < 231.));
}
