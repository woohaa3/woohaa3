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
fn group_running_uses_solid_stroke_and_keeps_bubble_tail_joins() {
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

    // 尖角气泡：虚线路径从左右尾接点出发，且不画横跨气泡尾部的闭合边。
    let node = &world.resource::<CurrentScene>().0.nodes[2];
    let frame = crate::canvas_query::group_model::frame_path(node);
    let tail = crate::canvas_query::group_model::tail_path(node);
    assert!(frame.len() > 4, "带模型徽标的 group 必须有尖角尾部路径");
    assert!(tail.len() == 3, "带模型徽标的 group 必须有尾巴三角形");
    // `frame_path` 从右尾接点起笔，先画两条斜边再绕回主体；任一侧接点都必须落在描边上。
    assert!(
        [tail[0], tail[2]]
            .into_iter()
            .any(|join| idle.iter().any(|point| point.distance(join) < 1.6)),
        "选中描边必须从气泡尾接点开始：{:?}",
        [tail[0], tail[2]]
    );
    let midpoint = Vec2::new((tail[0].x + tail[2].x) / 2.0, tail[0].y);
    assert!(
        !idle.iter().any(|point| point.distance(midpoint) < 2.0),
        "气泡尾部开口不得被选中虚线闭合：{midpoint:?}"
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
